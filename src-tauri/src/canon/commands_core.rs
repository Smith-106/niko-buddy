// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 命令核心逻辑层——M9-3 自 `commands.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：响应 DTO（6 structs）+ 可直测 `*_impl`（7 个）+ divergence `*_impl`（2 个）。
//! `commands.rs` 经 `pub(crate) use` 回引，外部 import 面零变化
//! （存活引用由留守的 `CanonCommandState` + 9 个 `#[tauri::command]` 薄包装持有：
//! `canon_query` → `canon_query_impl`、`canon_query_batch` →
//! `canon_query_batch_impl`、`canon_facts_known_by` → `canon_facts_known_by_impl`、
//! `canon_ingest_episode` → `canon_ingest_episode_impl`、`canon_supersede_edges` →
//! `canon_supersede_edges_impl`、`canon_query_episodes` → `canon_query_episodes_impl`、
//! `canon_get_revision` → `canon_get_revision_impl`、
//! `canon_save_divergence_trace` → `canon_save_divergence_trace_impl`、
//! `canon_load_divergence_trace` → `canon_load_divergence_trace_impl`）。
//!
//! - `CANON_SUPERSEDE_HARD_CAP` 提为 `pub(crate)`（§B 写放大 guard；命令入口早拒）。
//! - 本文件无死代码豁免属性（M1-M9 纪律：剥离即被引用，无死代码）。

use serde::Serialize;

use crate::canon::store::CanonStore;
use crate::canon::types::{
    CanonEdge, CanonEdgeFilter, CanonEpisode, CanonEvent, SupersedeRequest, SupersedeResult,
};

use super::commands::CanonCommandState;

// ──────────────────────────────────────────────────────────────────────────
// 响应类型（每条响应含 max_revision）
// ──────────────────────────────────────────────────────────────────────────

/// `canon_query` 响应。
#[derive(Debug, Clone, Serialize)]
pub struct CanonQueryResponse {
    /// 过滤后的边集（时态 + 认知轴 + 类别 + 谓词 + 端点）。
    /// 分页时（filter.offset = Some）为当前页。
    pub edges: Vec<CanonEdge>,
    /// 过滤后全量计数（v2.8 P1-2）：分页时 = 幸存集全量（供分页器）；
    /// 无分页（offset = None，旧行为）= edges.len()（与 episodes 契约一致）。
    pub total: usize,
    /// 当前项目 canon revision（读路径返回当前值，供缓存失效判定）。
    pub max_revision: u64,
}

/// `canon_facts_known_by` 分页响应（P1-1：offset/limit/total）。
#[derive(Debug, Clone, Serialize)]
pub struct CanonFactsKnownByResponse {
    /// 当前页边集（offset/limit 截取后）。
    pub edges: Vec<CanonEdge>,
    /// 该 POV 全量边计数（分页器用；无分页时 = edges.len()）。
    pub total: usize,
    /// 当前项目 canon revision。
    pub max_revision: u64,
}

