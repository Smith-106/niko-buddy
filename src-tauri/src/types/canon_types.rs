// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Canon 三表数据模型（T11，蓝图 §3 终版 + §6 T11）。
//!
//! 三表命名映射 §3 的 entities / edges / episodes：
//!   - `canon_entities`  ← §3 entities 表（实体 + 技法列 + 麦基弧光）
//!   - `canon_edges`     ← §3 edges 表（事实边 + 时态 + 认知轴 + 技法列）
//!   - `canon_episodes`  ← §3 episodes 表（章节叙事快照 + beat/tension/arc 技法列）
//!
//! `canon_episodes` 同时承担 **ingest_log 语义**：其 `(chapter_number, digest)`
//! 即 ingest_digest 去重的幂等键（蓝图 T11「(chapter,digest) 写前去重」）。
//! 故不另建独立 `canon_ingest_log` 表——episodes 表天然就是摄取日志
//! （§3 episodes 表已含 `digest` 字段），避免第二份会话/摄取状态文件。
//!
//! ## 时态三层（§3）
//!   1. 世界时态：`valid_at` / `invalid_at`（章节号；invalid_at=None 表示仍有效）
//!   2. 叙事快照：`reference_time`（章节号；该事实被引用/观测的叙事时刻）
//!   3. 认知轴：`known_by: Vec<String>`（知晓该事实的 POV 集合）+
//!      `revealed_at`（向某 POV 揭示的章节）—— POV 防泄密地基（F-13/T14）。
//!
//! ## 技法列（§3，纯 additive）
//!   所有技法列均为 `Option` + `#[serde(default)]`：旧数据反序列化时回填默认值，
//!   新增技法列不破坏向后兼容（serde 层吸收演化，无需 DDL 迁移）。
//!
//! ## 嵌入注记列（T04 spike 裁决）
//!   `embedding_model` + `embedding_version` 为注记列（T04 §3 裁决：三参数
//!   维度/归一化/度量入 schema，模型名+版本入 DDL 注记列）。换模型维度不兼容
//!   时需重建索引——schema_version 迁移链预留该路径。
//!
//! ## archived 标志位（预留）
//!   三表均预留 `archived: bool`（默认 false）。软删除/归档语义：archived=true
//!   的行默认被 query 过滤，但物理保留（审计/回溯）。预留位，当前不主动写入。
//!
//! 本文件为 **纯数据 + 纯迁移逻辑**，不依赖 lancedb / arrow / tokio，
//! 全部可被 `cargo test` 直接覆盖（含 proptest）。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

// ──────────────────────────────────────────────────────────────────────────
// 表名常量（LanceDB 物理表名）
// ──────────────────────────────────────────────────────────────────────────

/// §3 entities 表 → canon_entities。
pub const CANON_TABLE_ENTITIES: &str = "canon_entities";
/// §3 edges 表 → canon_edges（事实边）。
pub const CANON_TABLE_EDGES: &str = "canon_edges";
/// §3 episodes 表 → canon_episodes（兼 ingest_log 去重语义）。
pub const CANON_TABLE_EPISODES: &str = "canon_episodes";
/// §B 审计事件表 → canon_events（独立物理表，与三表隔离，防爆半径）。
///
/// 选项 Z（data-JSON 承载）：审计事件以 `data` 列承载完整 JSON 负载，
/// 物理列仅保留审计/溯源所需的标量键（id/event_type/caused_by/revision/
/// cap_chapter/occurred_at），不引入任何业务新列——零迁移（不动 MIGRATIONS
/// 断言，旧库下次 `open()` 经 `ensure_table` 自动补建）。
pub const CANON_TABLE_EVENTS: &str = "canon_events";
/// schema 版本清单表（key/value），记录当前应用 schema_version。
pub const CANON_TABLE_META: &str = "canon_schema_meta";

// ──────────────────────────────────────────────────────────────────────────
// 枚举（开放/受限注册表，§3 + §4）
// ──────────────────────────────────────────────────────────────────────────

/// §3 edges.edge_kind：事实边的类别（开放谓词之外的粗分类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    WorldFact,
    Motivation,
    Arc,
    Foreshadow,
    Hook,
    Attribute,
}

impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorldFact => "world_fact",
            Self::Motivation => "motivation",
            Self::Arc => "arc",
            Self::Foreshadow => "foreshadow",
            Self::Hook => "hook",
            Self::Attribute => "attribute",
        }
    }

    pub fn from_str_lossy(s: &str) -> Option<Self> {
        Some(match s {
            "world_fact" => Self::WorldFact,
            "motivation" => Self::Motivation,
            "arc" => Self::Arc,
            "foreshadow" => Self::Foreshadow,
            "hook" => Self::Hook,
            "attribute" => Self::Attribute,
            _ => return None,
        })
    }
}

/// §3 edges.modality：事实的认知模态（落点①，与 edge_kind 正交）。
///
/// - `Assertive`：叙述者断言（默认；旧数据回填值，Rust `#[serde(default)]` 兼容）。
/// - `Belief`：角色相信（渲染带认知标记「X 认为…」，不触发矛盾判定）。
/// - `Hypothesis`：假设（同上）。
/// - `Retconned`：回溯改写（as-of-revision 溯源标记）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modality {
    Assertive,
    Belief,
    Hypothesis,
    Retconned,
}

