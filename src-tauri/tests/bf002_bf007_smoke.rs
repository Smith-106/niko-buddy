//! B-F-002（快照时间机器原子恢复）与 B-F-007（事务式批量替换）真机冒烟（**默认忽略**）。
//!
//! ```text
//! cd QMAI/src-tauri
//! cargo test --test bf002_bf007_smoke -- --ignored --nocapture
//! ```
//!
//! 本文件的定位（真实链路层，补内联单测的空白）：
//!
//! - B-F-007：内联单测把「门」注入成替身（`allow_all`），因此**从未验证过注册命令
//!   `api::batch_replace_apply` + 真实 `agent_gate` 的交互**。本文件走真命令、真门、
//!   真确认（从错误串里取 `request_id` → 人工 `Allowed` → 重试），并验证未确认时
//!   整批零副作用。
//! - B-F-002：`restoreSnapshot` 的门主体是 **User**，目标又是受保护区
//!   （`.novel/status.json`）。这正是本轮修门（非破坏性写入受保护区必须人工确认）
//!   最容易误伤的路径，故用真实项目目录做恢复 + 回滚两向验证。

use niko_buddy_lib::agent_gate::{self, Decision};
use niko_buddy_lib::batch_replace::{self, ApplyReport, ReplaceRule};
use niko_buddy_lib::snapshot_timemachine::snapshot;
use std::path::{Path, PathBuf};

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("nb-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("mkdir temp root");
    root
}

fn write(root: &Path, rel: &str, body: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir parent");
    }
    std::fs::write(path, body).expect("write");
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).expect("read")
}

