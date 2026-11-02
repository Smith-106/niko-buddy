# 20261102 同步冲突三路语义（sync-conflict-semantics）

> 范围：G2b「批次明细 + 双改逐项 pick-and-apply（含 base 语义）」。
> 代码面：`src-tauri/src/commands/sync_target_decision.rs`（决策纯支撑层）、
> `src-tauri/src/commands/sync_target.rs`（传输编排层）、
> `src/components/backup/CloudBackupPanel.tsx`（批次记录区）、`src/commands/sync.ts`（IPC 类型面）、
> `src/i18n/{zh,en}.json`（`sync.batch.*` / `sync.resolve.*`）。
> 引用纪律：只用**符号引用**（函数 / 常量 / 字段名），不写行号（行号随实现漂移会让复核空转）。

## 一、决策条目

| date | task_id | decision_type | value | evidence_ref |
|------|---------|---------------|-------|--------------|
| 2026-11-02 | G2b-1 | 裁决人 | **三侧定义**：`mine` = 本地当前态（`local_state` 读出的单调版本 + 内容指纹）；`theirs` = 远端该版本副本（冲突批次落成的 `.novel/.conflict-<device>-<ts>`）；`base` = 该版本所基于的上一同步态（`base_state_before`：同 `manifest_id`、`direction != "conflict"`、`revision < 当前版本` 中最大者）。三者皆**非真值**，只是判定「谁改了什么」的参照。展开入口：`decide_pull_items`（只对 `PullDecision::KeepBoth` 展开，`Apply` / `RefuseStale` 返回空清单） | `sync_target_decision.rs` `decide_pull_items` / `base_state_before` / `local_state` / `diff_item` |
| 2026-11-02 | G2b-2 | 手设参数 | **base 指针落在传输 journal 行**（`SyncJournalEntry.base_rev` + `SyncJournalEntry.base_content_hash`，均 `Option`），不写进 `canon/archive.rs` 的 `ArchiveManifest`：归档格式是内容寻址契约（`ARCHIVE_SCHEMA_VERSION`），加字段属另一任务面；而「本次传输基于哪个上一态」本就是 journal（过程库）语义。`push_staged` 成功后回填；`pull_verified` 三个分支同样回填 | `sync_target.rs` `push_staged` / `pull_verified`；`sync_target_decision.rs` `SyncJournalEntry` |
| 2026-11-02 | G2b-3 | 裁决人 | **老批次不迁移、不重写**：`base_rev` / `base_content_hash` 缺失（旧 journal 行）即视为**无 base**，`base_available = false`。历史批次保持原样，绝不因新增字段而回写（`append`-only journal 不可变） | `SyncJournalEntry` 字段 `#[serde(default)]`；`batches_impl` 的 `base_available` 判定 |
| 2026-11-02 | G2b-4 | 裁决人 | **无 base 禁覆盖规则**：`base_available == false`（或三侧不齐）时，逐项清单项的 `choices` 只含 `keep_both`、`pickable = false`，UI 置灰并给出 `sync.batch.noBase` 文案；后端 `apply_item_decisions_impl` 对 `pick_mine` / `pick_theirs` **直接记 `error`**（即使 UI 被绕过也不落地）。理由：没有共同祖先就无从判断「谁的新改动」，任何自动选择都会变成隐式覆盖（R2） | `sync_target_decision.rs` `PickChoice::allowed_without_base` / `apply_single_item`；`CloudBackupPanel.tsx` 批次记录区 |
| 2026-11-02 | G2b-5 | 裁决人 | **`keep_both` 是底线而非选项之一**：① 每个清单项的 `default_decision` 恒为 `keep_both`；② 未知裁决字面量 `PickChoice::parse_lenient` 回落 `keep_both`；③ 缺侧（`mine` / `theirs` 目录不可得）时 `diff_trees` 一律把项降级为不可选；④ 冲突副本的默认裁决 `SyncConflict::default_resolution` 保持 `keep_both`（本次未改动）。四处出口同向 → 任何路径都不会升级成覆盖 | `PickChoice::parse_lenient` / `diff_trees` / `SyncDiffItem::default_decision` / `SyncConflict` |
| 2026-11-02 | G2b-6 | 裁决人 | **逐项选择必须显式**：`apply_item_decisions_impl` 在 `actor` 为空时**整次拒绝**（`no silent auto-pick`）；每次裁决回写 `decision` / `actor` / `decided_at` / `status` / `duration_ms` / `error` 到逐项 journal。UI 不预填覆盖值（草稿缺省 = `keep_both`），选择器变更即用户显式动作 | `apply_item_decisions_impl`；`CloudBackupPanel.tsx` `pickDrafts` / `applyPicks` |
| 2026-11-02 | G2b-7 | 手设参数 | **单项失败不滚整体**：一次调用可带多项，每项独立落盘 + 独立记账；失败项 `status = error` 且 `error` 落账，其余项继续，失败项可原样重试（幂等：`keep_both` 无落盘，`pick_*` 覆盖写同一目标路径） | `apply_item_decisions_impl` / `SyncItemDecisionResult` |
| 2026-11-02 | G2b-8 | 裁决人 | **落盘不碰工作文件树**：裁决结果写 `.novel/resolutions/<batch_id>/<相对路径>`，并经写入权威判定 `assert_local_target_allowed`（`WriteSource::SyncPull` 只接受 `Allow`）。远端副本永非真值（INV-3），`pick_*` 也不直接改用户正文 | `apply_single_item`；`canon/write_authority.rs` `may_write` |
| 2026-11-02 | G2b-9 | 手设参数 | **逐项 journal 与传输 journal 分文件**：`SYNC_ITEM_JOURNAL_FILE` = `.novel/sync-item-journal.jsonl`。若混写进 `SYNC_JOURNAL_FILE`，`local_state` / `local_revision` 的单调版本水位会被逐项行污染（判新旧只能靠传输记录），故物理分离；两者以 `batch_id = <manifest_id>@<ts>` 关联 | `sync_target.rs` `SYNC_ITEM_JOURNAL_FILE`；`sync_target_decision.rs` `batch_id_of` / `append_item_journal` |
| 2026-11-02 | G2b-10 | 统计口径 | **三路状态码**（稳定字面量，UI 经 `sync.batch.diff.*` 映射）：`unchanged`（三侧一致）/ `mine_only` / `theirs_only` / `both_same`（两侧都变但内容相同，伪冲突）/ `both_changed`（**双改**，唯一可三选一的形态）/ `no_base`（无 base 或缺侧）。比较用内容 sha256（复用 `canon::archive::block_hash`），不读时间戳 | `DIFF_*` 常量；`diff_item` |
| 2026-11-02 | G2b-11 | 手设参数 | **路径守卫**：逐项路径必须相对、无 `..`、无反斜杠/盘符、无空段（`assert_safe_relative_path`）；`batch_id` 落目录名前经 `sanitize_batch_token` 只留 ASCII 字母数字与 `-` `_`。防止裁决把内容写到项目外 | `assert_safe_relative_path` / `sanitize_batch_token` |
| 2026-11-02 | G2b-12 | 统计口径 | **批次明细口径**：批次 = 一条传输 journal 行（`manifest_id` + `revision` + `direction` + `ts` + `device_id`），`items` = 该批次的逐项记录（push：产物文件；pull/conflict：`manifest.json` + `blocks/<hash>`），冲突批次再用 `diff_trees` 合并三路状态。`transport-health` 行不是批次，不进明细。默认回看 20 批（`BATCH_DETAIL_LIMIT`） | `batches_impl` / `record_pull_items` / `BATCH_DETAIL_LIMIT` |