impl Modality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Assertive => "assertive",
            Self::Belief => "belief",
            Self::Hypothesis => "hypothesis",
            Self::Retconned => "retconned",
        }
    }

    pub fn from_str_lossy(s: &str) -> Option<Self> {
        Some(match s {
            "assertive" => Self::Assertive,
            "belief" => Self::Belief,
            "hypothesis" => Self::Hypothesis,
            "retconned" => Self::Retconned,
            _ => return None,
        })
    }

    pub fn default_modality() -> Self {
        Self::Assertive
    }
}

/// §4 ArcStage（U-04 提案 7 值）：人物弧光阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArcStage {
    GhostExposed,
    Refusal,
    Commitment,
    Active,
    Crisis,
    Climax,
    Resolution,
}

impl ArcStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GhostExposed => "ghost_exposed",
            Self::Refusal => "refusal",
            Self::Commitment => "commitment",
            Self::Active => "active",
            Self::Crisis => "crisis",
            Self::Climax => "climax",
            Self::Resolution => "resolution",
        }
    }
}

/// §4 ConflictCaliber（U-07 提案三值）：场景冲突口径桥接。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictCaliber {
    Edgerton,
    Gerke,
    SnyderLong,
}

impl ConflictCaliber {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Edgerton => "edgerton",
            Self::Gerke => "gerke",
            Self::SnyderLong => "snyder_long",
        }
    }
}

/// §3 episodes.narrative_mode（F-26 项目配置，U-07 提案双值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrativeMode {
    SnyderCommercial,
    LongformPadding,
}

impl NarrativeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SnyderCommercial => "snyder_commercial",
            Self::LongformPadding => "longform_padding",
        }
    }

    pub fn default_mode() -> Self {
        Self::SnyderCommercial
    }
}

/// §3 episodes.beat_hits[].closure_state：弧闭环状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosureState {
    Open,
    Closed,
}

/// §3 episodes.narrative_stage：叙事阶段（结局三戒"终局章识别"载体）。
/// 开放字符串（F-28 升格通道在 rule-stack，不在存储层定死枚举），
/// 存储层仅保留常见取值常量供生成端引用。
pub mod narrative_stage {
    /// 终局章（结局三戒升格触发条件之一）。
    pub const FINALE: &str = "finale";
    /// 常规推进章。
    pub const PROGRESS: &str = "progress";
}

// ──────────────────────────────────────────────────────────────────────────
// episodes 技法子结构（beat_hits / arc_closure）
// ──────────────────────────────────────────────────────────────────────────

/// §3 episodes.beat_hits[] 单项：结构化爽点 beat 命中（爽点闭环依据）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatHit {
    /// beat 类型标签（Snyder / 自定义注册表）。
    pub beat_type: String,
    /// 强度（爽点量化 U-01：type_weight × payoff_magnitude × closure_decay）。
    pub intensity: f32,
    /// 位置比例（0.0=章首 .. 1.0=章末）。
    pub position_ratio: f32,
    /// 所属弧 id。
    pub arc_id: String,
    /// 该 beat 对应弧的闭环状态。
    pub closure_state: ClosureState,
}

/// §3 episodes.arc_closure[] 单项：弧闭环状态快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcClosure {
    pub arc_id: String,
    pub state: ClosureState,
}

// ──────────────────────────────────────────────────────────────────────────
// canon_entities 行（§3 entities 表）
// ──────────────────────────────────────────────────────────────────────────

/// §3 entities 表行：实体 + 技法列 + 麦基弧光 + 嵌入注记。
///
/// 所有技法/注记列为 `Option` + `#[serde(default)]`（纯 additive）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonEntity {
    // ── 基础 ──
    pub id: String,
    /// 实体类型（开放注册表：character / location / item / faction / ...）。
    #[serde(rename = "type")]
    pub entity_type: String,
    pub canonical_name: String,
    /// 首次出现章节。
    pub first_seen_chapter: i32,
    /// 世界时态：生效章节（None=自始有效）。
    #[serde(default)]
    pub valid_at: Option<i32>,
    /// 世界时态：失效章节（None=仍有效；封顶由 invalidate 写入）。
    #[serde(default)]
    pub invalid_at: Option<i32>,

    // ── 技法：愿望-动机-行动（§5）──
    /// 王祥愿望（string[]）。
    #[serde(default)]
    pub wish: Vec<String>,
    /// 动机（与 wish 强制区分，§3 R5）。
    #[serde(default)]
    pub motive: Vec<String>,
    /// 行动（wish-motive-action 三联）。
    #[serde(default)]
    pub wma_action: Vec<String>,

    // ── 技法：麦基弧光（§5）──
    #[serde(default)]
    pub mckee_ghost: Option<String>,
    /// 麦基意识欲望（独立于 wish，§3）。
    #[serde(default)]
    pub mckee_conscious_desire: Option<String>,
    #[serde(default)]
    pub mckee_unconscious_need: Option<String>,
    /// 善中（empathy core）。
    #[serde(default)]
    pub mckee_empathy_core: Option<String>,
    /// 弧光阶段（U-04 提案 7 值）。
    #[serde(default)]
    pub arc_stage: Option<ArcStage>,
    /// 八项素质 8 槽位（U-04 命名由摄取回填；map<string,0..1>）。
    #[serde(default)]
    pub arc_fundamentals: Option<serde_json::Value>,
    /// 显著细节锚点（F-25）。
    #[serde(default)]
    pub significant_details: Vec<String>,
    /// 可见行为层快照（随章追加；JSON 数组）。
    #[serde(default)]
    pub visible_actions: Vec<serde_json::Value>,
    /// 兜底技法元数据。
    #[serde(default)]
    pub craft_meta: Option<serde_json::Value>,

    // ── 预留 / 注记 ──
    /// archived 软删除标志（预留，默认 false）。
    #[serde(default)]
    pub archived: bool,
    /// 嵌入模型名注记（T04 §3 裁决）。
    #[serde(default)]
    pub embedding_model: Option<String>,
    /// 嵌入模型版本注记（T04 §3 裁决）。
    #[serde(default)]
    pub embedding_version: Option<String>,
}

