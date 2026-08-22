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
//!      `{project_id}/.qmai/lancedb`，每项目一库（T11 约定）。
//!   2. **无跨库 join**：每条命令只操作单个 `project_id` 的库，绝不在一次
//!     invoke 内跨项目读取/合并。多项目聚合由编排层（TS）在 invoke 之外完成。
//!   3. **`status.json` 单实例锁**：本模块以「每项目一条 `tokio::sync::Mutex`
//!     写锁」守写路径串行化（同项目写不并发），等价于 status.json 单实例锁
//!     契约（ADR-16）。读路径不加锁（只读，可并发）。
//!
//! ## 依赖边界（QMAI 执行纪律）
//!   - 仅包装 T11 [`crate::commands::canon_store::CanonStore`]（结构化时态/认知
//!     过滤查询 + 幂等摄取 + 批量 supersede）。**不修改 T11/T12 源码**。
//!   - T12 [`crate::canon_search`] 为混合检索（FTS+RRF+图遍历）增强层：
//!     `canon_query` 走结构化过滤（§4 契约）；T14/T25 投影客户端与 ContextPack
//!     在 packaging 层叠加 T12 语义召回，不在本 IPC 层混入向量通道。
//!   - 本文件位于 `src-tauri/src/` 顶层（与 `canon_search.rs` 同层），由
//!     `lib.rs` 注册 `mod canon_commands;` + `invoke_handler` 加 5 命令。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::canon_store::CanonStore;
use crate::types::canon_types::{
    CanonEdge, CanonEdgeFilter, CanonEpisode, EdgeKind, SupersedeRequest, SupersedeResult,
};

// ──────────────────────────────────────────────────────────────────────────
// 多项目契约状态（managed by lib.rs）
// ──────────────────────────────────────────────────────────────────────────

/// T13 命令管理的进程级状态：每项目 revision 计数 + 每项目写锁。
///
/// - `revisions`：canon revision 计数（ingest/supersede 自增；读路径返回当前值
///   作 `max_revision`）。内存计数，进程内单调（与 T12 缓存失效语义对齐）。
/// - `loaded`：已从持久化存储加载 revision 的项目集（避免重复加载）。
/// - `project_locks`：每项目单实例写锁（守 status.json 单实例锁契约：同项目
///   写串行，无跨库 join）。
///
/// DEBT-20260820-13 偿还：revision 持久化。bump_revision 后自动持久化到
/// canon_store 的 meta 表；current_revision 在首次访问时从 store 延迟加载。
/// 进程重启后，TS 侧缓存从持久化 revision 预热。
pub struct CanonCommandState {
    /// 每项目 canon revision（ingest/supersede 自增）。
    revisions: Mutex<HashMap<String, u64>>,
    /// 已从 store 加载 revision 的项目集（延迟加载标记）。
    loaded: Mutex<HashSet<String>>,
    /// 每项目单实例写锁（写路径串行化）。
    project_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl Default for CanonCommandState {
    fn default() -> Self {
        Self {
            revisions: Mutex::new(HashMap::new()),
            loaded: Mutex::new(HashSet::new()),
            project_locks: Mutex::new(HashMap::new()),
        }
    }
}

impl CanonCommandState {
    /// 当前 revision（读路径用，无副作用）。
    /// 若该项目尚未从持久化存储加载，返回 0（调用方需在打开 store 后
    /// 调用 `lazy_load_revision` 补充）。
    pub fn current_revision(&self, project_id: &str) -> u64 {
        *self
            .revisions
            .lock()
            .expect("revision lock poisoned")
            .get(project_id)
            .unwrap_or(&0)
    }

    /// 是否已从持久化存储加载过 revision。
    pub fn is_loaded(&self, project_id: &str) -> bool {
        self.loaded
            .lock()
            .expect("loaded set poisoned")
            .contains(project_id)
    }

