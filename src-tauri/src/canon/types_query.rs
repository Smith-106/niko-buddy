// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 查询过滤与写路径契约类型层——M5-3 自 `types.rs` 增量剥离（S4 单轮收敛，fs_archive 模式）。
//!
//! 收容：查询过滤 [`CanonEdgeFilter`]（认知轴/世界时态/as-of-revision 精细过滤，
//! `apply`/`select` 纯函数投影）、批量 supersede 请求/结果（[`SupersedeRequest`] /
//! [`SupersedeResult`]）、写时冲突语义分类 [`ConflictClass`]（确定性权威判定）与
//! §B 审计事件 [`CanonEvent`]（append-only，data-JSON 承载）——全部纯数据/纯函数，
//! 行结构定义（[`CanonEdge`] 等）留守 `types.rs`。
//! `types.rs` 经 `pub use` 回引，外部 import 面零变化
//! （外部引用留守原文件：`store.rs` 读写路径 `filter.select`，`commands.rs`
//! `CanonEvent::new_supersede` 审计追加与 IPC 契约）。

use serde::{Deserialize, Serialize};

use super::types::{CanonEdge, EdgeKind, Modality};

// ──────────────────────────────────────────────────────────────────────────
// 查询过滤（CanonEdgeFilter，§4 canon_query 签名）
// ──────────────────────────────────────────────────────────────────────────

/// canon_query 的边过滤条件（§4：含 known_by?/valid_at_chapter?）。
///
/// 所有字段 Optional；None = 不过滤该维。archived 默认过滤为 false
/// （仅返回未归档边），显式 `Some(true)` 返回归档边，`None` 同 `Some(false)`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CanonEdgeFilter {
    /// 认知轴：仅返回 `known_by` 包含该 POV 的边（POV 防泄密）。
    #[serde(default)]
    pub known_by: Option<String>,
    /// 世界时态：仅返回 `at_chapter` 时有效的边（valid_at <= c < invalid_at）。
    #[serde(default)]
    pub valid_at_chapter: Option<i32>,
    /// include_invalidated 过滤：Some(true)=保留已失效窗口边（"曾以为"召回）；
    /// None/Some(false)=旧行为（仅 valid_at 有效边）。与既有 invalid_at 物理列配合，
    /// 无新列。仅在与 `valid_at_chapter` 同用时生效。
    #[serde(default)]
    pub include_invalidated: Option<bool>,
    /// 仅返回 recorded_revision <= 该值的边（as-of-revision 视角重建）。
    /// None = 不过滤；Some(max) = 过滤掉 recorded_revision > max 的边
    /// （recorded_revision=None 的旧数据视作早于任何 revision，始终保留）。
    #[serde(default)]
    pub max_recorded_revision: Option<u64>,
    /// 按边类别过滤。
    #[serde(default)]
    pub edge_kinds: Option<Vec<EdgeKind>>,
    /// 按认知模态过滤（belief/hypothesis 等非断言模态可单挑）。
    #[serde(default)]
    pub modalities: Option<Vec<Modality>>,
    /// 按谓词过滤（开放字符串精确匹配）。
    #[serde(default)]
    pub predicates: Option<Vec<String>>,
    /// 按端点实体 id 过滤（source 或 target 命中其一即返回）。
    #[serde(default)]
    pub entity_ids: Option<Vec<String>>,
    /// archived 过滤（默认 Some(false)=仅未归档）。
    #[serde(default)]
    pub archived: Option<bool>,
    /// 返回上限（None=无上限）。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 分页偏移（v2.8 P1-2）：仅 paged 读路径（`query_edges_paged`）消费。
    /// `select()` 语义不变（仍只应用 limit）；offset 在过滤后幸存集上内存切片
    /// （known_by/时态精细过滤无法推 down，LanceDB 层先切片会截断幸存集 → 缺页）。
    #[serde(default)]
    pub offset: Option<usize>,
    /// 按 digest 列表过滤（精确匹配；supersede 分歧检测用）。
    /// None = 不过滤；Some(vec) = 仅返回 digest 在集合内的边。
    #[serde(default)]
    pub digest: Option<Vec<String>>,
}