impl CanonEntity {
    /// 技法列默认值构造（仅基础字段必填）。
    pub fn new(id: impl Into<String>, entity_type: impl Into<String>, canonical_name: impl Into<String>, first_seen_chapter: i32) -> Self {
        Self {
            id: id.into(),
            entity_type: entity_type.into(),
            canonical_name: canonical_name.into(),
            first_seen_chapter,
            valid_at: None,
            invalid_at: None,
            wish: Vec::new(),
            motive: Vec::new(),
            wma_action: Vec::new(),
            mckee_ghost: None,
            mckee_conscious_desire: None,
            mckee_unconscious_need: None,
            mckee_empathy_core: None,
            arc_stage: None,
            arc_fundamentals: None,
            significant_details: Vec::new(),
            visible_actions: Vec::new(),
            craft_meta: None,
            archived: false,
            embedding_model: None,
            embedding_version: None,
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// canon_edges 行（§3 edges 表，事实边）
// ──────────────────────────────────────────────────────────────────────────

/// §3 edges 表行：事实边 + 时态三层 + 认知轴 + 技法列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonEdge {
    // ── 基础 ──
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    /// 谓词（开放，含 HAS_ATTRIBUTE）。
    pub predicate: String,
    pub edge_kind: EdgeKind,

    // ── 时态三层 ──
    #[serde(default)]
    pub valid_at: Option<i32>,
    /// 封顶章节（None=仍有效；invalidate/supersede 写入）。
    #[serde(default)]
    pub invalid_at: Option<i32>,
    #[serde(default)]
    pub reference_time: Option<i32>,
    /// 认知轴：知晓该事实的 POV 集合（F-13 POV 防泄密）。
    #[serde(default)]
    pub known_by: Vec<String>,
    /// 认知轴：向 known_by 揭示的章节。
    #[serde(default)]
    pub revealed_at: Option<i32>,
    #[serde(default)]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub source_chapter: Option<i32>,
    /// 幂等键（写路径去重；graphiti 模式）。
    #[serde(default)]
    pub digest: String,

    // ── 技法 ──
    /// Snyder beat 标签。
    #[serde(default)]
    pub beat_label: Option<String>,
    /// 事实的认知模态（落点①：belief/hypothesis 不触发矛盾判定；与 edge_kind 正交）。
    /// 封闭 enum + 默认 Assertive；旧数据（data JSON 无此字段）经
    /// `#[serde(default = "Modality::default_modality")]` 回填 Assertive，零迁移。
    #[serde(default = "Modality::default_modality")]
    pub modality: Modality,
    #[serde(default)]
    pub beat_hit: Option<bool>,
    /// 伏笔埋设章节（foreshadow 边）。
    #[serde(default)]
    pub foreshadow_planted_at: Option<i32>,
    /// 开端钩子类型（foreshadow/hook 边；注册表取值 U-05）。
    #[serde(default)]
    pub hook_type: Option<String>,
    /// 伏笔回收章节（多米诺闭环）。
    #[serde(default)]
    pub payoff_chapter: Option<i32>,

    // ── 预留 ──
    #[serde(default)]
    pub archived: bool,
    /// 最后一次写入该边的写尝试 revision（attempt-count，含幂等 skip 的 post-bump 值）。
    /// None = 旧数据（data JSON 无此字段）；as-of-revision 过滤用 `<=` 比较。
    #[serde(default)]
    pub recorded_revision: Option<u64>,
}

impl CanonEdge {
    pub fn new(
        id: impl Into<String>,
        source_id: impl Into<String>,
        target_id: impl Into<String>,
        predicate: impl Into<String>,
        edge_kind: EdgeKind,
    ) -> Self {
        Self {
            id: id.into(),
            source_id: source_id.into(),
            target_id: target_id.into(),
            predicate: predicate.into(),
            edge_kind,
            valid_at: None,
            invalid_at: None,
            reference_time: None,
            known_by: Vec::new(),
            revealed_at: None,
            confidence: None,
            source_chapter: None,
            digest: String::new(),
            beat_label: None,
            modality: Modality::default_modality(),
            beat_hit: None,
            foreshadow_planted_at: None,
            hook_type: None,
            payoff_chapter: None,
            archived: false,
            recorded_revision: None,
        }
    }

    /// 该边在 `at_chapter` 时是否有效（世界时态过滤）。
    /// valid_at <= at_chapter < invalid_at（None 边界视为开放）。
    pub fn is_valid_at(&self, at_chapter: i32) -> bool {
        let after_start = self.valid_at.map_or(true, |v| v <= at_chapter);
        let before_end = self.invalid_at.map_or(true, |inv| at_chapter < inv);
        after_start && before_end
    }

    /// `pov` 是否知晓该边（认知轴过滤）。
    pub fn is_known_by(&self, pov: &str) -> bool {
        self.known_by.iter().any(|k| k == pov)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// canon_episodes 行（§3 episodes 表 + ingest_log 去重）
// ──────────────────────────────────────────────────────────────────────────

/// §3 episodes 表行：章节叙事快照 + beat/tension/arc 技法列 + 嵌入注记。
///
/// `(chapter_number, digest)` 是 ingest_digest 去重幂等键。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonEpisode {
    pub id: String,
    pub chapter_number: i32,
    /// POV 实体 id。
    pub entity_id: String,
    /// 叙事阶段（narrative_stage 常量见 [`narrative_stage`]）。
    #[serde(default = "default_narrative_stage")]
    pub narrative_stage: String,
    #[serde(default)]
    pub reference_time: Option<i32>,
    #[serde(default)]
    pub summary: String,
    /// ingest_digest 去重幂等键（(chapter_number, digest)）。
    #[serde(default)]
    pub digest: String,

    // ── 技法（结构化列）──
    /// beat 命中数组（爽点闭环依据）。
    #[serde(default)]
    pub beat_hits: Vec<BeatHit>,
    /// 张弛曲线采样（结构化列）。
    #[serde(default)]
    pub tension_curve: Vec<f32>,
    /// 弧闭环状态数组（结构化列）。
    #[serde(default)]
    pub arc_closure: Vec<ArcClosure>,
    /// 章末钩子类型（11 型注册表，U-05 提案）。
    #[serde(default)]
    pub hook_type: Option<String>,
    /// 场景冲突口径桥接（U-07 提案三值）。
    #[serde(default)]
    pub conflict_caliber: Option<ConflictCaliber>,
    #[serde(default)]
    pub craft_meta: Option<serde_json::Value>,
    /// 项目级口径（F-26；U-07 提案双值）。
    #[serde(default = "NarrativeMode::default_mode")]
    pub narrative_mode: NarrativeMode,

    // ── 预留 / 注记 ──
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub embedding_model: Option<String>,
    #[serde(default)]
    pub embedding_version: Option<String>,
}

fn default_narrative_stage() -> String {
    narrative_stage::PROGRESS.to_string()
}

impl CanonEpisode {
    pub fn new(
        id: impl Into<String>,
        chapter_number: i32,
        entity_id: impl Into<String>,
        digest: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            chapter_number,
            entity_id: entity_id.into(),
            narrative_stage: default_narrative_stage(),
            reference_time: None,
            summary: String::new(),
            digest: digest.into(),
            beat_hits: Vec::new(),
            tension_curve: Vec::new(),
            arc_closure: Vec::new(),
            hook_type: None,
            conflict_caliber: None,
            craft_meta: None,
            narrative_mode: NarrativeMode::default_mode(),
            archived: false,
            embedding_model: None,
            embedding_version: None,
        }
    }
}

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
                if !ids.iter().any(|id| id == &e.source_id || id == &e.target_id) {
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
    pub fn new_supersede(
        revision: u64,
        req: &SupersedeRequest,
    ) -> Self {
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

// ──────────────────────────────────────────────────────────────────────────
// schema_version 迁移链（纯逻辑，up / dry-run / rollback）
// ──────────────────────────────────────────────────────────────────────────
//
// 设计（蓝图 §9 数据处理① + T11）：
//   - 应用层 `SchemaVersion` 跟踪已应用的迁移；与 LanceDB 内部 table version
//     不同（后者是 Lance 物理版本，用于 rollback 的 checkout/restore）。
//   - 每条 `Migration` 纯 additive：只新增 nullable 列（CAST(NULL AS <type>)），
//     不改/删列——保证 dry-run 安全、rollback 可回退版本标记。
//   - `plan_migration(from, to)` 纯函数：返回有序迁移计划（不触碰 IO）。
//   - `apply_to_manifest` / `rollback_manifest` 纯函数：在 SchemaManifest 上
//     演化版本标记 + applied_columns，幂等（重复 apply 同一 plan ≡ 一次）。
//   - LanceDB IO 层（canon_store.rs）按 plan 调 `table.add_columns(...)`；
//     rollback 的数据层走 LanceDB `checkout(prev).restore()`（见 canon_store 注记）。
//
// LanceDB 0.27 schema 演化能力（已核实 lancedb-0.27.2/src/table.rs）：
//   - `Table::add_columns(NewColumnTransform::SqlExpressions, None)` ✓ 支持
//   - `Table::alter_columns` / `drop_columns` ✓ 支持
//   - `Table::version` / `checkout` / `restore` / `list_versions` ✓ 支持
//   故 T11 采用 add_columns 为迁移主路径；表重建预案仅作非 additive 变更的
//   文档化兜底（见 canon_store.rs `migrate_up` 注记）。

/// 应用层 schema 版本（newtype，可比较）。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
pub struct SchemaVersion(pub u32);

impl SchemaVersion {
    pub const fn new(v: u32) -> Self {
        Self(v)
    }
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// 当前 schema 版本（v3：base + archived + embedding 注记）。
pub const CURRENT_SCHEMA_VERSION: SchemaVersion = SchemaVersion(3);

/// LanceDB SQL 类型名（lance 4.0 DataFusion 方言，已核实：
/// `CAST(NULL AS int/bigint/string/boolean)`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanceType {
    Boolean,
    Int32,
    Int64,
    Float32,
    Utf8,
}

impl LanceType {
    /// `add_columns` 用的 NULL 转换表达式（nullable 新列）。
    pub fn null_cast_expr(self) -> &'static str {
        match self {
            Self::Boolean => "CAST(NULL AS boolean)",
            Self::Int32 => "CAST(NULL AS int)",
            Self::Int64 => "CAST(NULL AS bigint)",
            Self::Float32 => "CAST(NULL AS float)",
            Self::Utf8 => "CAST(NULL AS string)",
        }
    }

    /// 简短类型标签（诊断/日志）。
    pub fn label(self) -> &'static str {
        match self {
            Self::Boolean => "boolean",
            Self::Int32 => "int32",
            Self::Int64 => "int64",
            Self::Float32 => "float32",
            Self::Utf8 => "utf8",
        }
    }
}

/// 一条 additive 列变更（迁移单元）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnSpec {
    /// 目标表（CANON_TABLE_* 之一）。
    pub table: &'static str,
    pub name: &'static str,
    pub lance_type: LanceType,
    pub description: &'static str,
}

/// 一条 schema 迁移（纯 additive）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub version: SchemaVersion,
    pub name: &'static str,
    pub columns: &'static [ColumnSpec],
}