## 二、语义总表（三路合并）

| 形态 | 判定 | 可逐项选择 | 默认裁决 | 落盘 |
|------|------|------------|----------|------|
| `unchanged` | `mine == theirs == base` | 否 | `keep_both` | 无动作 |
| `mine_only` | `mine != base`，`theirs == base` | 否 | `keep_both` | 无动作 |
| `theirs_only` | `theirs != base`，`mine == base` | 否 | `keep_both` | 无动作 |
| `both_same` | `mine == theirs != base` | 否 | `keep_both` | 无动作 |
| `both_changed` | `mine != base` 且 `theirs != base` 且 `mine != theirs` | **是**（`pick_mine` / `pick_theirs` / `keep_both`） | `keep_both` | `pick_*` → `.novel/resolutions/<batch>/<path>` |
| `no_base` | 无 base 指针，或 `mine` / `theirs` 侧不可得 | 否（UI 置灰） | `keep_both` | 无动作 |

## 三、不变量（改动前先读）

1. **默认裁决恒为 `keep_both`**：不存在「默认覆盖」的代码路径；`SyncConflict::default_resolution` 未改动。
2. **无 base 不覆盖**：`base_available == false` 时后端硬拒 `pick_mine` / `pick_theirs`（不是仅 UI 置灰）。
3. **逐项选择必须显式**：空 `actor` 整次拒绝；journal 必须留下 `decision` + `actor` + `decided_at`。
4. **单项失败不滚整体**：失败项 `error` 可重试，其余项结果保留。
5. **远端副本永非真值**：裁决落 `.novel/resolutions/`，不写工作文件树、不写 `QM/` / `canon` / `.novel/status.json`。
6. **历史批次不迁移、不重写**：journal append-only；缺 base 字段的老行永远按「无 base」处理。
7. **既有传输零回归**：WebDAV / GitHub / 本地文件夹三路的推送、拉取、冲突、journal 语义不变；新增字段与新增命令均为**增量**。

## 四、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20261102-01 | `mine` 侧的落盘位置目前只能从 `.novel/snapshots/remote-<id>-rev-<n>` 推导：若本地该版本来自**推送**（本地无同名快照），`mine_root = None` → 冲突批次整体降级为「无 base 可选项」，逐项三选一在该场景不可用（仍可保留两者，不丢数据）。根因：传输对象是单一导出产物文件，本地未按版本留存「我方副本」 | 传输层记录本次推送的本地产物路径（journal 增加 `artifact_path`），或按版本留存本地快照 | 下一次同步能力波次（G2c 收口前） |
| DEBT-20261102-02 | `blocks/<hash>` 级逐项记录只带状态与批次总耗时（单块耗时记 0），因为拉取循环未逐块计时。批次总耗时可由 UI 汇总，块级耗时不可用 | 拉取循环逐块计时并写入 `SyncItemRecord::duration_ms` | 有性能诊断需求时（暂不阻塞） |