impl CanonEdgeFilter {
    /// 在内存边集上应用过滤（时态 + 认知轴 + 类别 + 谓词 + 端点 + archived）。
    /// 这是 canon_query 的纯函数投影，T12/T13 的 LanceDB 查询在推 down 简单
    /// 谓词后，对召回行集调用本函数做认知轴/时态精细过滤。
    pub fn apply<'a>(&'a self, edges: &'a [CanonEdge]) -> impl Iterator<Item = &'a CanonEdge> + 'a {
        edges.iter().filter(move |e| {
            // archived：默认 Some(false)
            let want_archived = self.archived.unwrap_or(false);
            if e.archived != want_archived {
                return false;
            }
            // 认知轴
            if let Some(ref pov) = self.known_by {
                if !e.is_known_by(pov) {
                    return false;
                }
            }
            // 世界时态
            if let Some(ch) = self.valid_at_chapter {
                // include_invalidated=true 时放宽：仅要求 valid_at <= ch（含已失效窗口边）；
                // 旧行为（None/Some(false)）仍用 is_valid_at 严格半开区间判断。
                let valid = if self.include_invalidated == Some(true) {
                    e.valid_at.map_or(true, |v| v <= ch)
                } else {
                    e.is_valid_at(ch)
                };
                if !valid {
                    return false;
                }
            }
            // as-of-revision 过滤（A：recorded_revision 溯源戳）
            if let Some(max_rev) = self.max_recorded_revision {
                // None = 旧数据（无戳），视作早于任何 revision → 始终包含。
                if let Some(rev) = e.recorded_revision {
                    if rev > max_rev {
                        return false;
                    }
                }
            }
            // 边类别
            if let Some(ref kinds) = self.edge_kinds {
                if !kinds.contains(&e.edge_kind) {
                    return false;
                }
            }
            // 认知模态过滤（D：modality 正交维度，与 edge_kind 独立）
            if let Some(ref mods) = self.modalities {
                if !mods.contains(&e.modality) {
                    return false;
                }
            }
            // 谓词
            if let Some(ref preds) = self.predicates {
                if !preds.iter().any(|p| p == &e.predicate) {
                    return false;
                }
            }
            // 端点
            if let Some(ref ids) = self.entity_ids {
                if !ids
                    .iter()
                    .any(|id| id == &e.source_id || id == &e.target_id)
                {
                    return false;
                }
            }
            // digest 精确匹配（空列表 = 不过滤）
            if let Some(ref digests) = self.digest {
                if !digests.is_empty() && !digests.iter().any(|d| d == &e.digest) {
                    return false;
                }
            }
            true
        })
    }

    /// 应用过滤并收集为 Vec（受 limit 约束）。
    pub fn select(&self, edges: &[CanonEdge]) -> Vec<CanonEdge> {
        let limit = self.limit.unwrap_or(usize::MAX);
        self.apply(edges).take(limit).cloned().collect()
    }
}

// ──────────────────────────────────────────────────────────────────────────
// supersede 请求/结果（批量 supersede，§3 写路径）
// ──────────────────────────────────────────────────────────────────────────

/// 批量 supersede 请求：将一组旧边封顶（invalid_at=cap_chapter），
/// 并插入一组全新 uuid 的新边作为后继。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SupersedeRequest {
    /// 被取代的旧边 id 列表。
    pub old_edge_ids: Vec<String>,
    /// 封顶章节（旧边 invalid_at 写入值）。
    pub cap_chapter: i32,
    /// 后继新边（全新 uuid，由调用方生成）。
    pub new_edges: Vec<CanonEdge>,
    /// 审计溯源标记：触发本次 supersede 的上游动作（如 `backfill-by-digest` /
    /// `manual-correction`）。`#[serde(default)]` 向后兼容：旧 IPC 调用方未传
    /// 时视为 None（QC-5 不破坏既有契约）。
    #[serde(default)]
    pub caused_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupersedeResult {
    /// 实际被封顶的旧边数（找不到的 id 不计入）。
    pub capped: usize,
    /// 实际插入的新边数。
    pub inserted: usize,
    /// 未找到的旧边 id（诊断用）。
    pub missing: Vec<String>,
    /// 53 号报告 P0-2 additive: 因确定性 duplicate 分类被跳过的插入数
    /// (digest 相等或全等键+有效区间重叠, 幂等跳过不重复插入)。
    /// `#[serde(default)]` 向后兼容: 旧调用方未传时缺省 0 (QC-5)。
    #[serde(default)]
    pub duplicate_skipped: usize,
    /// 53 号报告 P0-2 additive: 冲突分类诊断备注 (每条格式
    /// `new_edge_id=<id>:<duplicate|contradicted|independent>`),
    /// 供审计与 TS 侧 LLM advisory 回写。`#[serde(default)]` 向后兼容。
    #[serde(default)]
    pub conflict_notes: Vec<String>,
}