/// v2 迁移：新增 archived 标志位（三表预留）。
pub static MIGRATION_V2_ARCHIVED: &[ColumnSpec] = &[
    ColumnSpec {
        table: CANON_TABLE_ENTITIES,
        name: "archived",
        lance_type: LanceType::Boolean,
        description: "archived 软删除标志位（预留，默认 NULL→视作 false）",
    },
    ColumnSpec {
        table: CANON_TABLE_EDGES,
        name: "archived",
        lance_type: LanceType::Boolean,
        description: "archived 软删除标志位（预留）",
    },
    ColumnSpec {
        table: CANON_TABLE_EPISODES,
        name: "archived",
        lance_type: LanceType::Boolean,
        description: "archived 软删除标志位（预留）",
    },
];

/// v3 迁移：新增 embedding 注记列（entities + episodes，T04 §3 裁决）。
pub static MIGRATION_V3_EMBEDDING: &[ColumnSpec] = &[
    ColumnSpec {
        table: CANON_TABLE_ENTITIES,
        name: "embedding_model",
        lance_type: LanceType::Utf8,
        description: "嵌入模型名注记（T04 §3 裁决：换模型需重建索引）",
    },
    ColumnSpec {
        table: CANON_TABLE_ENTITIES,
        name: "embedding_version",
        lance_type: LanceType::Utf8,
        description: "嵌入模型版本注记",
    },
    ColumnSpec {
        table: CANON_TABLE_EPISODES,
        name: "embedding_model",
        lance_type: LanceType::Utf8,
        description: "嵌入模型名注记（episode 摘要向量）",
    },
    ColumnSpec {
        table: CANON_TABLE_EPISODES,
        name: "embedding_version",
        lance_type: LanceType::Utf8,
        description: "嵌入模型版本注记",
    },
];