    /// 从持久化存储延迟加载 revision（仅首次调用有效）。
    /// 若 store 中存储的 revision > 0，则更新内存缓存。
    pub async fn lazy_load_revision(
        &self,
        project_id: &str,
        store: &CanonStore,
    ) -> Result<(), String> {
        // 先检查 loaded 集（短持有锁，不跨 await）
        {
            let loaded = self.loaded.lock().expect("loaded set poisoned");
            if loaded.contains(project_id) {
                return Ok(());
            }
        }
        // 锁已释放，安全 await
        let persisted = store.load_revision().await?;
        if persisted > 0 {
            let mut revs = self.revisions.lock().expect("revision lock poisoned");
            revs.insert(project_id.to_string(), persisted);
        }
        // 标记已加载（重新拿锁，不跨 await）
        let mut loaded = self.loaded.lock().expect("loaded set poisoned");
        loaded.insert(project_id.to_string());
        Ok(())
    }

    /// 写路径自增并返回新 revision（缓存失效信号）。
    /// 调用方应在持有写锁后调用此方法，并随后调用 `persist_revision`
    /// 将新 revision 写入持久化存储。
    pub fn bump_revision(&self, project_id: &str) -> u64 {
        let mut m = self.revisions.lock().expect("revision lock poisoned");
        let e = m.entry(project_id.to_string()).or_insert(0);
        *e += 1;
        *e
    }

    /// 将当前 revision 持久化到 canon_store 的 meta 表。
    /// 应在 bump_revision 后、_impl 函数返回前调用。
    pub async fn persist_revision(
        &self,
        project_id: &str,
        store: &CanonStore,
    ) -> Result<(), String> {
        let rev = self.current_revision(project_id);
        store.save_revision(rev).await
    }