/// 53 号报告 P0-2: 写时冲突语义分类 (graphiti dedupe_edges/contradiction 语义,
/// Apache-2.0 借模式)。Niko Buddy 双层: Rust 确定性分类权威 (零 LLM 守 ADR-19) +
/// TS 侧 LLM 语义分类 advisory (opt-in, 仅进审计事件不参与权威判定)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictClass {
    /// 同事实重复写入 (digest 相等或全等键+有效区间重叠) → 幂等跳过。
    Duplicate,
    /// 同端点同 predicate 异值且有效区间重叠 → 封顶旧边+插入新边。
    Contradicted,
    /// 其余 → 正常插入。
    Independent,
}

impl ConflictClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConflictClass::Duplicate => "duplicate",
            ConflictClass::Contradicted => "contradicted",
            ConflictClass::Independent => "independent",
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// §B canon_events 审计事件（独立物理表，data-JSON 承载，零迁移）
// ──────────────────────────────────────────────────────────────────────────
//
// 设计要点（选项 Z + ox-alpha 升级）：
//   - 独立 `canon_events` 表：NOT `CanonEdge` 扩展，兑现表隔离防爆半径（F6）。
//   - data-JSON 承载：完整事件负载落 `data` 列，物理列仅标量溯源键。
//   - `event_id` 服务端派生：f(project_id, max_revision, payload-hash)，
//     不进 IPC 契约（调用方无需生成 id）。
//   - 全字段 `#[serde(default)]`：旧 data（无字段）反序列化不报错，零迁移。

/// §B 审计事件（写路径每次 supersede 追加一条，append-only）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonEvent {
    /// 服务端派生事件 id：f(project_id, max_revision, payload-hash)。
    #[serde(default)]
    pub event_id: String,
    /// 事件类型（当前仅 `supersede`；预留 `ingest` / `divergence` 等）。
    #[serde(default)]
    pub event_type: String,
    /// 审计溯源标记（透传 SupersedeRequest.caused_by）。
    #[serde(default)]
    pub caused_by: Option<String>,
    /// 事件发生时 canon revision（溯源 as-of-revision 视角）。
    #[serde(default)]
    pub revision: Option<u64>,
    /// 本次 supersede 封顶的旧边 id 列表。
    #[serde(default)]
    pub old_edge_ids: Vec<String>,
    /// 封顶章节（旧边 invalid_at 写入值）。
    #[serde(default)]
    pub cap_chapter: Option<i32>,
    /// 本次 supersede 插入的后继新边 id 列表。
    #[serde(default)]
    pub new_edge_ids: Vec<String>,
    /// 事件发生的 ISO-8601 时间戳（服务端生成）。
    #[serde(default)]
    pub occurred_at: String,
    /// 完整事件负载 JSON（前进兼容：未来字段无需新物理列）。
    #[serde(default)]
    pub data: String,
}

impl CanonEvent {
    /// 构造一条 supersede 审计事件（event_id / occurred_at 由服务端
    /// `append_canon_event` 派生/填充，此处留空）。
    pub fn new_supersede(revision: u64, req: &SupersedeRequest) -> Self {
        CanonEvent {
            event_id: String::new(),
            event_type: "supersede".to_string(),
            caused_by: req.caused_by.clone(),
            revision: Some(revision),
            old_edge_ids: req.old_edge_ids.clone(),
            cap_chapter: Some(req.cap_chapter),
            new_edge_ids: req.new_edges.iter().map(|e| e.id.clone()).collect(),
            occurred_at: String::new(),
            data: String::new(),
        }
    }
}