/// 迁移链（v1=base 由 create_table 直接建满当前 schema；v2/v3 为 additive 升级）。
pub static MIGRATIONS: &[Migration] = &[
    Migration {
        version: SchemaVersion(2),
        name: "add_archived_flag",
        columns: MIGRATION_V2_ARCHIVED,
    },
    Migration {
        version: SchemaVersion(3),
        name: "add_embedding_annotation",
        columns: MIGRATION_V3_EMBEDDING,
    },
];

/// 迁移计划（dry-run 产物，纯数据，无 IO）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPlan {
    pub from: SchemaVersion,
    pub to: SchemaVersion,
    /// 有序迁移步骤（from < version <= to）。
    pub steps: Vec<&'static Migration>,
    /// 展平的新增列（供 add_columns 批量执行）。
    pub added_columns: Vec<&'static ColumnSpec>,
}

impl MigrationPlan {
    /// 是否为空计划（from == to，无需迁移）。
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    /// dry-run 人类可读摘要（不触碰 IO）。
    pub fn dry_run_summary(&self) -> String {
        if self.is_empty() {
            return format!(
                "no migration needed: already at v{}",
                self.to.get()
            );
        }
        let cols: Vec<String> = self
            .added_columns
            .iter()
            .map(|c| format!("{}.{} ({})", c.table, c.name, c.lance_type.label()))
            .collect();
        format!(
            "migrate v{} → v{}: {} step(s), additive columns: [{}]",
            self.from.get(),
            self.to.get(),
            self.steps.len(),
            cols.join(", ")
        )
    }
}

/// 计算迁移计划（纯函数）。
///
/// - `from <= to`，否则返回空计划（降级视为已最新）。
/// - 收集 `MIGRATIONS` 中 `from < version <= to` 的迁移，按 version 升序。
/// - 展平所有 additive 列。
pub fn plan_migration(from: SchemaVersion, to: SchemaVersion) -> MigrationPlan {
    let mut steps: Vec<&'static Migration> = MIGRATIONS
        .iter()
        .filter(|m| m.version > from && m.version <= to)
        .collect();
    steps.sort_by_key(|m| m.version);
    let added_columns: Vec<&'static ColumnSpec> = steps
        .iter()
        .flat_map(|m| m.columns.iter())
        .collect();
    MigrationPlan {
        from,
        to,
        steps,
        added_columns,
    }
}

/// 应用层 schema 清单（版本标记 + 已应用列名）。
///
/// 持久化形态：canon_schema_meta 表的 `{"version":N,"applied_columns":[...]}`
/// JSON 值（见 canon_store.rs）。本结构是纯逻辑载体，所有演化操作可被
/// proptest 覆盖（迁移幂等等）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SchemaManifest {
    pub version: SchemaVersion,
    #[serde(default)]
    pub applied_columns: BTreeSet<String>,
}

