// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 数据面 IPC 命令（T13，蓝图 §4 接口终版 / TASK-P1-08）。
//!
//! ## 三 IPC 命令（蓝图 §4 + §3 定稿）
//!   - `canon_query`：按 [`CanonEdgeFilter`]（含 `known_by?` / `valid_at_chapter?`
//!     认知轴 + 时态过滤）查询边。
//!   - `canon_ingest_episode`：幂等摄取 episode（写路径，触发 revision 自增）。
//!   - `canon_supersede_edges`：批量 supersede（旧边封顶 + 新边插入，写路径，
//!     触发 revision 自增）。
//!
//! ## T13 增强（TASK-P1-08）
//!   - `canon_query_batch`：多查询单次 invoke（一批 filter → 一批结果）。
//!   - `canon_facts_known_by`：POV 认知轴便利封装（同 `canon_query` + 固定
//!     `known_by` / `valid_at_chapter`）。
//!   - **响应 `max_revision` 字段**：每条响应带回当前项目 canon revision
//!     （写路径自增，读路径返回当前值），供 TS 侧查询缓存失效（与 T12
//!     `CanonQueryCache` revision 语义对齐）。
//!
//! ## 多项目契约注记（蓝图 §9 ③ / ADR-16）
//!   1. **`project_id` 进每个命令签名**（首参）：canon DB 路径 =
//!      `{project_id}/.niko-buddy/lancedb`，每项目一库（T11 约定）。
//!   2. **无跨库 join**：每条命令只操作单个 `project_id` 的库，绝不在一次
//!      invoke 内跨项目读取/合并。多项目聚合由编排层（TS）在 invoke 之外完成。
//!   3. **`status.json` 单实例锁**：本模块以「每项目一条 `tokio::sync::Mutex`
//!      写锁」守写路径串行化（同项目写不并发），等价于 status.json 单实例锁
//!      契约（ADR-16）。读路径不加锁（只读，可并发）。
//!
//! ## 依赖边界（Niko Buddy 执行纪律）
//!   - 仅包装 T11 [`crate::canon::store::CanonStore`]（结构化时态/认知
//!     过滤查询 + 幂等摄取 + 批量 supersede）。**不修改 T11/T12 源码**。
//!   - T12 [`crate::canon::search`] 为混合检索（FTS+RRF+图遍历）增强层：
//!     `canon_query` 走结构化过滤（§4 契约）；T14/T25 投影客户端与 ContextPack
//!     在 packaging 层叠加 T12 语义召回，不在本 IPC 层混入向量通道。
//!   - 本文件位于 `src-tauri/src/canon/` 目录（与 `search.rs` 同层），由
//!     `lib.rs` 注册 `mod canon;`（其内 `pub mod commands`）+ `invoke_handler` 加 8 命令：
//!     `canon_query` / `canon_query_batch` / `canon_facts_known_by` /
//!     `canon_ingest_episode` / `canon_supersede_edges` /
//!     `canon_query_episodes` / `canon_get_revision` /
//!     `canon_save_divergence_trace`（清单见 lib.rs invoke_handler）。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::canon::store::CanonStore;
#[cfg(test)]
use crate::canon::types::{CanonEdge, EdgeKind};
use crate::canon::types::{CanonEdgeFilter, CanonEpisode, SupersedeRequest};

// M9-3: 响应 DTO + `*_impl` 已剥离至 `commands_core.rs`
// (fs_archive: 新文件 + 回引，外部 import 面零变化)。
pub(crate) use super::commands_core::{
    canon_facts_known_by_impl, canon_get_revision_impl, canon_ingest_episode_impl,
    canon_load_divergence_trace_impl, canon_query_batch_impl, canon_query_episodes_impl,
    canon_query_impl, canon_save_divergence_trace_impl, canon_supersede_edges_impl,
    CanonFactsKnownByResponse, CanonQueryBatchResponse, CanonQueryEpisodesResponse,
    CanonQueryResponse, CanonSupersedeResponse, CanonWriteResponse,
};

// ──────────────────────────────────────────────────────────────────────────
// 项目键归一化（M2-01：避免不同路径写法分裂锁槽与 revision 缓存）
// ──────────────────────────────────────────────────────────────────────────

/// 归一化 `project_id` 作为进程级缓存与写锁键：
/// - 裁剪首尾空白、`\` 统一为 `/`；
/// - 剥离 Windows 扩展长度前缀（`//?/UNC/` → `//`，`//?/` → ``）；
/// - 折叠多余连续 `/`（保留 UNC 前导 `//`）；
/// - 去除非根尾 `/`（保留 `/`、`//` 与 Windows 盘符根 `X:/`）；
/// - Windows 平台统一转为小写。
pub(crate) fn normalize_project_key(project_id: &str) -> String {
    let replaced = project_id.trim().replace('\\', "/");
    if replaced.is_empty() {
        return String::new();
    }

    let (preserve_unc, body): (bool, &str) = if replaced
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("//?/UNC/"))
    {
        (true, &replaced[8..])
    } else if let Some(rest) = replaced.strip_prefix("//?/") {
        (false, rest)
    } else if replaced.starts_with("//") && !replaced.starts_with("///") {
        (true, &replaced[2..])
    } else {
        (false, replaced.as_str())
    };

    let mut collapsed = String::with_capacity(replaced.len());
    if preserve_unc {
        collapsed.push_str("//");
    }
    let body_iter = if preserve_unc {
        body.trim_start_matches('/')
    } else {
        body
    };
    let mut prev_slash = false;
    for ch in body_iter.chars() {
        if ch == '/' {
            if !prev_slash {
                collapsed.push('/');
                prev_slash = true;
            }
        } else {
            collapsed.push(ch);
            prev_slash = false;
        }
    }

    let is_drive_root = |s: &str| {
        let b = s.as_bytes();
        b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/'
    };
    while collapsed.ends_with('/')
        && collapsed != "/"
        && collapsed != "//"
        && !is_drive_root(&collapsed)
    {
        collapsed.pop();
    }

    #[cfg(windows)]
    let collapsed = collapsed.to_lowercase();

    collapsed
}

// ──────────────────────────────────────────────────────────────────────────
// 多项目契约状态（managed by lib.rs）
// ──────────────────────────────────────────────────────────────────────────

/// 每项目累计写入次数达到此阈值后触发一次 best-effort `compact_tables()`。
pub(crate) const COMPACTION_WRITE_THRESHOLD: u64 = 100;