    /// 取（或建）该项目的写锁；首次访问即注册，等价单实例锁。
    pub fn write_lock(&self, project_id: &str) -> Arc<AsyncMutex<()>> {
        let mut m = self
            .project_locks
            .lock()
            .expect("project lock map poisoned");
        m.entry(project_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 响应类型（每条响应含 max_revision）
// ──────────────────────────────────────────────────────────────────────────

/// `canon_query` / `canon_facts_known_by` 响应。
#[derive(Debug, Clone, Serialize)]
pub struct CanonQueryResponse {
    /// 过滤后的边集（时态 + 认知轴 + 类别 + 谓词 + 端点）。
    pub edges: Vec<CanonEdge>,
    /// 当前项目 canon revision（读路径返回当前值，供缓存失效判定）。
    pub max_revision: u64,
}

/// `canon_query_batch` 响应（多查询单次 invoke）。
#[derive(Debug, Clone, Serialize)]
pub struct CanonQueryBatchResponse {
    /// 与入参 `filters` 顺序一一对应的结果集。
    pub results: Vec<Vec<CanonEdge>>,
    /// 当前项目 canon revision。
    pub max_revision: u64,
}

/// `canon_ingest_episode` 写响应。
#[derive(Debug, Clone, Serialize)]
pub struct CanonWriteResponse {
    /// 是否实际写入（false = 同 (chapter, digest) 已存在，幂等跳过）。
    pub inserted: bool,
    /// 写后 revision（自增后）。
    pub max_revision: u64,
}

/// `canon_supersede_edges` 写响应。
#[derive(Debug, Clone, Serialize)]
pub struct CanonSupersedeResponse {
    /// 批量 supersede 结果（封顶数/插入数/缺失 id）。
    pub result: SupersedeResult,
    /// 写后 revision（自增后）。
    pub max_revision: u64,
}

/// `canon_query_episodes` 读响应（DEBT-20260621-30b）。
#[derive(Debug, Clone, Serialize)]
pub struct CanonQueryEpisodesResponse {
    /// 该章全部 episode 行。
    pub episodes: Vec<CanonEpisode>,
    /// 当前项目 canon revision。
    pub max_revision: u64,
}

// ──────────────────────────────────────────────────────────────────────────
// 核心逻辑（与 `#[tauri::command]` 分离，便于 `cargo test` 直测）
// ──────────────────────────────────────────────────────────────────────────

/// 按 filter 查询边（时态 + 认知轴过滤，T11 结构化路径）。
///
/// DEBT-20260820-13 偿还：首次访问时从持久化存储延迟加载 revision。
pub async fn canon_query_impl(
    state: &CanonCommandState,
    project_id: String,
    filter: CanonEdgeFilter,
) -> Result<CanonQueryResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    let edges = store.query_edges(&filter).await?;
    Ok(CanonQueryResponse {
        edges,
        max_revision: state.current_revision(&project_id),
    })
}

/// 多查询单次 invoke：批量 filter → 批量结果。
///
/// DEBT-20260820-13 偿还：首次访问时从持久化存储延迟加载 revision。
pub async fn canon_query_batch_impl(
    state: &CanonCommandState,
    project_id: String,
    filters: Vec<CanonEdgeFilter>,
) -> Result<CanonQueryBatchResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    let mut results = Vec::with_capacity(filters.len());
    for f in &filters {
        results.push(store.query_edges(f).await?);
    }
    Ok(CanonQueryBatchResponse {
        results,
        max_revision: state.current_revision(&project_id),
    })
}

/// POV 认知轴便利封装：固定 `known_by` + 可选 `valid_at_chapter`。
///
/// DEBT-20260820-13 偿还：首次访问时从持久化存储延迟加载 revision。
pub async fn canon_facts_known_by_impl(
    state: &CanonCommandState,
    project_id: String,
    pov: String,
    at_chapter: Option<i32>,
) -> Result<CanonQueryResponse, String> {
    let filter = CanonEdgeFilter {
        known_by: Some(pov),
        valid_at_chapter: at_chapter,
        ..Default::default()
    };
    canon_query_impl(state, project_id, filter).await
}

/// 幂等摄取 episode（写路径：串行化 + revision 自增）。
///
/// DEBT-20260820-13 偿还：写后 revision 持久化到 canon_store meta 表。
pub async fn canon_ingest_episode_impl(
    state: &CanonCommandState,
    project_id: String,
    episode: CanonEpisode,
) -> Result<CanonWriteResponse, String> {
    let lock = state.write_lock(&project_id);
    let _guard = lock.lock().await;
    let store = CanonStore::open(&project_id).await?;
    let inserted = store.ingest_episode(episode).await?;
    let max_revision = state.bump_revision(&project_id);
    state.persist_revision(&project_id, &store).await?;
    Ok(CanonWriteResponse {
        inserted,
        max_revision,
    })
}

/// 批量 supersede（写路径：串行化 + revision 自增）。
///
/// DEBT-20260820-13 偿还：写后 revision 持久化到 canon_store meta 表。
pub async fn canon_supersede_edges_impl(
    state: &CanonCommandState,
    project_id: String,
    request: SupersedeRequest,
) -> Result<CanonSupersedeResponse, String> {
    let lock = state.write_lock(&project_id);
    let _guard = lock.lock().await;
    let store = CanonStore::open(&project_id).await?;
    let result = store.supersede_edges(request).await?;
    let max_revision = state.bump_revision(&project_id);
    state.persist_revision(&project_id, &store).await?;
    Ok(CanonSupersedeResponse {
        result,
        max_revision,
    })
}

/// 按章节号查询 episodes（读路径，DEBT-20260621-30b supersede 分歧检测）。
///
/// 返回该章全部 episode 行（含 ingest_log 去重语义；复用在 canon_store 中
/// 纯读操作，不触发 revision 自增）。
pub async fn canon_query_episodes_impl(
    state: &CanonCommandState,
    project_id: String,
    chapter_number: i32,
) -> Result<CanonQueryEpisodesResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    let episodes = store.query_episodes_by_chapter(chapter_number).await?;
    Ok(CanonQueryEpisodesResponse {
        episodes,
        max_revision: state.current_revision(&project_id),
    })
}

// ──────────────────────────────────────────────────────────────────────────
// `#[tauri::command]` 包装（首参 project_id 进签名；JS 侧 camelCase = projectId）
// ──────────────────────────────────────────────────────────────────────────

/// 获取当前项目 canon revision（TS 侧缓存预热 / 读路径专用，无副作用）。
///
/// DEBT-20260820-13 偿还：首次访问时从持久化存储延迟加载 revision。
pub async fn canon_get_revision_impl(
    state: &CanonCommandState,
    project_id: String,
) -> Result<CanonQueryResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    Ok(CanonQueryResponse {
        edges: Vec::new(),
        max_revision: state.current_revision(&project_id),
    })
}

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