/// 递归找残留的原子写临时/备份文件。
fn residue(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".tmp") || name.ends_with(".bak") {
                out.push(path.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out
}

// ── B-F-007 ────────────────────────────────────────────────────────────────

/// 从门拒绝错误串里取 `request_id`（UI 也是这么做的：错误串是门的唯一出口）。
fn request_id_from(error: &str) -> String {
    let after = error
        .split("GATE_REQUIRE_CONFIRM:")
        .nth(1)
        .unwrap_or_else(|| panic!("错误串里没有确认请求：{error}"));
    after.split(':').next().expect("request id").to_string()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "真机冒烟：走注册命令 + 真实确认门 + 真实文件事务"]
async fn bf007_batch_replace_through_registered_command_with_real_gate() {
    let root = temp_root("bf007");
    write(&root, "book/c1.md", "林舟推开门。\n林舟看着窗外。\n");
    write(&root, "book/c2.md", "夜色里，林舟笑了。\n");
    // 不在 files 名单内的文件：整批事务不得碰它。
    write(&root, "book/untouched.md", "林舟不该被改。\n");
    let project_path = root.to_string_lossy().to_string();
    let files = vec!["book/c1.md".to_string(), "book/c2.md".to_string()];
    let rule = ReplaceRule {
        find: "林舟".to_string(),
        replace: "沈舟".to_string(),
        case_sensitive: true,
    };

    // [1] 预览（注册命令）：只读、不改盘、不建草稿。
    let diffs = batch_replace::api::batch_replace_preview(
        project_path.clone(),
        files.clone(),
        rule.clone(),
    )
    .await
    .expect("预览应成功");
    let changed: Vec<&batch_replace::FileDiff> =
        diffs.iter().filter(|d| !d.is_unchanged()).collect();
    println!("[1] 预览命中文件 {} 个，总替换 {}", changed.len(), diffs.iter().map(|d| d.replacements).sum::<u32>());
    assert_eq!(changed.len(), 2);
    assert_eq!(changed.iter().map(|d| d.replacements).sum::<u32>(), 3);
    assert!(read(&root, "book/c1.md").contains("林舟"), "预览不得改盘");
    assert!(!root.join(batch_replace::DRAFTS_ROOT).exists(), "预览不得建草稿目录");

    // [2] 未确认直接提交：真实门必须拒绝，且整批零副作用。
    let denied = batch_replace::api::batch_replace_apply(
        project_path.clone(),
        files.clone(),
        rule.clone(),
    )
    .await
    .expect_err("未确认的批替换必须被门拒绝");
    println!("[2] 未确认 -> {denied}");
    assert!(denied.contains("GATE_REQUIRE_CONFIRM"), "应为确认请求而非其它错误：{denied}");
    assert!(read(&root, "book/c1.md").contains("林舟"), "被拒的批不得改盘");
    assert!(read(&root, "book/c2.md").contains("林舟"));
    assert!(!root.join(batch_replace::DRAFTS_ROOT).exists(), "被拒的批不得留草稿");

    // [3] 人工确认该请求（UI 的确认按钮等价动作），然后**逐个文件**确认并重试：
    //     门的强度是**逐目标**的，第一轮只会在第一个文件上产生请求。
    let mut confirmations = 0usize;
    let report: ApplyReport = loop {
        match batch_replace::api::batch_replace_apply(
            project_path.clone(),
            files.clone(),
            rule.clone(),
        )
        .await
        {
            Ok(report) => break report,
            Err(err) if err.contains("GATE_REQUIRE_CONFIRM") => {
                confirmations += 1;
                assert!(
                    confirmations <= files.len(),
                    "确认次数超过文件数（第 {confirmations} 次）：{err}"
                );
                let request_id = request_id_from(&err);
                let resolved =
                    agent_gate::resolve_impl(&request_id, Decision::Allowed, "冒烟：人工确认")
                        .expect("确认应被受理");
                println!(
                    "[3.{confirmations}] 确认 request_id={request_id} -> {:?}（继续重试整批）",
                    resolved.decision
                );
                assert!(resolved.may_proceed(), "确认后应放行");
            }
            Err(other) => panic!("非确认类失败，不应发生：{other}"),
        }
    };
    assert_eq!(
        confirmations,
        2,
        "应逐文件确认 2 次（且已授权的重试不得被熔断误伤）"
    );
    println!(
        "[4] 提交 applied={:?} drafts={} backup={} replacements={} projection_updated={} rollback={}",
        report.applied,
        report.drafts.len(),
        report.backup_root,
        report.total_replacements,
        report.projection_status_updated,
        report.rollback_performed
    );
    assert_eq!(report.applied.len(), 2);
    assert_eq!(report.total_replacements, 3);
    assert!(!report.rollback_performed);
    assert!(report.projection_status_updated, "提交后应刷新投影状态");
    assert!(!report.backup_root.is_empty(), "应留下备份根");
    assert!(read(&root, "book/c1.md").contains("沈舟"));
    assert!(!read(&root, "book/c1.md").contains("林舟"));
    assert!(read(&root, "book/c2.md").contains("沈舟"));
    assert!(
        read(&root, "book/untouched.md").contains("林舟"),
        "未列入的候选文件绝不能被整批事务牵连"
    );
    assert!(root.join(batch_replace::DRAFTS_ROOT).exists(), "提交应留草稿");
    assert!(
        root.join(batch_replace::PROJECTION_STATUS_FILE).is_file(),
        "投影状态文件应被刷新"
    );
    assert!(residue(&root).is_empty(), "不应留 .tmp/.bak：{:?}", residue(&root));

    // [5] 空 find 必须被拒（真实命令面也要挡住）。
    let empty = batch_replace::api::batch_replace_apply(
        project_path.clone(),
        files.clone(),
        ReplaceRule {
            find: String::new(),
            replace: "x".to_string(),
            case_sensitive: true,
        },
    )
    .await;
    assert!(empty.is_err(), "空 find 必须被拒");

    // [6] 受保护区在破坏性操作下硬拒（不可绕过），且不得改盘；路径穿越同样被拒。
    let protected_target = ".novel/status.json";
    write(&root, protected_target, "{\"chapter\":9}\n");
    let guarded = batch_replace::api::batch_replace_apply(
        project_path.clone(),
        vec![protected_target.to_string()],
        ReplaceRule {
            find: "9".to_string(),
            replace: "3".to_string(),
            case_sensitive: true,
        },
    )
    .await;
    let guard_err = guarded.expect_err("真源面必须被硬拒");
    println!("[6] 真源面 -> {guard_err}");
    assert!(
        guard_err.contains("not bypassable") || guard_err.contains("protected"),
        "应为受保护区硬拒：{guard_err}"
    );
    assert_eq!(read(&root, protected_target), "{\"chapter\":9}\n", "被拒的真源面不得被写");
    assert!(
        batch_replace::api::batch_replace_preview(
            project_path.clone(),
            vec!["../escape.md".to_string()],
            rule.clone()
        )
        .await
        .is_err(),
        "路径穿越必须被拒"
    );
    println!("[7] B-F-007 真机冒烟 PASS：注册命令 + 真门 + 确认 + 事务 + 投影刷新 + 隔离");
}

// ── B-F-002 ────────────────────────────────────────────────────────────────

const STATUS: &str = ".novel/status.json";

#[test]
#[ignore = "真机冒烟：真实项目目录上的原子恢复 + 回滚"]
fn bf002_snapshot_restore_real_project() {
    let root = temp_root("bf002");
    // 当前（已漂移）状态。
    write(&root, STATUS, "{\"chapter\":9,\"words\":9999}\n");
    write(&root, ".novel/entities.json", "{\"林舟\":\"已漂移\"}\n");
    // T1 快照：只含快照点时刻的真源状态。
    write(
        &root,
        ".novel/snapshots/t1/status.json",
        "{\"chapter\":3,\"words\":3000}\n",
    );
    write(
        &root,
        ".novel/snapshots/t1/entities.json",
        "{\"林舟\":\"T1\"}\n",
    );
    write(
        &root,
        ".novel/snapshots/t1/characters.json",
        "{\"沈舟\":\"T1\"}\n",
    );

    // [1] 链与预览（只读）。
    let chain = snapshot::snapshot_list_chain(&root, 0, 50);
    println!("[1] 快照链 {} 个点，total={}", chain.points.len(), chain.total);
    assert!(chain.points.iter().any(|p| p.id == "t1"));
    let preview = snapshot::snapshot_preview_point(&root, "t1");
    println!(
        "[2] 预览 status_diff={} world_state_diffs={}",
        preview.status_diff.len(),
        preview.world_state_diffs.len()
    );
    assert!(!preview.status_diff.is_empty(), "预览应显示状态差异");
    assert_eq!(read(&root, STATUS), "{\"chapter\":9,\"words\":9999}\n", "预览不得改盘");

    // [3] 无令牌 / 未知快照：必须被拒。
    assert!(
        snapshot::snapshot_restore_atomic(&root, "t1", "   ").is_err(),
        "空确认令牌必须被拒"
    );
    assert!(
        snapshot::snapshot_restore_atomic(&root, "not-a-snapshot", "ok").is_err(),
        "未知快照必须被拒"
    );

    // [4] 正常恢复：门主体是 User + 目标是受保护区（status.json）——本轮修门后必须仍放行。
    let outcome = snapshot::snapshot_restore_atomic(&root, "t1", "smoke-confirm")
        .expect("人工发起的恢复应成功");
    println!(
        "[4] 恢复 restored={:?} rolled_back={} gate={}",
        outcome.restored, outcome.rolled_back, outcome.gate_decision
    );
    assert!(!outcome.rolled_back);
    assert!(
        outcome.restored.iter().any(|p| p.contains("status.json")),
        "应恢复 status.json：{:?}",
        outcome.restored
    );
    assert!(outcome.verify.is_none(), "同步入口不做异步复验（命令层才有）");
    assert_eq!(read(&root, STATUS), "{\"chapter\":3,\"words\":3000}\n");
    assert_eq!(read(&root, ".novel/entities.json"), "{\"林舟\":\"T1\"}\n");
    assert_eq!(read(&root, ".novel/characters.json"), "{\"沈舟\":\"T1\"}\n");
    assert!(residue(&root).is_empty(), "恢复后不应留 .tmp/.bak：{:?}", residue(&root));

    // [5] 回滚路径：让第 2 个目标不可替换 → 已写文件必须逆序还原，且不留残留。
    let drifted = "{\"chapter\":9,\"words\":9999}\n";
    write(&root, STATUS, drifted);
    let projection = root.join(".novel/projection-status.json");
    write(&root, ".novel/projection-status.json", "{\"state\":\"drifted\"}\n");
    write(
        &root,
        ".novel/snapshots/t1/projection-status.json",
        "{\"state\":\"T1\"}\n",
    );
    let mut perms = std::fs::metadata(&projection).expect("meta").permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&projection, perms).expect("set readonly");
    let rolled = snapshot::snapshot_restore_atomic(&root, "t1", "smoke-confirm-2");
    println!("[5] 只读目标下的恢复 -> {:?}", rolled.as_ref().err());
    let mut perms = std::fs::metadata(&projection).expect("meta").permissions();
    perms.set_readonly(false);
    std::fs::set_permissions(&projection, perms).expect("restore perms");
    assert!(rolled.is_err(), "目标不可替换时恢复必须失败");
    assert_eq!(
        read(&root, STATUS),
        drifted,
        "失败必须逆序回滚，把已覆盖的真源还原为恢复前内容"
    );
    assert!(residue(&root).is_empty(), "回滚后不应留 .tmp/.bak：{:?}", residue(&root));

    let _ = std::fs::remove_dir_all(&root);
    println!("[6] B-F-002 真机冒烟 PASS：预览只读 / 拒绝非法请求 / 原子恢复 / 失败逆序回滚");
}