/// `canon_query_batch` 响应（多查询单次 invoke）。
#[derive(Debug, Clone, Serialize)]
pub struct CanonQueryBatchResponse {
    /// 与入参 `filters` 顺序一一对应的结果集（分页 filter 时为当前页）。
    pub results: Vec<Vec<CanonEdge>>,
    /// 与 `results` 下标一一对应的过滤后全量计数（v2.8 P1-2；
    /// 无分页 filter 时 = results[i].len()）。供 canonEditor 服务端分页器消费。
    pub totals: Vec<usize>,
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
    /// 该章 episode 行（分页时为当前页）。
    pub episodes: Vec<CanonEpisode>,
    /// 该章全量 episode 计数（分页器用；无分页时 = episodes.len()）。
    pub total: usize,
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
    // v2.8 P1-2 路由：filter.offset = Some → paged 读（切片 + 全量 total）；
    // None → 旧行为（全量/limit 截断），total = 返回条数。
    let (edges, total) = if filter.offset.is_some() {
        store.query_edges_paged(&filter).await?
    } else {
        let edges = store.query_edges(&filter).await?;
        let total = edges.len();
        (edges, total)
    };
    Ok(CanonQueryResponse {
        edges,
        total,
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
    let mut totals = Vec::with_capacity(filters.len());
    for f in &filters {
        // v2.8 P1-2 路由（与 canon_query_impl 同一规则）：offset = Some → paged。
        let (edges, total) = if f.offset.is_some() {
            store.query_edges_paged(f).await?
        } else {
            let edges = store.query_edges(f).await?;
            let total = edges.len();
            (edges, total)
        };
        results.push(edges);
        totals.push(total);
    }
    Ok(CanonQueryBatchResponse {
        results,
        totals,
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
    include_invalidated: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<CanonFactsKnownByResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    let filter = CanonEdgeFilter {
        known_by: Some(pov),
        valid_at_chapter: at_chapter,
        include_invalidated,
        ..Default::default()
    };
    // 全量收集（filter 不含 limit），据此计算 total，再在内存做 offset/limit 截取。
    let all = store.query_edges(&filter).await?;
    let total = all.len();
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(usize::MAX);
    let edges = all.into_iter().skip(offset).take(limit).collect();
    Ok(CanonFactsKnownByResponse {
        edges,
        total,
        max_revision: state.current_revision(&project_id),
    })
}

/// 幂等摄取 episode（写路径：串行化 + revision 自增）。
///
/// DEBT-20260820-13 偿还：写后 revision 持久化到 store meta 表。
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
/// DEBT-20260820-13 偿还：写后 revision 持久化到 store meta 表。
/// §B 写放大 guard 硬上限：单次 supersede 触达的旧边 + 新边总边数。
/// 早于 write_lock 早拒（零锁开销），防止超大批量 supersede 触发海量
/// 边变更 + 审计事件写入的写放大（P2 护栏，防爆半径）。
pub(crate) const CANON_SUPERSEDE_HARD_CAP: usize = 4096;

pub async fn canon_supersede_edges_impl(
    state: &CanonCommandState,
    project_id: String,
    request: SupersedeRequest,
) -> Result<CanonSupersedeResponse, String> {
    // §B 写放大 guard：命令入口早拒（早于 write_lock，零锁开销）
    if request.old_edge_ids.len() + request.new_edges.len() > CANON_SUPERSEDE_HARD_CAP {
        return Err(format!(
            "supersede too large: {} edges (old {} + new {}) exceeds hard cap {}",
            request.old_edge_ids.len() + request.new_edges.len(),
            request.old_edge_ids.len(),
            request.new_edges.len(),
            CANON_SUPERSEDE_HARD_CAP
        ));
    }
    let lock = state.write_lock(&project_id);
    let _guard = lock.lock().await;
    let store = CanonStore::open(&project_id).await?;
    // A2: bump revision 提前到 store.supersede_edges 之前，使 new_edges 能带上
    // post-bump 的 recorded_revision 戳（as-of-revision 溯源标记）。
    let max_revision = state.bump_revision(&project_id);
    // 对 new_edges 逐个戳 recorded_revision = Some(max_revision)；old_edge_ids 走
    // invalidate_edge（不动 recorded_revision），封顶边原戳自动保留（A3 自动满足）。
    let mut request = request;
    for e in &mut request.new_edges {
        e.recorded_revision = Some(max_revision);
    }
    // §B：先落审计日志，再改状态（done-when #3：日志失败即中止变更，零边变更）。
    // event_id 服务端派生 f(project_id, max_revision, payload-hash)，caused_by 透传。
    let mut ev = CanonEvent::new_supersede(max_revision, &request);
    store.append_canon_event(&mut ev).await?;
    let result = store.supersede_edges(request).await?;
    state.persist_revision(&project_id, &store).await?;
    Ok(CanonSupersedeResponse {
        result,
        max_revision,
    })
}

/// 按章节号查询 episodes（读路径，DEBT-20260621-30b supersede 分歧检测）。
///
/// 返回该章全部 episode 行（含 ingest_log 去重语义；复用在 store 中
/// 纯读操作，不触发 revision 自增）。
pub async fn canon_query_episodes_impl(
    state: &CanonCommandState,
    project_id: String,
    chapter_number: i32,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<CanonQueryEpisodesResponse, String> {
    let store = CanonStore::open(&project_id).await?;
    if !state.is_loaded(&project_id) {
        state.lazy_load_revision(&project_id, &store).await?;
    }
    let (episodes, total) = store
        .query_episodes_by_chapter(chapter_number, offset, limit)
        .await?;
    Ok(CanonQueryEpisodesResponse {
        episodes,
        total,
        max_revision: state.current_revision(&project_id),
    })
}

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
        // 纯 revision 探针（无 UI 入口，程序化消费）：无可分页数据，total 恒 0。
        total: 0,
        max_revision: state.current_revision(&project_id),
    })
}

// ── DEBT-20260820-15b：divergence trace 持久化 ──

/// 将 divergence trace JSON 持久化写入 store meta 表。
/// DEBT-20260820-15b 偿还：twoPhaseReconcile 告警后调用，
/// 将差异留痕写入 store，供后续审计/诊断查询。
pub async fn canon_save_divergence_trace_impl(
    project_id: String,
    trace_json: String,
) -> Result<(), String> {
    let store = CanonStore::open(&project_id).await?;
    store.save_divergence_trace(&trace_json).await
}

/// 55 号设计 W2-2 (54⑤ 收尾): 读取 divergence trace JSON (读路径)。
/// 不存在或不可读时返回空字符串 (与 save 对称的审计读接口)。
pub async fn canon_load_divergence_trace_impl(project_id: String) -> Result<String, String> {
    let store = CanonStore::open(&project_id).await?;
    store.load_divergence_trace().await
}