impl SchemaManifest {
    pub fn new(version: SchemaVersion) -> Self {
        Self {
            version,
            applied_columns: BTreeSet::new(),
        }
    }

    /// 当前是否已是 `target` 版本。
    pub fn is_at(&self, target: SchemaVersion) -> bool {
        self.version >= target
    }

    /// 在清单上应用迁移计划（纯函数，幂等）。
    ///
    /// 幂等性：若 `self.version >= plan.to`，直接返回（无副作用）；
    /// 否则将 version 提升至 `plan.to`，并将新增列名并入 applied_columns。
    /// 重复 apply 同一 plan 第二次即 no-op——这是 proptest 迁移幂等的依据。
    pub fn apply_plan(&mut self, plan: &MigrationPlan) {
        if self.version >= plan.to {
            return;
        }
        for col in &plan.added_columns {
            self.applied_columns
                .insert(format!("{}.{}", col.table, col.name));
        }
        self.version = plan.to;
    }

    /// 回退清单版本标记到 `to`（纯函数）。
    ///
    /// 语义：rollback 仅回退应用层版本标记（不物理删列——additive 列保留
    /// 无害）。数据层回退由 LanceDB `checkout(prev_lance_version).restore()`
    /// 承担（见 canon_store.rs `migrate_rollback` 注记）。`to > current` 视为
    /// no-op。
    pub fn rollback_to(&mut self, to: SchemaVersion) {
        if to < self.version {
            self.version = to;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// ingest_digest 去重（纯函数）
// ──────────────────────────────────────────────────────────────────────────

/// (chapter, digest) 幂等键。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub struct IngestKey {
    pub chapter_number: i32,
    pub digest: String,
}

/// 检查 `(chapter, digest)` 是否已存在于已摄取摘要集合中（写前去重）。
///
/// 纯函数：T11 store 的 `ingest_episode` 在写 LanceDB 前调用本函数；
/// 命中则跳过写入（返回 true=已存在=跳过），未命中则写入。
pub fn ingest_digest_exists(
    mut existing: impl Iterator<Item = (i32, String)>,
    chapter_number: i32,
    digest: &str,
) -> bool {
    existing.any(|(ch, d)| ch == chapter_number && d == digest)
}

// ──────────────────────────────────────────────────────────────────────────
// 时态不变量校验（纯函数，proptest 覆盖）
// ──────────────────────────────────────────────────────────────────────────

/// 时态不变量校验错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemporalInvariantError {
    /// valid_at > invalid_at（世界时态倒置）。
    ValidAfterInvalid { edge_id: String, valid_at: i32, invalid_at: i32 },
    /// revealed_at 早于 valid_at（认知揭示早于事实生效）。
    RevealedBeforeValid { edge_id: String, revealed_at: i32, valid_at: i32 },
}

impl std::fmt::Display for TemporalInvariantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ValidAfterInvalid { edge_id, valid_at, invalid_at } => write!(
                f,
                "edge {edge_id}: valid_at {valid_at} > invalid_at {invalid_at}"
            ),
            Self::RevealedBeforeValid { edge_id, revealed_at, valid_at } => write!(
                f,
                "edge {edge_id}: revealed_at {revealed_at} < valid_at {valid_at}"
            ),
        }
    }
}

impl std::error::Error for TemporalInvariantError {}

/// 校验单条边的时态不变量（纯函数）。
///
/// 不变量：
///   1. 若 valid_at 与 invalid_at 均存在，则 valid_at <= invalid_at。
///   2. 若 revealed_at 与 valid_at 均存在，则 revealed_at >= valid_at
///      （事实生效后才能向 POV 揭示——POV 防泄密地基）。
pub fn validate_edge_temporal(edge: &CanonEdge) -> Result<(), TemporalInvariantError> {
    if let (Some(v), Some(inv)) = (edge.valid_at, edge.invalid_at) {
        if v > inv {
            return Err(TemporalInvariantError::ValidAfterInvalid {
                edge_id: edge.id.clone(),
                valid_at: v,
                invalid_at: inv,
            });
        }
    }
    if let (Some(r), Some(v)) = (edge.revealed_at, edge.valid_at) {
        if r < v {
            return Err(TemporalInvariantError::RevealedBeforeValid {
                edge_id: edge.id.clone(),
                revealed_at: r,
                valid_at: v,
            });
        }
    }
    Ok(())
}