/// T13 命令管理的进程级状态：每项目 revision 计数 + 每项目写锁 + 写计数压实桶。
///
/// - `revisions`：canon revision 计数（ingest/supersede 自增；读路径返回当前值
///   作 `max_revision`）。内存计数，进程内单调（与 T12 缓存失效语义对齐）。
/// - `loaded`：已从持久化存储加载 revision 的项目集（避免重复加载）。
/// - `project_locks`：每项目单实例写锁（守 status.json 单实例锁契约：同项目
///   写串行，无跨库 join）。
/// - `write_counts`：每项目成功写入计数桶（T5 叶锁，达 `COMPACTION_WRITE_THRESHOLD`
///   清零并由调用方在释放叶锁后执行 best-effort 压实）。
///
/// ── A8 锁序不变式（2026-08-23 补写；原 1482881e 仅 message 声称，diff 无此文档）──
/// 1. `loaded` → `revisions` 单向顺序：lazy_load_revision 与 invalidate_project
///    均先锁 `loaded` 再锁 `revisions`（短持有，不跨 await）。任何代码不得在持有
///    revisions 的同时获取 loaded（反向顺序 = 死锁面）。
/// 2. `project_locks` 为最外层：所有写路径（ingest/supersede/bump）先取
///    project_locks，锁内才允许触碰 revisions/loaded/write_counts。禁止在
///    revisions 或 write_counts 持有期间获取 project_locks。
/// 3. `write_counts` 为独立 T5 叶锁（短持有、不跨 await、不与其他叶锁嵌套）。
/// 4. 不跨 await 持有任何 std Mutex（全部短持有；AsyncMutex 允许跨 await，
///    但只用于 project_locks 且无嵌套获取）。
/// 5. 本项目锁序与 TS 侧约定（novel-locks.ts「TS 锁在外 → Rust 命令在内」）
///    共同构成单向嵌套：TS per-key 锁 → project_locks → loaded/revisions / write_counts，
///    不存在回环。
///
/// DEBT-20260820-13 偿还：revision 持久化。bump_revision 后自动持久化到
/// store 的 meta 表；current_revision 在首次访问时从 store 延迟加载。
/// 进程重启后，TS 侧缓存从持久化 revision 预热。
#[derive(Default)]
pub struct CanonCommandState {
    /// 每项目 canon revision（ingest/supersede 自增）。
    revisions: Mutex<HashMap<String, u64>>,
    /// 已从 store 加载 revision 的项目集（延迟加载标记）。
    loaded: Mutex<HashSet<String>>,
    /// 每项目单实例写锁（写路径串行化）。
    project_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// 每项目累计成功写入次数（T5 叶锁，仅用于触发周期性 compaction）。
    write_counts: Mutex<HashMap<String, u64>>,
    /// 单测用压实阈值覆写（0 表示使用默认 `COMPACTION_WRITE_THRESHOLD`）。
    #[cfg(test)]
    compaction_threshold_override: std::sync::atomic::AtomicU64,
}