#[tauri::command]
pub async fn canon_facts_known_by(
    state: State<'_, CanonCommandState>,
    project_id: String,
    pov: String,
    at_chapter: Option<i32>,
) -> Result<CanonQueryResponse, String> {
    canon_facts_known_by_impl(state.inner(), project_id, pov, at_chapter).await
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
) -> Result<CanonQueryEpisodesResponse, String> {
    canon_query_episodes_impl(state.inner(), project_id, chapter_number).await
}

#[tauri::command]
pub async fn canon_get_revision(
    state: State<'_, CanonCommandState>,
    project_id: String,
) -> Result<CanonQueryResponse, String> {
    canon_get_revision_impl(state.inner(), project_id).await
}

// ── DEBT-20260820-15b：divergence trace 持久化 ──

/// 将 divergence trace JSON 持久化写入 canon_store meta 表。
/// DEBT-20260820-15b 偿还：twoPhaseReconcile 告警后调用，
/// 将差异留痕写入 canon_store，供后续审计/诊断查询。
pub async fn canon_save_divergence_trace_impl(
    project_id: String,
    trace_json: String,
) -> Result<(), String> {
    let store = CanonStore::open(&project_id).await?;
    store.save_divergence_trace(&trace_json).await
}

#[tauri::command]
pub async fn canon_save_divergence_trace(
    project_id: String,
    trace_json: String,
) -> Result<(), String> {
    canon_save_divergence_trace_impl(project_id, trace_json).await
}

// ──────────────────────────────────────────────────────────────────────────
// 单元测试（IPC 冒烟：5 命令全绿 + 多项目契约 + max_revision）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 唯一临时项目目录（每测试一个；不清理——沿用 canon_store 模式）。
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

        let r = canon_facts_known_by_impl(&state, pid.clone(), "alice".into(), Some(5))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 1);
        assert_eq!(r.edges[0].id, "e1");

        let r2 = canon_facts_known_by_impl(&state, pid, "bob".into(), Some(5))
            .await
            .unwrap();
        assert_eq!(r2.edges.len(), 0);
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
        let q = canon_query_impl(
            &state,
            pid,
            CanonEdgeFilter::default(),
        )
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
        let _ = canon_ingest_episode_impl(
            &state,
            pid_a.clone(),
            CanonEpisode::new("a1", 1, "x", "da"),
        )
        .await
        .unwrap();
        let ra2 = canon_ingest_episode_impl(
            &state,
            pid_a.clone(),
            CanonEpisode::new("a2", 2, "x", "db"),
        )
        .await
        .unwrap();
        assert_eq!(ra2.max_revision, 2);

        // 项目 B 仅写一次 → 独立计数，不受 A 影响
        let rb = canon_ingest_episode_impl(
            &state,
            pid_b.clone(),
            CanonEpisode::new("b1", 1, "y", "dc"),
        )
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

    // ── DEBT-20260820-15b：divergence trace 持久化 ──

    #[tokio::test]
    async fn canon_save_and_load_divergence_trace_roundtrip() {
        let dir = tmp_project();
        let pid = dir.to_string_lossy().to_string();

        // 写入 divergence trace
        let trace = r#"[{\"digest\":\"abc\",\"reasons\":[\"canon:boom\"]}]"#.to_string();
        canon_save_divergence_trace_impl(pid.clone(), trace.clone())
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
}