/// 校验一组边的时态不变量（纯函数，proptest 覆盖）。
pub fn validate_edges_temporal(edges: &[CanonEdge]) -> Result<(), TemporalInvariantError> {
    for e in edges {
        validate_edge_temporal(e)?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// 单元测试（纯逻辑，无 IO；proptest 见 canon_store.rs）
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(id: &str, v: Option<i32>, inv: Option<i32>) -> CanonEdge {
        let mut e = CanonEdge::new(id, "s", "t", "rel", EdgeKind::WorldFact);
        e.valid_at = v;
        e.invalid_at = inv;
        e
    }

    #[test]
    fn canon_edge_is_valid_at_respects_temporal_bounds() {
        let e = edge("e1", Some(5), Some(10));
        assert!(e.is_valid_at(5));
        assert!(e.is_valid_at(9));
        assert!(!e.is_valid_at(10), "invalid_at is exclusive cap");
        assert!(!e.is_valid_at(4));
    }

    #[test]
    fn canon_edge_is_valid_at_open_bounds() {
        let e = edge("e1", None, None);
        assert!(e.is_valid_at(0));
        assert!(e.is_valid_at(1000));
    }

    #[test]
    fn canon_edge_known_by_filter() {
        let mut e = edge("e1", None, None);
        e.known_by = vec!["alice".into(), "bob".into()];
        assert!(e.is_known_by("alice"));
        assert!(!e.is_known_by("carol"));
    }

    #[test]
    fn canon_filter_cognitive_axis_excludes_future_pov() {
        let mut e = edge("e1", Some(1), None);
        e.known_by = vec!["alice".into()];
        let all = vec![e];
        // alice 知晓 → 命中
        assert_eq!(
            CanonEdgeFilter {
                known_by: Some("alice".into()),
                ..Default::default()
            }
            .select(&all)
            .len(),
            1
        );
        // carol 不知晓 → 过滤掉（POV 防泄密）
        assert_eq!(
            CanonEdgeFilter {
                known_by: Some("carol".into()),
                ..Default::default()
            }
            .select(&all)
            .len(),
            0
        );
    }

    #[test]
    fn canon_filter_valid_at_chapter_temporal() {
        let e = edge("e1", Some(5), Some(10));
        let all = vec![e];
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(7),
                ..Default::default()
            }
            .select(&all)
            .len(),
            1
        );
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(12),
                ..Default::default()
            }
            .select(&all)
            .len(),
            0
        );
    }

    // ── C: include_invalidated 过滤（方案 X 全做 M+）──

    #[test]
    fn canon_filter_include_invalidated_true_keeps_invalidated_window() {
        // valid_at=5, invalid_at=10；查询章节 12 时该边已失效（窗口 [5,10)）。
        let e = edge("e1", Some(5), Some(10));
        let all = vec![e];
        // 旧行为：第 12 章已超出 invalid_at 半开区间 → 0 条。
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(12),
                ..Default::default()
            }
            .select(&all)
            .len(),
            0
        );
        // include_invalidated=true：仅要求 valid_at <= 12 → 保留已失效窗口边（1 条）。
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(12),
                include_invalidated: Some(true),
                ..Default::default()
            }
            .select(&all)
            .len(),
            1
        );
    }

    #[test]
    fn canon_filter_include_invalidated_none_or_false_old_behavior() {
        let e = edge("e1", Some(5), Some(10));
        let all = vec![e];
        // None / Some(false) 均等同旧行为：第 12 章不召回。
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(12),
                ..Default::default()
            }
            .select(&all)
            .len(),
            0
        );
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(12),
                include_invalidated: Some(false),
                ..Default::default()
            }
            .select(&all)
            .len(),
            0
        );
        // 当前仍有效的边（第 7 章 < invalid_at=10）不受 include_invalidated 影响。
        assert_eq!(
            CanonEdgeFilter {
                valid_at_chapter: Some(7),
                include_invalidated: Some(true),
                ..Default::default()
            }
            .select(&all)
            .len(),
            1
        );
    }

    #[test]
    fn canon_technique_columns_default_on_new() {
        let e = CanonEntity::new("e1", "character", "Alice", 1);
        assert!(e.wish.is_empty());
        assert!(e.motive.is_empty());
        assert!(e.mckee_ghost.is_none());
        assert!(e.arc_stage.is_none());
        assert!(!e.archived, "archived defaults false");
        let ep = CanonEpisode::new("ep1", 1, "alice", "d1");
        assert!(ep.beat_hits.is_empty());
        assert!(ep.tension_curve.is_empty());
        assert_eq!(ep.narrative_mode, NarrativeMode::SnyderCommercial);
    }

    #[test]
    fn canon_serde_back_compat_additive_fields() {
        // 旧数据（无技法列）反序列化应回填默认值。
        let old_json = r#"{
            "id":"e1","type":"character","canonical_name":"Alice","first_seen_chapter":1
        }"#;
        let e: CanonEntity = serde_json::from_str(old_json).unwrap();
        assert_eq!(e.id, "e1");
        assert!(e.wish.is_empty());
        assert!(!e.archived);
    }

    #[test]
    fn canon_migration_plan_collects_additive_steps() {
        let plan = plan_migration(SchemaVersion(1), CURRENT_SCHEMA_VERSION);
        assert_eq!(plan.from, SchemaVersion(1));
        assert_eq!(plan.to, CURRENT_SCHEMA_VERSION);
        assert_eq!(plan.steps.len(), 2, "v2 + v3");
        // v2: 3 archived; v3: 4 embedding → 7 additive columns
        assert_eq!(plan.added_columns.len(), 7);
        assert!(!plan.is_empty());
    }

    #[test]
    fn canon_migration_plan_noop_when_already_current() {
        let plan = plan_migration(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
        assert!(plan.is_empty());
        assert!(plan.dry_run_summary().contains("no migration"));
    }

    #[test]
    fn canon_migration_apply_is_idempotent() {
        let plan = plan_migration(SchemaVersion(1), CURRENT_SCHEMA_VERSION);
        let mut m = SchemaManifest::new(SchemaVersion(1));
        m.apply_plan(&plan);
        let v1 = m.version;
        let cols1 = m.applied_columns.len();
        // 二次 apply 同一 plan → no-op（幂等）
        m.apply_plan(&plan);
        assert_eq!(m.version, v1);
        assert_eq!(m.applied_columns.len(), cols1);
        assert_eq!(m.version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn canon_migration_rollback_marker() {
        let plan = plan_migration(SchemaVersion(1), CURRENT_SCHEMA_VERSION);
        let mut m = SchemaManifest::new(SchemaVersion(1));
        m.apply_plan(&plan);
        assert_eq!(m.version, CURRENT_SCHEMA_VERSION);
        m.rollback_to(SchemaVersion(1));
        assert_eq!(m.version, SchemaVersion(1));
        // applied_columns 保留（additive 列物理保留，仅回退标记）
        assert!(!m.applied_columns.is_empty());
    }

    #[test]
    fn canon_ingest_digest_dedup() {
        let existing = vec![(1, "d1".into()), (2, "d2".into())];
        assert!(ingest_digest_exists(
            existing.iter().cloned(),
            1,
            "d1"
        ));
        assert!(!ingest_digest_exists(
            existing.iter().cloned(),
            1,
            "d2"
        ), "same chapter different digest → not dup");
        assert!(!ingest_digest_exists(
            existing.iter().cloned(),
            3,
            "d1"
        ), "different chapter same digest → not dup");
    }

    #[test]
    fn canon_temporal_invariant_valid() {
        let mut e = edge("e1", Some(5), Some(10));
        e.revealed_at = Some(6);
        assert!(validate_edge_temporal(&e).is_ok());
    }

    #[test]
    fn canon_temporal_invariant_inverted_bounds_rejected() {
        let e = edge("e1", Some(10), Some(5));
        assert!(matches!(
            validate_edge_temporal(&e),
            Err(TemporalInvariantError::ValidAfterInvalid { .. })
        ));
    }

    #[test]
    fn canon_temporal_invariant_revealed_before_valid_rejected() {
        let mut e = edge("e1", Some(5), None);
        e.revealed_at = Some(3);
        assert!(matches!(
            validate_edge_temporal(&e),
            Err(TemporalInvariantError::RevealedBeforeValid { .. })
        ));
    }

    // ── A: recorded_revision 兼容 + as-of-revision 过滤 ──

    #[test]
    fn canon_edge_recorded_revision_serde_default_on_old_data() {
        // 旧数据（无 recorded_revision / modality）→ 反序列化回填 None / Assertive。
        let old_json = r#"{
            "id":"e1","source_id":"s","target_id":"t","predicate":"rel",
            "edge_kind":"world_fact"
        }"#;
        let e: CanonEdge = serde_json::from_str(old_json).unwrap();
        assert_eq!(e.recorded_revision, None, "旧数据 recorded_revision 回填 None");
        assert_eq!(e.modality, Modality::Assertive, "旧数据 modality 回填 Assertive");
    }

    #[test]
    fn canon_edge_recorded_revision_serde_roundtrip() {
        let mut e = CanonEdge::new("e1", "s", "t", "rel", EdgeKind::WorldFact);
        e.recorded_revision = Some(7);
        e.modality = Modality::Belief;
        let json = serde_json::to_string(&e).unwrap();
        let back: CanonEdge = serde_json::from_str(&json).unwrap();
        assert_eq!(back.recorded_revision, Some(7));
        assert_eq!(back.modality, Modality::Belief);
    }

    #[test]
    fn canon_filter_max_recorded_revision_keeps_le_and_excludes_gt() {
        let mut e_old = CanonEdge::new("e-old", "s", "t", "rel", EdgeKind::WorldFact);
        e_old.recorded_revision = Some(3);
        let mut e_new = CanonEdge::new("e-new", "s", "t", "rel", EdgeKind::WorldFact);
        e_new.recorded_revision = Some(9);
        let mut e_none = CanonEdge::new("e-none", "s", "t", "rel", EdgeKind::WorldFact);
        // recorded_revision 默认 None（旧数据无戳）
        let all = vec![e_old.clone(), e_new.clone(), e_none.clone()];

        // max=5：e_new(9) 被排除，e_old(3) 与 e_none(None) 保留。
        let sel = CanonEdgeFilter {
            max_recorded_revision: Some(5),
            ..Default::default()
        }
        .select(&all);
        let ids: Vec<&str> = sel.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["e-old", "e-none"], "max_recorded_revision as-of-revision 过滤");
        assert!(sel.iter().all(|e| e.recorded_revision.map_or(true, |r| r <= 5)));

        // None 过滤：全部保留（不过滤）。
        assert_eq!(CanonEdgeFilter::default().select(&all).len(), 3);
    }

    // ── D: modality 过滤 ──

    #[test]
    fn canon_filter_modalities_belief_hypothesis() {
        let mut e_assertive = CanonEdge::new("e-a", "s", "t", "rel", EdgeKind::WorldFact);
        e_assertive.modality = Modality::Assertive;
        let mut e_belief = CanonEdge::new("e-b", "s", "t", "rel", EdgeKind::WorldFact);
        e_belief.modality = Modality::Belief;
        let mut e_hyp = CanonEdge::new("e-h", "s", "t", "rel", EdgeKind::WorldFact);
        e_hyp.modality = Modality::Hypothesis;
        let all = vec![e_assertive, e_belief, e_hyp];

        // 仅选 belief/hypothesis（非断言模态单挑）
        let sel = CanonEdgeFilter {
            modalities: Some(vec![Modality::Belief, Modality::Hypothesis]),
            ..Default::default()
        }
        .select(&all);
        let ids: Vec<&str> = sel.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["e-b", "e-h"]);

        // None 过滤：全部保留。
        assert_eq!(CanonEdgeFilter::default().select(&all).len(), 3);
    }
}