impl CanonCommandState {
    fn lock_revisions(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.revisions.lock().unwrap_or_else(|poisoned| {
            log::error!("[canon] revision lock poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn lock_loaded(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.loaded.lock().unwrap_or_else(|poisoned| {
            log::error!("[canon] loaded set lock poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn lock_project_locks(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AsyncMutex<()>>>> {
        self.project_locks.lock().unwrap_or_else(|poisoned| {
            log::error!("[canon] project lock map poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn lock_write_counts(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.write_counts.lock().unwrap_or_else(|poisoned| {
            log::error!("[canon] write_counts lock poisoned; recovering");
            poisoned.into_inner()
        })
    }

    fn compaction_threshold(&self) -> u64 {
        #[cfg(test)]
        {
            let custom = self
                .compaction_threshold_override
                .load(std::sync::atomic::Ordering::Relaxed);
            if custom > 0 {
                return custom;
            }
        }
        COMPACTION_WRITE_THRESHOLD
    }

    /// 累加该项目成功写入次数；达到压实阈值时清零当前项目桶并返回 `true`。
    /// 严守 T5 叶锁语义：短临界区，绝不跨 `.await`。
    pub(crate) fn record_writes_and_should_compact(&self, project_path: &str, delta: u64) -> bool {
        if delta == 0 {
            return false;
        }
        let key = normalize_project_key(project_path);
        let threshold = self.compaction_threshold();
        let mut counts = self.lock_write_counts();
        let entry = counts.entry(key).or_insert(0);
        *entry = entry.saturating_add(delta);
        if *entry >= threshold {
            *entry = 0;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn set_compaction_threshold_for_test(&self, threshold: u64) {
        self.compaction_threshold_override
            .store(threshold, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn write_count_for_test(&self, project_path: &str) -> u64 {
        let key = normalize_project_key(project_path);
        *self.lock_write_counts().get(&key).unwrap_or(&0)
    }

    /// 当前 revision（读路径用，无副作用）。
    /// 若该项目尚未从持久化存储加载，返回 0（调用方需在打开 store 后
    /// 调用 `lazy_load_revision` 补充）。
    pub fn current_revision(&self, project_id: &str) -> u64 {
        let key = normalize_project_key(project_id);
        *self.lock_revisions().get(&key).unwrap_or(&0)
    }

    /// 是否已从持久化存储加载过 revision。
    pub fn is_loaded(&self, project_id: &str) -> bool {
        let key = normalize_project_key(project_id);
        self.lock_loaded().contains(&key)
    }

    /// 从持久化存储延迟加载 revision（仅首次调用有效）。
    /// M2-01：采用单调上界更新（仅当 `persisted > *entry` 时更新），防止并发读
    /// 在写路径 bump 之后用较旧的持久化值回退内存 revision；严守 A8 `loaded → revisions` 锁序。
    pub async fn lazy_load_revision(
        &self,
        project_id: &str,
        store: &CanonStore,
    ) -> Result<(), String> {
        let key = normalize_project_key(project_id);
        // 先检查 loaded 集（短持有锁，不跨 await）
        {
            let loaded = self.lock_loaded();
            if loaded.contains(&key) {
                return Ok(());
            }
        }
        // 锁已释放，安全 await
        let persisted = store.load_revision().await?;
        // A8 单向锁序：先锁 loaded 再锁 revisions，不跨 await，单调上界更新并原子标记已加载。
        let mut loaded = self.lock_loaded();
        let mut revs = self.lock_revisions();
        if persisted > 0 {
            let entry = revs.entry(key.clone()).or_insert(0);
            if persisted > *entry {
                *entry = persisted;
            }
        }
        loaded.insert(key);
        Ok(())
    }

    /// 使指定项目的内存 revision、延迟加载标记与写计数桶失效（如备份恢复替换 LanceDB 后调用）。
    /// 严守 A8 单向锁序：先锁 `loaded` 再锁 `revisions` 原子清除，释放后再清除独立叶锁 `write_counts`。
    pub fn invalidate_project(&self, project_id: &str) {
        let key = normalize_project_key(project_id);
        {
            let mut loaded = self.lock_loaded();
            let mut revs = self.lock_revisions();
            loaded.remove(&key);
            revs.remove(&key);
        }
        self.lock_write_counts().remove(&key);
    }

    /// 写路径落盘成功后设置内存 revision 并标记已加载。
    /// 严守 A8 单向锁序：先锁 `loaded` 再锁 `revisions`（短持有，不跨 await）。
    pub fn set_revision(&self, project_id: &str, rev: u64) {
        let key = normalize_project_key(project_id);
        let mut loaded = self.lock_loaded();
        let mut revs = self.lock_revisions();
        revs.insert(key.clone(), rev);
        loaded.insert(key);
    }

    /// 写路径自增并返回新 revision（仅单测辅助；生产写路径已改为落盘后调用 `set_revision`）。
    #[cfg(test)]
    pub fn bump_revision(&self, project_id: &str) -> u64 {
        let key = normalize_project_key(project_id);
        let mut m = self.lock_revisions();
        let e = m.entry(key).or_insert(0);
        *e += 1;
        *e
    }

    /// 取（或建）该项目的写锁；首次访问即注册，等价单实例锁。
    pub fn write_lock(&self, project_id: &str) -> Arc<AsyncMutex<()>> {
        let key = normalize_project_key(project_id);
        let mut m = self.lock_project_locks();
        m.entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// `#[tauri::command]` 包装（首参 project_id 进签名；JS 侧 camelCase = projectId）
// ──────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn canon_query(
    state: State<'_, CanonCommandState>,
    project_id: String,
    filter: CanonEdgeFilter,
) -> Result<CanonQueryResponse, String> {
    canon_query_impl(state.inner(), project_id, filter).await
}

#[tauri::command]
pub async fn canon_query_batch(
    state: State<'_, CanonCommandState>,
    project_id: String,
    filters: Vec<CanonEdgeFilter>,
) -> Result<CanonQueryBatchResponse, String> {
    canon_query_batch_impl(state.inner(), project_id, filters).await
}

/// POV 认知轴便利封装（分页版）。消费方：character-cognition.ts（无分页）
/// 与 canon-facts-known-by-panel（服务端分页）。
#[tauri::command]
pub async fn canon_facts_known_by(
    state: State<'_, CanonCommandState>,
    project_id: String,
    pov: String,
    at_chapter: Option<i32>,
    include_invalidated: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<CanonFactsKnownByResponse, String> {
    canon_facts_known_by_impl(
        state.inner(),
        project_id,
        pov,
        at_chapter,
        include_invalidated,
        offset,
        limit,
    )
    .await
}

#[tauri::command]
pub async fn canon_ingest_episode(
    state: State<'_, CanonCommandState>,
    project_id: String,
    episode: CanonEpisode,
) -> Result<CanonWriteResponse, String> {
    canon_ingest_episode_impl(state.inner(), project_id, episode).await
}

#[tauri::command]
pub async fn canon_supersede_edges(
    state: State<'_, CanonCommandState>,
    project_id: String,
    request: SupersedeRequest,
) -> Result<CanonSupersedeResponse, String> {
    canon_supersede_edges_impl(state.inner(), project_id, request).await
}

#[tauri::command]
pub async fn canon_query_episodes(
    state: State<'_, CanonCommandState>,
    project_id: String,
    chapter_number: i32,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<CanonQueryEpisodesResponse, String> {
    canon_query_episodes_impl(state.inner(), project_id, chapter_number, offset, limit).await
}

/// 内部能力：仅程序化消费（canon-dual-write.ts），无直接 UI 入口。
#[tauri::command]
pub async fn canon_get_revision(
    state: State<'_, CanonCommandState>,
    project_id: String,
) -> Result<CanonQueryResponse, String> {
    canon_get_revision_impl(state.inner(), project_id).await
}

// ── DEBT-20260820-15b：divergence trace 持久化 ──

#[tauri::command]
pub async fn canon_save_divergence_trace(
    state: State<'_, CanonCommandState>,
    project_id: String,
    trace_json: String,
) -> Result<(), String> {
    canon_save_divergence_trace_impl(state.inner(), project_id, trace_json).await
}

#[tauri::command]
pub async fn canon_load_divergence_trace(project_id: String) -> Result<String, String> {
    canon_load_divergence_trace_impl(project_id).await
}

// ──────────────────────────────────────────────────────────────────────────
// 单元测试（IPC 冒烟：5 命令全绿 + 多项目契约 + max_revision）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 唯一临时项目目录（每测试一个；不清理——沿用 store 模式）。
    fn tmp_project() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("canon-cmd-test-{}-{}", ts, id));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn edge(id: &str, v: Option<i32>, inv: Option<i32>, povs: &[&str]) -> CanonEdge {
        let mut e = CanonEdge::new(id, "src", "tgt", "rel", EdgeKind::WorldFact);
        e.valid_at = v;
        e.invalid_at = inv;
        e.known_by = povs.iter().map(|s| s.to_string()).collect();
        e
    }

    // ── canon_query：known_by + valid_at_chapter 过滤 + max_revision ──

    #[tokio::test]
    async fn canon_query_filters_known_by_valid_at_and_revision() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 摄取一条 alice 独占、有效章 1..∞ 的边
        let mut e = edge("e1", Some(1), None, &["alice"]);
        e.source_chapter = Some(1);
        CanonStore::open(&pid)
            .await
            .unwrap()
            .upsert_edge(e)
            .await
            .unwrap();

        // alice @ ch5 应命中
        let r = canon_query_impl(
            &state,
            pid.clone(),
            CanonEdgeFilter {
                known_by: Some("alice".into()),
                valid_at_chapter: Some(5),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(r.edges.len(), 1);
        assert_eq!(r.edges[0].id, "e1");
        assert_eq!(r.max_revision, 0, "纯读路径不 bump revision");

        // bob 不知晓 → 过滤为空
        let r2 = canon_query_impl(
            &state,
            pid,
            CanonEdgeFilter {
                known_by: Some("bob".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(r2.edges.len(), 0);
    }

    // ── canon_query_batch：多查询单 invoke，结果顺序对应 ──

    #[tokio::test]
    async fn canon_query_batch_multiple_filters_single_invoke() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let mut e = edge("e1", Some(1), None, &["alice"]);
        e.source_chapter = Some(1);
        CanonStore::open(&pid)
            .await
            .unwrap()
            .upsert_edge(e)
            .await
            .unwrap();

        let filters = vec![
            CanonEdgeFilter {
                known_by: Some("alice".into()),
                ..Default::default()
            },
            CanonEdgeFilter {
                known_by: Some("carol".into()),
                ..Default::default()
            },
        ];
        let r = canon_query_batch_impl(&state, pid, filters).await.unwrap();
        assert_eq!(r.results.len(), 2, "一对一批量结果");
        assert_eq!(r.results[0].len(), 1, "alice 命中");
        assert_eq!(r.results[1].len(), 0, "carol 未命中");
        assert_eq!(r.max_revision, 0);
    }

    // ── v2.8 P1-2：canon_query 分页（offset/limit → total 全量计数）──

    #[tokio::test]
    async fn canon_query_paged_offset_limit_total() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let store = CanonStore::open(&pid).await.unwrap();
        for i in 0..5 {
            store
                .upsert_edge(edge(&format!("e{i}"), Some(1), None, &["alice"]))
                .await
                .unwrap();
        }
        drop(store);

        // offset=2 无 limit → 第 3 条起全量余下（3 条），total = 幸存集全量 5
        let r = canon_query_impl(
            &state,
            pid.clone(),
            CanonEdgeFilter {
                offset: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(r.edges.len(), 3);
        assert_eq!(r.total, 5, "total 为过滤后全量计数（非页大小）");
        assert_eq!(r.edges[0].id, "e2", "skip(2) 后从第 3 条开始");

        // offset=0 + limit=2 → 首页 2 条，total 仍 5
        let page1 = canon_query_impl(
            &state,
            pid.clone(),
            CanonEdgeFilter {
                offset: Some(0),
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page1.edges.len(), 2);
        assert_eq!(page1.total, 5);

        // 无 offset（旧行为）→ 全量 5 条，total = edges.len()（与 episodes 契约一致）
        let all = canon_query_impl(&state, pid, CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(all.edges.len(), 5);
        assert_eq!(all.total, 5);
    }

    // ── v2.8 P1-2：canon_query_batch 分页（totals 与 results 下标对齐）──

    #[tokio::test]
    async fn canon_query_batch_paged_totals() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let store = CanonStore::open(&pid).await.unwrap();
        for i in 0..5 {
            store
                .upsert_edge(edge(&format!("e{i}"), Some(1), None, &["alice"]))
                .await
                .unwrap();
        }
        drop(store);

        // filter 1：分页（offset=2, limit=2）；filter 2：无分页（旧行为回归）
        let filters = vec![
            CanonEdgeFilter {
                offset: Some(2),
                limit: Some(2),
                ..Default::default()
            },
            CanonEdgeFilter::default(),
        ];
        let r = canon_query_batch_impl(&state, pid, filters).await.unwrap();
        assert_eq!(r.results.len(), 2);
        assert_eq!(r.totals.len(), 2, "totals 与 results 下标一一对应");
        assert_eq!(r.results[0].len(), 2, "分页 filter → 当前页 2 条");
        assert_eq!(r.totals[0], 5, "分页 filter → total 为全量计数");
        assert_eq!(r.results[1].len(), 5);
        assert_eq!(
            r.totals[1], 5,
            "无分页 filter → total = results[i].len()（旧行为）"
        );
    }

    // ── canon_facts_known_by：POV 认知轴封装 ──

    #[tokio::test]
    async fn canon_facts_known_by_filters_pov() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let mut e = edge("e1", Some(1), None, &["alice"]);
        e.source_chapter = Some(1);
        CanonStore::open(&pid)
            .await
            .unwrap()
            .upsert_edge(e)
            .await
            .unwrap();

        let r = canon_facts_known_by_impl(
            &state,
            pid.clone(),
            "alice".into(),
            Some(5),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(r.edges.len(), 1);
        assert_eq!(r.edges[0].id, "e1");

        let r2 = canon_facts_known_by_impl(&state, pid, "bob".into(), Some(5), None, None, None)
            .await
            .unwrap();
        assert_eq!(r2.edges.len(), 0);
    }

    // ── canon_facts_known_by_include_invalidated_passthrough（C: include_invalidated 透传）──

    #[tokio::test]
    async fn canon_facts_known_by_include_invalidated_passthrough() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 有效窗 [1,5) 的世界事实，alice 已知；在第 7 章已失效。
        let mut e = edge("e1", Some(1), Some(5), &["alice"]);
        e.source_chapter = Some(1);
        CanonStore::open(&pid)
            .await
            .unwrap()
            .upsert_edge(e)
            .await
            .unwrap();

        // 旧行为（None）：第 7 章不再有效 → 0 条。
        let old = canon_facts_known_by_impl(
            &state,
            pid.clone(),
            "alice".into(),
            Some(7),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(old.edges.len(), 0);

        // include_invalidated=true：保留已失效窗口边 → 1 条。
        let inc =
            canon_facts_known_by_impl(&state, pid, "alice".into(), Some(7), Some(true), None, None)
                .await
                .unwrap();
        assert_eq!(inc.edges.len(), 1);
        assert_eq!(inc.edges[0].id, "e1");
    }

    // ── canon_facts_known_by 分页：offset/limit/total ──

    #[tokio::test]
    async fn canon_facts_known_by_pagination_total_and_offset() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let store = CanonStore::open(&pid).await.unwrap();
        for id in ["e1", "e2", "e3"] {
            let mut e = edge(id, Some(1), None, &["alice"]);
            e.source_chapter = Some(1);
            store.upsert_edge(e).await.unwrap();
        }

        // offset=0, limit=2 → 2 条，total=3
        let page = canon_facts_known_by_impl(
            &state,
            pid.clone(),
            "alice".into(),
            None,
            None,
            Some(0),
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(page.edges.len(), 2);
        assert_eq!(page.total, 3, "total 保持全量计数");

        // offset=2, limit=2 → 1 条，total=3
        let page2 = canon_facts_known_by_impl(
            &state,
            pid.clone(),
            "alice".into(),
            None,
            None,
            Some(2),
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(page2.edges.len(), 1);
        assert_eq!(page2.total, 3);

        // offset=None, limit=None → 全量，total=3（旧行为，向后兼容）
        let all = canon_facts_known_by_impl(&state, pid, "alice".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(all.edges.len(), 3);
        assert_eq!(all.total, 3);
    }

    // ── canon_ingest_episode：幂等 + revision 自增 ──

    #[tokio::test]
    async fn canon_ingest_episode_idempotent_and_bumps_revision() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let ep = CanonEpisode::new("ep1", 1, "alice", "d1");

        let r1 = canon_ingest_episode_impl(&state, pid.clone(), ep.clone())
            .await
            .unwrap();
        assert!(r1.inserted, "首次写入");
        assert_eq!(r1.max_revision, 1, "写后 revision=1");

        let r2 = canon_ingest_episode_impl(&state, pid.clone(), ep)
            .await
            .unwrap();
        assert!(!r2.inserted, "同 (chapter,digest) 幂等跳过");
        assert_eq!(r2.max_revision, 2, "仍走写路径，revision 再自增");

        // 读路径返回最新 revision（未再 bump）
        let q = canon_query_impl(&state, pid, CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(q.max_revision, 2);
    }

    // ── canon_supersede_edges：批量封顶 + revision 自增 ──

    #[tokio::test]
    async fn canon_supersede_edges_caps_and_bumps_revision() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let store = CanonStore::open(&pid).await.unwrap();
        store
            .upsert_edge(edge("old1", Some(1), None, &["alice"]))
            .await
            .unwrap();
        store
            .upsert_edge(edge("old2", Some(1), None, &["alice"]))
            .await
            .unwrap();

        let new1 = edge("new1", Some(5), None, &["alice"]);
        let req = SupersedeRequest {
            old_edge_ids: vec!["old1".into(), "ghost".into()],
            cap_chapter: 5,
            new_edges: vec![new1],
            caused_by: None,
        };
        let r = canon_supersede_edges_impl(&state, pid.clone(), req)
            .await
            .unwrap();
        assert_eq!(r.result.capped, 1);
        assert_eq!(r.result.inserted, 1);
        assert_eq!(r.result.missing, vec!["ghost".to_string()]);
        assert_eq!(r.max_revision, 1, "supersede 自增 revision");

        // 读回验证 old1 封顶、new1 存在
        let q = canon_query_impl(&state, pid, CanonEdgeFilter::default())
            .await
            .unwrap();
        let edges = q.edges;
        assert_eq!(
            edges.iter().find(|e| e.id == "old1").unwrap().invalid_at,
            Some(5)
        );
        assert!(edges.iter().any(|e| e.id == "new1"));
    }

    // ── 多项目契约：project_id 隔离 revision，无跨库 join ──

    #[tokio::test]
    async fn multi_project_revision_isolation() {
        let dir_a = tmp_project();
        let dir_b = tmp_project();
        let pid_a = dir_a.to_string_lossy().to_string();
        let pid_b = dir_b.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 项目 A 写两次
        let _ =
            canon_ingest_episode_impl(&state, pid_a.clone(), CanonEpisode::new("a1", 1, "x", "da"))
                .await
                .unwrap();
        let ra2 =
            canon_ingest_episode_impl(&state, pid_a.clone(), CanonEpisode::new("a2", 2, "x", "db"))
                .await
                .unwrap();
        assert_eq!(ra2.max_revision, 2);

        // 项目 B 仅写一次 → 独立计数，不受 A 影响
        let rb =
            canon_ingest_episode_impl(&state, pid_b.clone(), CanonEpisode::new("b1", 1, "y", "dc"))
                .await
                .unwrap();
        assert_eq!(rb.max_revision, 1, "B 独立 revision 计数");

        // A 的读仍反映 A 的 revision
        let qa = canon_query_impl(&state, pid_a, CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(qa.max_revision, 2);
        let qb = canon_query_impl(&state, pid_b, CanonEdgeFilter::default())
            .await
            .unwrap();
        assert_eq!(qb.max_revision, 1);
    }

    // ── DEBT-20260621-30b：R4 canon_query_episodes IPC ──

    #[tokio::test]
    async fn canon_query_episodes_ipc() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 摄取两个 chapter 的 episodes
        let _ = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep1", 1, "alice", "d1"),
        )
        .await
        .unwrap();
        let _ = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep2", 1, "alice", "d2"),
        )
        .await
        .unwrap();
        let _ = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep3", 2, "bob", "d3"),
        )
        .await
        .unwrap();

        // 查询 chapter=1（无分页 = 旧语义全量）
        let res = canon_query_episodes_impl(&state, pid.clone(), 1, None, None)
            .await
            .unwrap();
        assert_eq!(res.episodes.len(), 2);
        assert_eq!(res.total, 2);
        assert!(res.episodes.iter().any(|e| e.digest == "d1"));
        assert!(res.episodes.iter().any(|e| e.digest == "d2"));

        // 查询 chapter=3（无数据）
        let empty = canon_query_episodes_impl(&state, pid.clone(), 3, None, None)
            .await
            .unwrap();
        assert_eq!(empty.episodes.len(), 0);
        assert_eq!(empty.total, 0);

        // v2.8 P1-2：分页（offset/limit）——total 保持全量计数
        let page = canon_query_episodes_impl(&state, pid.clone(), 1, Some(0), Some(1))
            .await
            .unwrap();
        assert_eq!(page.episodes.len(), 1);
        assert_eq!(page.total, 2);
        let page2 = canon_query_episodes_impl(&state, pid.clone(), 1, Some(1), Some(1))
            .await
            .unwrap();
        assert_eq!(page2.episodes.len(), 1);
        assert_ne!(page.episodes[0].digest, page2.episodes[0].digest);
    }

    // ── DEBT-20260820-15b：divergence trace 持久化 ──

    #[tokio::test]
    async fn canon_save_and_load_divergence_trace_roundtrip() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 写入 divergence trace
        let trace = r#"[{\"digest\":\"abc\",\"reasons\":[\"canon:boom\"]}]"#.to_string();
        canon_save_divergence_trace_impl(&state, pid.clone(), trace.clone())
            .await
            .unwrap();

        // 读回验证
        let store = CanonStore::open(&pid).await.unwrap();
        let loaded = store.load_divergence_trace().await.unwrap();
        assert_eq!(loaded, trace, "divergence trace roundtrip");

        // 验证 revision 独立（写入 divergence trace 不应覆盖 revision）
        let rev = store.load_revision().await.unwrap();
        assert_eq!(rev, 0, "divergence trace write should not affect revision");
    }

    // ── A: supersede 戳 recorded_revision + 封顶边原戳保留（A3）──

    #[tokio::test]
    async fn canon_supersede_edges_stamps_recorded_revision_and_preserves_capped() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        let store = CanonStore::open(&pid).await.unwrap();
        // 旧边先打一个原戳（模拟上一 revision 写入），用于验 A3 封顶后原戳保留。
        let mut old1 = edge("old1", Some(1), None, &["alice"]);
        old1.recorded_revision = Some(7);
        store.upsert_edge(old1).await.unwrap();
        store
            .upsert_edge(edge("old2", Some(1), None, &["alice"]))
            .await
            .unwrap();

        let new1 = edge("new1", Some(5), None, &["alice"]);
        let req = SupersedeRequest {
            old_edge_ids: vec!["old1".into(), "ghost".into()],
            cap_chapter: 5,
            new_edges: vec![new1],
            caused_by: None,
        };
        let r = canon_supersede_edges_impl(&state, pid.clone(), req)
            .await
            .unwrap();
        assert_eq!(r.result.capped, 1);
        assert_eq!(r.result.inserted, 1);
        assert_eq!(r.max_revision, 1, "supersede 自增 revision");

        // 读回验证：new1 被戳 recorded_revision == max_revision(1)
        let q = canon_query_impl(&state, pid, CanonEdgeFilter::default())
            .await
            .unwrap();
        let by_id = |id: &str| q.edges.iter().find(|e| e.id == id).cloned();
        let new1_back = by_id("new1").expect("new1 应存在");
        assert_eq!(
            new1_back.recorded_revision,
            Some(1),
            "new_edges 戳 == max_revision"
        );
        // A3：封顶旧边 old1 原戳 (7) 在 supersede 后仍保留（invalidate_edge 不动 recorded_revision）
        let old1_back = by_id("old1").expect("old1 应仍封顶存在");
        assert_eq!(old1_back.recorded_revision, Some(7), "封顶边原戳保留（A3）");
        assert_eq!(old1_back.invalid_at, Some(5), "封顶 invalid_at 写入");
        // old2（未列入 old_edge_ids）应为 None 戳且仍有效
        let old2_back = by_id("old2").expect("old2 应存在");
        assert_eq!(old2_back.recorded_revision, None);
    }

    // ── §B：supersede 先落审计日志、再改状态（事件先落、状态后改）──

    #[tokio::test]
    async fn canon_supersede_appends_event_then_mutates() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 预置一条旧边
        let store0 = CanonStore::open(&pid).await.unwrap();
        store0
            .upsert_edge(edge("old1", Some(1), None, &["alice"]))
            .await
            .unwrap();

        // 通过 impl 触发 supersede（含审计日志先落）
        let req = SupersedeRequest {
            old_edge_ids: vec!["old1".into()],
            cap_chapter: 5,
            new_edges: vec![edge("new1", Some(5), None, &["alice"])],
            caused_by: Some("manual-correction".into()),
        };
        let r = canon_supersede_edges_impl(&state, pid.clone(), req)
            .await
            .unwrap();
        assert_eq!(r.result.capped, 1);
        assert_eq!(r.result.inserted, 1);

        // 审计事件已落（事件先落、状态后改）
        let store = CanonStore::open(&pid).await.unwrap();
        let events = store.query_canon_events().await.unwrap();
        assert_eq!(events.len(), 1, "supersede 恰好追加 1 条审计事件");
        assert_eq!(events[0].event_type, "supersede");
        assert_eq!(events[0].old_edge_ids, vec!["old1".to_string()]);
        assert_eq!(events[0].new_edge_ids, vec!["new1".to_string()]);
        assert_eq!(events[0].cap_chapter, Some(5));
        assert_eq!(events[0].caused_by, Some("manual-correction".to_string()));
        assert!(!events[0].event_id.is_empty(), "event_id 服务端派生非空");
        assert!(!events[0].occurred_at.is_empty(), "occurred_at 服务端填充");

        // 状态已改：old1 封顶、new1 可见
        let q = canon_query_impl(&state, pid, CanonEdgeFilter::default())
            .await
            .unwrap();
        let by_id = |id: &str| q.edges.iter().find(|e| e.id == id).cloned();
        assert_eq!(by_id("old1").unwrap().invalid_at, Some(5), "旧边已封顶");
        assert!(by_id("new1").is_some(), "新边已插入");
    }

    // ── §B：写放大 guard 命令入口早拒（零锁开销）──

    #[tokio::test]
    async fn canon_supersede_hard_cap_rejects() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 构造超出硬上限（old + new 总边数 > CAP）的请求
        let over = crate::canon::commands_core::CANON_SUPERSEDE_HARD_CAP + 1;
        let old_edge_ids: Vec<String> = (0..over).map(|i| format!("old{i}")).collect();
        let req = SupersedeRequest {
            old_edge_ids,
            cap_chapter: 5,
            new_edges: vec![],
            caused_by: None,
        };
        let res = canon_supersede_edges_impl(&state, pid, req).await;
        assert!(res.is_err(), "写放大 guard 应早拒超大 supersede");
        let msg = res.err().unwrap();
        assert!(
            msg.contains("too large") || msg.contains("hard cap"),
            "错误信息含硬上限提示: {msg}"
        );
    }

    // ── M2-01：重启后首写单调递增 + lazy_load 单调上界保护 ──

    #[tokio::test]
    async fn canon_first_write_after_restart_monotonically_increments_revision() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();

        // 进程 1：连续两次写 → 持久化 revision = 2
        let state1 = CanonCommandState::default();
        let r1 = canon_ingest_episode_impl(
            &state1,
            pid.clone(),
            CanonEpisode::new("ep-r1", 1, "alice", "dr1"),
        )
        .await
        .unwrap();
        assert_eq!(r1.max_revision, 1);
        let r2 = canon_ingest_episode_impl(
            &state1,
            pid.clone(),
            CanonEpisode::new("ep-r2", 2, "alice", "dr2"),
        )
        .await
        .unwrap();
        assert_eq!(r2.max_revision, 2);

        // 模拟进程重启（冷缓存 CanonCommandState）：首写 ingest 必须先懒加载 2 → bump 到 3
        let state2 = CanonCommandState::default();
        assert!(!state2.is_loaded(&pid));
        let r3 = canon_ingest_episode_impl(
            &state2,
            pid.clone(),
            CanonEpisode::new("ep-r3", 3, "alice", "dr3"),
        )
        .await
        .unwrap();
        assert_eq!(
            r3.max_revision, 3,
            "重启后首写 ingest 须从持久化 rev=2 单调递增到 3"
        );
        assert_eq!(
            CanonStore::open(&pid)
                .await
                .unwrap()
                .load_revision()
                .await
                .unwrap(),
            3
        );

        // 再次模拟重启：首写 supersede 必须先懒加载 3 → bump 到 4，新边 recorded_revision = Some(4)
        let state3 = CanonCommandState::default();
        let req = SupersedeRequest {
            old_edge_ids: vec![],
            cap_chapter: 4,
            new_edges: vec![edge("new-after-restart", Some(4), None, &["alice"])],
            caused_by: Some("restart-test".into()),
        };
        let rs = canon_supersede_edges_impl(&state3, pid.clone(), req)
            .await
            .unwrap();
        assert_eq!(
            rs.max_revision, 4,
            "重启后首写 supersede 须从持久化 rev=3 单调递增到 4"
        );
        let q = canon_query_impl(&state3, pid.clone(), CanonEdgeFilter::default())
            .await
            .unwrap();
        let new_edge = q
            .edges
            .iter()
            .find(|e| e.id == "new-after-restart")
            .expect("新边应落盘");
        assert_eq!(new_edge.recorded_revision, Some(4));

        // 单调上界保护：若内存已推进到 6，滞后的持久化值 (4) 不得回退内存 revision
        let state4 = CanonCommandState::default();
        for _ in 0..6 {
            state4.bump_revision(&pid);
        }
        let store = CanonStore::open(&pid).await.unwrap();
        state4.lazy_load_revision(&pid, &store).await.unwrap();
        assert_eq!(
            state4.current_revision(&pid),
            6,
            "lazy_load_revision 不得用较旧 persisted 回退内存 revision"
        );
        assert!(state4.is_loaded(&pid));
    }

    // ── M2-01：normalize_project_key 统一写锁槽位、revision 缓存与失效 ──

    #[test]
    fn normalize_project_key_unifies_lock_and_revision() {
        assert_eq!(normalize_project_key("  /tmp//novel///  "), "/tmp/novel");
        assert_eq!(normalize_project_key("/"), "/");
        assert_eq!(normalize_project_key("///"), "/");
        assert_eq!(
            normalize_project_key(r"\\?\C:\Users\Alice\\Proj\"),
            normalize_project_key("C:/Users/Alice/Proj")
        );
        assert_eq!(
            normalize_project_key(r"\\?\UNC\Server\Share\\Book\"),
            normalize_project_key(r"\\Server\Share\Book/")
        );
        #[cfg(windows)]
        assert_eq!(
            normalize_project_key(r"C:\Foo\Bar\"),
            normalize_project_key("c:/foo/bar")
        );

        let state = CanonCommandState::default();
        let p_a = r"  C:\Work\Novel\\  ";
        let p_b = r"\\?\C:\Work\Novel/";
        let lock_a = state.write_lock(p_a);
        let lock_b = state.write_lock(p_b);
        assert!(
            Arc::ptr_eq(&lock_a, &lock_b),
            "不同写法须归一化到同一写锁实例"
        );

        assert_eq!(state.bump_revision(p_a), 1);
        assert_eq!(state.current_revision(p_b), 1, "归一化键共享 revision 槽位");

        state.invalidate_project(p_b);
        assert_eq!(
            state.current_revision(p_a),
            0,
            "invalidate_project 清除 revision"
        );
        assert!(!state.is_loaded(p_a), "invalidate_project 清除 loaded 标记");
    }

    // ── M2-01：canon_save_divergence_trace 走同项目写锁串行化 ──

    #[tokio::test]
    async fn canon_save_divergence_trace_serializes_with_write_lock() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let pid_variant = format!("{}/", pid.replace('\\', "/"));
        let state = Arc::new(CanonCommandState::default());

        // 预先占住同项目写锁
        let lock = state.write_lock(&pid);
        let guard = lock.lock().await;

        let state_bg = Arc::clone(&state);
        let trace = r#"[{"digest":"lock-test","reasons":["serialized"]}]"#.to_string();
        let trace_bg = trace.clone();
        let handle = tokio::spawn(async move {
            canon_save_divergence_trace_impl(&state_bg, pid_variant, trace_bg).await
        });

        // 持有写锁期间，后台 save_divergence_trace 必须阻塞等待，不得穿透并发写
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        assert!(
            !handle.is_finished(),
            "持有 write_lock 期间 save_divergence_trace 应阻塞串行化"
        );

        // 释放写锁后顺利完成写入并可读回
        drop(guard);
        handle.await.unwrap().unwrap();
        let loaded = canon_load_divergence_trace_impl(pid).await.unwrap();
        assert_eq!(loaded, trace);
    }

    // ── R2-M12 / R2-M15：写失败不前推内存 revision 且失效缓存 + derive_event_id 路径归一 ──

    #[tokio::test]
    async fn canon_failed_write_invalidates_and_does_not_advance_revision() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();
        let state = CanonCommandState::default();

        // 先成功写入 1 条 → revision = 1
        let r1 = canon_ingest_episode_impl(
            &state,
            pid.clone(),
            CanonEpisode::new("ep-ok", 1, "alice", "d-ok"),
        )
        .await
        .unwrap();
        assert_eq!(r1.max_revision, 1);

        // 传入非法时态边（valid_at > invalid_at）：supersede 早拒，内存与磁盘 revision 均停留 1
        let bad_req = SupersedeRequest {
            old_edge_ids: vec![],
            cap_chapter: 5,
            new_edges: vec![edge("bad-edge", Some(10), Some(5), &["alice"])],
            caused_by: Some("invalid-test".into()),
        };
        let err = canon_supersede_edges_impl(&state, pid.clone(), bad_req).await;
        assert!(err.is_err(), "非法时态边必须被拒绝");
        assert_eq!(state.current_revision(&pid), 1, "早拒不得前推内存 revision");

        // 构造运行中途失败：旧边 valid_at=8，封顶 cap_chapter=5 < 8 → supersede_edges 失败，
        // 必须 invalidate_project 并不前推磁盘 revision
        let store = CanonStore::open(&pid).await.unwrap();
        store
            .upsert_edge(edge("old-late", Some(8), None, &["alice"]))
            .await
            .unwrap();
        drop(store);

        let mid_fail_req = SupersedeRequest {
            old_edge_ids: vec!["old-late".into()],
            cap_chapter: 5,
            new_edges: vec![],
            caused_by: Some("mid-fail".into()),
        };
        let err2 = canon_supersede_edges_impl(&state, pid.clone(), mid_fail_req).await;
        assert!(err2.is_err(), "cap_chapter < valid_at 必须失败");
        assert!(
            !state.is_loaded(&pid),
            "中途失败后 loaded 标记必须被 invalidate_project 清除"
        );
        assert_eq!(
            state.current_revision(&pid),
            0,
            "中途失败后内存缓存必须清空，等待下次懒加载真实磁盘 revision"
        );
        let reloaded = canon_get_revision_impl(&state, pid.clone()).await.unwrap();
        assert_eq!(reloaded.max_revision, 1, "磁盘 revision 未被污染");

        // derive_event_id 对不同路径写法归一化到同一 event_id
        let ev = crate::canon::types::CanonEvent::new_supersede(
            1,
            &SupersedeRequest {
                old_edge_ids: vec!["a".into()],
                cap_chapter: 2,
                new_edges: vec![],
                caused_by: None,
            },
        );
        let id_a = crate::canon::store_state::derive_event_id(r"C:\Work\Novel\", 1, &ev);
        let id_b = crate::canon::store_state::derive_event_id(r"\\?\C:\Work\Novel//", 1, &ev);
        assert_eq!(id_a, id_b, "derive_event_id 必须对 project_id 做路径归一化");
    }

    #[test]
    fn canon_command_state_recovers_from_poisoned_mutexes() {
        let state = Arc::new(CanonCommandState::default());
        let state_bg = Arc::clone(&state);

        // 按 A8 锁序毒化所有内部 Mutex，验证恢复路径不会传播二次 panic。
        let _ = std::thread::spawn(move || {
            let _proj = state_bg.project_locks.lock().unwrap();
            let _loaded = state_bg.loaded.lock().unwrap();
            let _revs = state_bg.revisions.lock().unwrap();
            let _counts = state_bg.write_counts.lock().unwrap();
            panic!("intentional poison for CanonCommandState");
        })
        .join();

        assert!(state.project_locks.is_poisoned());
        assert!(state.loaded.is_poisoned());
        assert!(state.revisions.is_poisoned());
        assert!(state.write_counts.is_poisoned());

        let pid = "/tmp/poison-recover-proj";
        let lock = state.write_lock(pid);
        assert!(Arc::ptr_eq(&lock, &state.write_lock(pid)));
        assert_eq!(state.current_revision(pid), 0);
        assert!(!state.is_loaded(pid));
        assert_eq!(state.bump_revision(pid), 1);
        assert_eq!(state.current_revision(pid), 1);
        state.set_revision(pid, 4);
        assert!(state.is_loaded(pid));
        assert_eq!(state.current_revision(pid), 4);
        assert!(!state.record_writes_and_should_compact(pid, 2));
        assert_eq!(state.write_count_for_test(pid), 2);
        state.invalidate_project(pid);
        assert!(!state.is_loaded(pid));
        assert_eq!(state.current_revision(pid), 0);
        assert_eq!(state.write_count_for_test(pid), 0);
    }

    // ── R3-M02 (R2-M15)：写计数触发周期压实 + 多项目桶隔离 + invalidate 清零 ──

    #[tokio::test]
    async fn canon_auto_compaction_tracks_writes_triggers_at_threshold_and_isolates_projects() {
        let dir_a = tmp_project();
        let dir_b = tmp_project();
        let pid_a = dir_a.to_string_lossy().to_string();
        let pid_b = dir_b.to_string_lossy().to_string();
        let state = CanonCommandState::default();
        state.set_compaction_threshold_for_test(3);

        // 1) ingest_episode：仅 inserted == true 计数 +1；幂等重放不累加
        let ep1 = CanonEpisode::new("ep-c1", 1, "alice", "d-c1");
        let r1 = canon_ingest_episode_impl(&state, pid_a.clone(), ep1.clone())
            .await
            .unwrap();
        assert!(r1.inserted);
        assert_eq!(state.write_count_for_test(&pid_a), 1);

        let r1_dup = canon_ingest_episode_impl(&state, pid_a.clone(), ep1)
            .await
            .unwrap();
        assert!(!r1_dup.inserted);
        assert_eq!(
            state.write_count_for_test(&pid_a),
            1,
            "幂等重放不得增加写计数"
        );

        // 2) 多项目隔离：项目 B 写入独立计数，不影响项目 A
        let rb = canon_ingest_episode_impl(
            &state,
            pid_b.clone(),
            CanonEpisode::new("ep-b1", 1, "bob", "d-b1"),
        )
        .await
        .unwrap();
        assert!(rb.inserted);
        assert_eq!(state.write_count_for_test(&pid_b), 1);
        assert_eq!(state.write_count_for_test(&pid_a), 1);

        // 3) supersede_edges：按 capped + inserted 累加（此处 capped=1, inserted=1 → delta=2，
        //    与项目 A 已有 1 合计 3 ≥ 阈值 3 → 触发 compact_tables 并清零项目 A 桶）
        CanonStore::open(&pid_a)
            .await
            .unwrap()
            .upsert_edge(edge("old-c1", Some(1), None, &["alice"]))
            .await
            .unwrap();
        let req = SupersedeRequest {
            old_edge_ids: vec!["old-c1".into(), "missing-id".into()],
            cap_chapter: 5,
            new_edges: vec![edge("new-c1", Some(5), None, &["alice"])],
            caused_by: Some("auto-compact-test".into()),
        };
        let rs = canon_supersede_edges_impl(&state, pid_a.clone(), req)
            .await
            .unwrap();
        assert_eq!(rs.result.capped, 1);
        assert_eq!(rs.result.inserted, 1);
        assert_eq!(
            state.write_count_for_test(&pid_a),
            0,
            "达到阈值触发压实后项目 A 写计数桶必须清零"
        );
        assert_eq!(
            state.write_count_for_test(&pid_b),
            1,
            "项目 A 压实不得清零项目 B 计数桶"
        );

        // 压实后数据与 revision 均完整可读
        let qa = canon_query_impl(&state, pid_a.clone(), CanonEdgeFilter::default())
            .await
            .unwrap();
        assert!(qa.edges.iter().any(|e| e.id == "new-c1"));
        assert_eq!(qa.max_revision, rs.max_revision);

        // 4) invalidate_project 同步清除对应项目写计数桶
        state.invalidate_project(&pid_b);
        assert_eq!(
            state.write_count_for_test(&pid_b),
            0,
            "invalidate_project 必须清除对应项目写计数"
        );
    }
}
