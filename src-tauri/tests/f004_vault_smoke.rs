//! F-004 真机冒烟（**默认忽略**，需人工/受控环境执行）：
//!
//! ```text
//! cd QMAI/src-tauri && cargo test --test f004_vault_smoke -- --ignored --nocapture
//! ```
//!
//! 与 `src/credential_vault.rs` 内联单测的区别：内联单测注入 `__set_test_backend`（内存替身），
//! 本文件**刻意不注入**，因此走真实 OS 凭据后端。它会：
//!   1. 真实写入一条 `niko-buddy:<key>` 到 Windows 凭据管理器（service `com.nikobuddy.app`）；
//!   2. 用 `cmdkey /list` 从**系统侧**确认条目存在（不是自证）；
//!   3. 读回比对；
//!   4. 删除后再用 `cmdkey /list` 确认条目消失（保证不残留）。
//!
//! 之所以 `#[ignore]`：本用例依赖真实机器的凭据库，CI/无头环境不保证可用；
//! 缺失时应显式跳过，而不是把「环境不具备」伪装成通过。

#![cfg(windows)]

use std::process::Command;

fn cmdkey_list() -> String {
    let out = Command::new("cmdkey")
        .arg("/list")
        .output()
        .expect("cmdkey 应可用（Windows 自带）");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    text
}

fn count_account(listing: &str, account: &str) -> usize {
    listing.matches(account).count()
}

#[test]
#[ignore = "真机冒烟：写真实 Windows 凭据管理器，需 --ignored 显式执行"]
fn real_windows_credential_manager_roundtrip() {
    use niko_buddy_lib::credential_vault as vault;

    let key = "smoke:f004:roundtrip";
    let secret = "smoke-secret-4571";
    let account = vault::account_for(key).expect("账号名应由 key 派生");
    assert!(
        account.starts_with(vault::VAULT_ACCOUNT_PREFIX),
        "账号必须带命名空间前缀，实际 {account}"
    );

    println!("[1] key={key} account={account} service={}", vault::VAULT_SERVICE);

    // 前置清理：确保从确定状态开始。
    let _ = vault::vault_delete_secret(key.to_string());
    assert_eq!(
        count_account(&cmdkey_list(), &account),
        0,
        "前置清理后系统侧不应残留 {account}"
    );

    // [2] 真实写入。
    let stored = vault::vault_put_secret(key.to_string(), secret.to_string()).expect("真实写入应成功");
    println!("[2] put -> {stored}");
    // 契约：返回 credential_ref = `<service>:<key>`（不含账号前缀、绝不含明文）。
    assert_eq!(
        stored,
        format!("{}:{key}", vault::VAULT_SERVICE),
        "put 应返回 credential_ref = <service>:<key>"
    );
    assert!(!stored.contains(secret), "credential_ref 绝不能含明文");

    // [3] 系统侧确认（cmdkey，不是自证）。
    let after_put = cmdkey_list();
    let hits = count_account(&after_put, &account);
    println!("[3] cmdkey /list 命中 {account} 次数 = {hits}");
    assert!(hits >= 1, "系统凭据管理器里应能看到 {account}；cmdkey 输出：\n{after_put}");
    println!(
        "[3] cmdkey 行: {}",
        after_put
            .lines()
            .find(|l| l.contains(&account))
            .unwrap_or("<未找到匹配行>")
            .trim()
    );

    // [4] 读回比对 + has 判定。
    let back = vault::vault_get_secret(key.to_string()).expect("真实读取应成功");
    println!("[4] get -> {back:?}");
    assert_eq!(back.as_deref(), Some(secret), "读回值必须与写入值一致");
    assert!(vault::vault_has_secret(key.to_string()).expect("has 应成功"));

    // [5] 删除 + 系统侧确认消失（不留残留）。
    let deleted = vault::vault_delete_secret(key.to_string()).expect("真实删除应成功");
    assert!(deleted, "首次删除应报告 true（条目此前存在）");
    let after_delete = cmdkey_list();
    let hits_after = count_account(&after_delete, &account);
    println!("[5] delete 后 cmdkey 命中次数 = {hits_after}");
    assert_eq!(hits_after, 0, "删除后系统侧不应残留 {account}；cmdkey 输出：\n{after_delete}");
    assert_eq!(
        vault::vault_get_secret(key.to_string()).expect("删除后读取仍应成功"),
        None,
        "删除后读回应为 None"
    );

    // [6] 二次删除应报 false（幂等语义，不伪造成功）。
    assert!(
        !vault::vault_delete_secret(key.to_string()).expect("幂等删除应成功"),
        "不存在的条目删除应报 false"
    );

    println!("[6] F-004 真机冒烟 PASS：真实凭据管理器 写/列/读/删 全链一致，无残留");
}

#[test]
#[ignore = "真机冒烟：验证凭据不入项目数据区（需要真实后端）"]
fn secret_is_not_written_into_project_data_sections() {
    use niko_buddy_lib::credential_vault as vault;

    // 与内联单测的同类断言，但这里走真实后端：写入后项目数据区不得出现明文。
    let key = "smoke:f004:isolation";
    let secret = "isolation-probe-9902";
    let _ = vault::vault_delete_secret(key.to_string());
    vault::vault_put_secret(key.to_string(), secret.to_string()).expect("真实写入应成功");

    let roots = [".novel", "QM", ".qmai", "backups"];
    let mut scanned = 0usize;
    let mut found: Vec<String> = Vec::new();
    for root in roots {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(root);
        if !dir.is_dir() {
            continue;
        }
        for entry in walk(&dir, 0) {
            if let Ok(text) = std::fs::read_to_string(&entry) {
                scanned += 1;
                if text.contains(secret) {
                    found.push(entry.display().to_string());
                }
            }
        }
    }
    println!("[isolation] 扫描 {scanned} 个文本文件，命中明文 {found:?}");
    assert!(found.is_empty(), "凭据明文出现在项目数据区：{found:?}");

    let _ = vault::vault_delete_secret(key.to_string());
}

fn walk(dir: &std::path::Path, depth: usize) -> Vec<std::path::PathBuf> {
    if depth > 6 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path, depth + 1));
        } else {
            out.push(path);
        }
    }
    out
}
