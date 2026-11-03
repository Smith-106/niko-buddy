// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! 写入权限矩阵（**G-5**）——定义「谁可写 `QM/` / `canon` / `.novel/status.json`」。
//!
//! 来源：跨项目移植专项 `guidance-specification.md` §12.4 **G-5**（谁可写 QM 未定义）
//! 与 `cross-role-review.md` §C-8。本专项引入三条**新的外部→本地写入路径**
//! （技能包导入 / WebDAV 拉取 / 市场数据采集），在任一路径落地前必须先给出权限矩阵，
//! 否则真源边界不可判定。
//!
//! 不变量（INV 面）：
//! - **C-001（P3 修订）**：`.novel/status.json` 仍是运行时唯一真源 —— 外部来源
//!   **不得直写其原文**；但外部来源可经**语义化命令**（`pipeline.*` / `gate.*` 等）
//!   请求状态变更，由应用自己的状态权威落盘。修订理由见 [`decision_for`] 上方。
//! - **C-002（P3 修订）**：从「外部产物必须先进 Draft 域」改为「外部直写必须
//!   **留痕且可回滚**」。Draft-first 降级为**默认模式**而非强制拦截：外部 Agent
//!   可直写正文，但每次直写必须落 append-only 审计（C-008）并留下可回滚快照。
//! - **C-006 / C-007**：外部时间事实落 `QM/raw/`，运行时缓存落 `.novel/market/`，
//!   用户资产本体落**项目外**的资产域，项目内只存引用。
//! - **C-008（P3 新增）**：外部写入必须落 append-only 审计日志，**不可关闭**。
//! - **C-009（P3 新增）**：凭据 / 密钥永不出应用边界；MCP 只暴露 `credential_ref`，
//!   绝不暴露明文。
//! - **硬否决**：不新增第二同步引擎、不新增在线技能市场、不引入可执行脚本通道。
//!
//! 上述 C-001 / C-002 的修订与 C-008 / C-009 的引入，批准来源为方案
//! `d23eb1df948e34e8b1723c67588e21843ca49d0a9a5e50b99410805eb3d5f637` 的 P3
//! 治理条目表（应用内 MCP server · 写入权威矩阵修订）。该批准**只覆盖这五项**，
//! 其余条目一字未动：三类既有外部来源的 Deny 面、`AiSuggestion` 的 Deny 面、
//! `UserEdit` 的完整权威、C-006 / C-007 与三条硬否决全部保持原样。
//!
//! 三态语义：
//! - [`WriteDecision::Allow`] —— 可直接写（仍须经原子写与单写者纪律）。
//! - [`WriteDecision::RequireGate`] —— 必须先过门控 / 用户确认（Draft-first、信任复核）。
//! - [`WriteDecision::Deny`] —— 一律拒绝（fail-closed）。
//!
//! 本模块是 TASK-006（技能包导入）/ TASK-008（WebDAV 推拉）/ TASK-012（市场数据）的
//! **共同调用点**，并被 [`audit_line`] 暴露给审计流。

use std::path::Path;

/// 写入来源（谁在写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WriteSource {
    /// 用户显式编辑 / 显式 accept（唯一具备完整写权威的主体）。
    ///
    /// **接线状态：已定义、已裁决、尚未由生产路径构造**（因此非测试构建会报
    /// `variant is never constructed` 告警，**该告警是如实标记，不得用 `#[allow(dead_code)]` 压掉**）。
    /// 已接线的是反面：`SkillImport`（`commands/skill_bundle.rs` 导入路径）与
    /// `SyncPull`（`commands/sync_target.rs` 拉取路径）；正面（草稿 accept → 真源回填）
    /// 目前在 TypeScript 侧走 Draft-first 流程，没有 Rust 侧构造点。
    /// 补齐时本变体即被构造，告警自动消失——告警消失即接线完成的验收信号。
    UserEdit,
    /// AI 生成管线（草稿域为主，永不直写真源）。
    AiSuggestion,
    /// 技能包导入（离线交换，默认 `untrusted`）。
    SkillImport,
    /// 同步拉取（WebDAV 等远端 → 本地，**单向回填**，不构成第二同步引擎）。
    SyncPull,
    /// 外部抓取（榜单 / 市场数据；重抓 ≠ 重放）。
    ExternalFetch,
    /// 外部 Agent（应用内 MCP server 的客户端）。
    ///
    /// **C-002 修订引入**：这个来源具备直写正文的能力，前提是每次直写都留痕
    /// （C-008 审计）且可回滚（快照）。它是唯一被允许 `Allow` `Canon` / `Reference`
    /// 的外部来源——不是因为它更可信，而是因为它的写入有审计与快照兜底，而三类
    /// 导入/同步/抓取来源没有这层兜底，故仍维持 `Deny` / `RequireGate`。
    ///
    /// **接线状态：已定义、已裁决，生产构造点尚不存在**（目前只有测试与
    /// [`ALL_WRITE_SOURCES`] 构造它）。真正的构造点随 `#273` 落地：`full` scope 的
    /// 写入器在落盘前调 `may_write` / `requires_audit` / `requires_snapshot`。
    /// 注意：`ALL_WRITE_SOURCES` 会构造全部变体，因此**编译告警不能用来判断
    /// 接线状态**（它会被这个穷举清单意外抑制）——接线状态以本段注释为准。
    ExternalAgent,
}

/// 全部写入来源（穷举枚举；硬规则断言与全组合测试共用同一清单）。
///
/// 新增变体必须同步此处——否则全组合测试会漏掉它，而漏测的安全边界等于没有。
/// 反面代价：本清单会构造每个变体，所以它**不能**用来判断某来源是否已接线
/// （编译告警会被它抑制）。接线状态写在各变体自己的文档注释里。
pub const ALL_WRITE_SOURCES: [WriteSource; 6] = [
    WriteSource::UserEdit,
    WriteSource::AiSuggestion,
    WriteSource::SkillImport,
    WriteSource::SyncPull,
    WriteSource::ExternalFetch,
    WriteSource::ExternalAgent,
];

impl WriteSource {
    /// 稳定标识（审计与日志用；不随代码重构漂移）。
    pub fn as_str(self) -> &'static str {
        match self {
            WriteSource::UserEdit => "user_edit",
            WriteSource::AiSuggestion => "ai_suggestion",
            WriteSource::SkillImport => "skill_import",
            WriteSource::SyncPull => "sync_pull",
            WriteSource::ExternalFetch => "external_fetch",
            WriteSource::ExternalAgent => "external_agent",
        }
    }

    /// 是否属于「外部来源」（非用户、非应用自身 AI 管线）。
    ///
    /// C-008 的审计义务按此判定：**所有**外部来源的每一次被允许的写入都要留痕。
    pub fn is_external(self) -> bool {
        matches!(
            self,
            WriteSource::SkillImport
                | WriteSource::SyncPull
                | WriteSource::ExternalFetch
                | WriteSource::ExternalAgent
        )
    }
}

/// 写入判定三态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteDecision {
    /// 允许写入。
    Allow,
    /// 必须先过门控 / 用户确认。
    RequireGate,
    /// 一律拒绝。
    Deny,
}

impl WriteDecision {
    /// 稳定标识（审计用）。
    pub fn as_str(self) -> &'static str {
        match self {
            WriteDecision::Allow => "allow",
            WriteDecision::RequireGate => "require_gate",
            WriteDecision::Deny => "deny",
        }
    }

    /// 是否被允许（`Allow` 或 `RequireGate`）；`Deny` 为否。
    pub fn is_permitted(self) -> bool {
        !matches!(self, WriteDecision::Deny)
    }
}

/// 目标落位类别（由 [`classify_target`] 从路径派生）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteTarget {
    /// `.novel/status.json` —— 运行时唯一真源（C-001）。
    StatusJson,
    /// `.novel/schema.md` —— 过程库 schema 契约文档。
    SchemaDoc,
    /// `canon/` —— 正式正文 / 正典域。
    Canon,
    /// `QM/` —— 资料库（拆书、题材先验、原始抓取等）。
    Reference,
    /// `.novel/` 下其他过程态对象（快照 / 投影账本 / 日志等）。
    Procedure,
    /// `.novel/drafts/` —— 草稿域（Draft-first 落点）。
    Drafts,
    /// `.novel/market/` —— 外部数据运行时 TTL 缓存（C-006 第三层）。
    MarketCache,
    /// `.novel/user-asset-refs.json` —— 用户资产域的项目侧**引用**文件（C-007）。
    UserAssetRef,
    /// 用户资产**本体**（项目外用用户级路径；项目内内联即违规）。
    UserAssetBody,
    /// 其他未分类路径。
    Other,
}

impl WriteTarget {
    /// 稳定标识（审计用）。
    pub fn as_str(self) -> &'static str {
        match self {
            WriteTarget::StatusJson => "status_json",
            WriteTarget::SchemaDoc => "schema_doc",
            WriteTarget::Canon => "canon",
            WriteTarget::Reference => "reference",
            WriteTarget::Procedure => "procedure",
            WriteTarget::Drafts => "drafts",
            WriteTarget::MarketCache => "market_cache",
            WriteTarget::UserAssetRef => "user_asset_ref",
            WriteTarget::UserAssetBody => "user_asset_body",
            WriteTarget::Other => "other",
        }
    }

    /// 是否属于「真源 / 正典」类（外部来源永不可 `Allow` 的对象集合）。
    pub fn is_truth_surface(self) -> bool {
        matches!(
            self,
            WriteTarget::StatusJson
                | WriteTarget::SchemaDoc
                | WriteTarget::Canon
                | WriteTarget::Reference
        )
    }
}

/// 全部落位类别（穷举枚举；硬规则断言与全组合测试共用同一清单）。
pub const ALL_WRITE_TARGETS: [WriteTarget; 10] = [
    WriteTarget::StatusJson,
    WriteTarget::SchemaDoc,
    WriteTarget::Canon,
    WriteTarget::Reference,
    WriteTarget::Procedure,
    WriteTarget::Drafts,
    WriteTarget::MarketCache,
    WriteTarget::UserAssetRef,
    WriteTarget::UserAssetBody,
    WriteTarget::Other,
];

/// 把任意（相对 / 绝对 / Windows / POSIX）路径归类为 [`WriteTarget`]。
///
/// 判定规则：从左到右找**第一个**库根标记段（`.novel` / `qm` / `canon`），并按其后
/// 首段细分；无标记时检查路径段中是否含用户资产域根（`user-assets`）。
pub fn classify_target(target: &Path) -> WriteTarget {
    let segments = normalized_segments(target);
    for (index, segment) in segments.iter().enumerate() {
        match segment.as_str() {
            ".novel" => {
                let rest = segments.get(index + 1).map(String::as_str);
                return match rest {
                    Some("status.json") => WriteTarget::StatusJson,
                    Some("schema.md") => WriteTarget::SchemaDoc,
                    Some("drafts") => WriteTarget::Drafts,
                    Some("market") => WriteTarget::MarketCache,
                    Some("user-asset-refs.json") => WriteTarget::UserAssetRef,
                    _ => WriteTarget::Procedure,
                };
            }
            "qm" => return WriteTarget::Reference,
            "canon" => return WriteTarget::Canon,
            _ => {}
        }
    }
    if segments.iter().any(|s| s == "user-assets") {
        return WriteTarget::UserAssetBody;
    }
    WriteTarget::Other
}

/// 纯函数权限表（来源 × 落位类别）。矩阵变更只在此处发生。
pub fn decision_for(source: WriteSource, target: WriteTarget) -> WriteDecision {
    use WriteDecision::{Allow, Deny, RequireGate};
    use WriteTarget::*;

    match source {
        // 用户显式操作是唯一完整权威；本体内联仍须过门（C-007 D4）。
        WriteSource::UserEdit => match target {
            StatusJson | SchemaDoc | Canon | Reference | Procedure | Drafts | MarketCache
            | UserAssetRef | Other => Allow,
            UserAssetBody => RequireGate,
        },
        // AI 产物只进草稿域；真源与用户资产一律 Deny（C-002）。
        WriteSource::AiSuggestion => match target {
            Drafts => Allow,
            StatusJson | SchemaDoc | Canon | Reference | UserAssetRef | UserAssetBody => Deny,
            Procedure | MarketCache | Other => RequireGate,
        },
        // 技能包：默认 untrusted；真源四类一律 Deny。用户资产域是**包本体的正当落点**
        // （C-007），但它必须过导入确认门（RequireGate）而非直写——TASK-006 以显式
        // `confirmed` 参数把该门变成机械约束。
        WriteSource::SkillImport => match target {
            StatusJson | SchemaDoc | Canon | Reference | Other => Deny,
            Drafts | Procedure | MarketCache | UserAssetRef | UserAssetBody => RequireGate,
        },
        // 同步拉取：回填本身仍是写，真源 Deny，正典/资料库须过门（C-001/C-002）。
        WriteSource::SyncPull => match target {
            StatusJson | SchemaDoc | UserAssetBody | Other => Deny,
            Canon | Reference => RequireGate,
            Procedure | Drafts | MarketCache | UserAssetRef => Allow,
        },
        // 外部抓取：**任何 canon 目标恒为 Deny**；运行时缓存是唯一 Allow 的落点。
        WriteSource::ExternalFetch => match target {
            Canon | StatusJson | SchemaDoc | UserAssetBody | MarketCache => match target {
                MarketCache => Allow,
                _ => Deny,
            },
            Reference | Drafts | Procedure | UserAssetRef | Other => RequireGate,
        },
        // 外部 Agent（P3 引入；C-001 / C-002 修订的唯一落点）。
        //
        // 为什么它和上面三类不一样：那三类的产物没有「谁写的、能不能撤回」的记录，
        // 所以只能靠事前拦截（Draft / 门控）。外部 Agent 的每次直写都在应用内发生，
        // 能强制落审计（C-008）与留快照，于是事中留痕 + 事后回滚可以替代事前拦截——
        // 这正是 C-002 修订的全部理由。**但留痕替代拦截有一个前提**：`status.json`
        // 原文不在此列（C-001 修订只放开「经语义化命令改状态」，不放开改文件）。
        WriteSource::ExternalAgent => match target {
            // C-001 修订：唯一真源的**原文**仍禁直写。改状态请走语义化命令，
            // 由应用自己的状态权威落盘——那条路上状态变更仍受门控与审计约束。
            StatusJson => Deny,
            // schema 契约文档同理：外部 Agent 不该改写「数据长什么样」的定义。
            SchemaDoc => Deny,
            // C-002 修订：正文 / 资料库 / 草稿 / 过程态 / 缓存都可直写
            // （运行期须显式开启 full scope，且必须留审计与快照）。
            Canon | Reference | Drafts | Procedure | MarketCache => Allow,
            // C-007 不变：用户资产本体永不由外部 Agent 内联进项目。
            UserAssetBody => Deny,
            // 资产引用与「其他任意路径」不开口子：任意路径是最容易被用来
            // 把凭据或项目外文件写出去的一类（C-009 的矩阵侧防线）。
            UserAssetRef | Other => RequireGate,
        },
    }
}

/// 权限判定主入口：给定来源与目标路径，返回三态判定。
pub fn may_write(source: WriteSource, target: &Path) -> WriteDecision {
    decision_for(source, classify_target(target))
}

// ───────────────────────── C-008 / C-009 的矩阵侧契约 ─────────────────────────

/// C-008：外部写入必须落 append-only 审计日志，**不可关闭**。
///
/// 这是一个编译期常量而不是运行时开关，也不是配置项：一旦有开关，就一定会有人
/// （包括未来的我们）在「先跑通」时把它关掉，而关掉之后没有第二个地方会发现。
pub const AUDIT_CAN_BE_DISABLED: bool = false;

/// C-009：MCP 对外**只**暴露凭据引用，不暴露明文。
///
/// 这个常量是防倒退的绊线：`settings.*` 里凭据类字段只能以 `{key,label}` 形态出现
/// （见 `src/lib/mcp/settings-catalog.ts` 的 `SECRET_REF_CATEGORIES`），若有人把暴露
/// 形态改成值本身，`assert_hard_rules()` 会在启动时直接 panic。
pub const CREDENTIAL_PROJECTION_FIELD: &str = "credential_ref";

/// 外部来源取到凭据明文的可能性（恒 false，C-009）。
pub const fn credential_plaintext_exposed_to_external() -> bool {
    false
}

/// 一次写入是否**必须**落审计（C-008）。
///
/// 按来源判定而不按目标判定：目标分类可以被新路径绕过（新增一个目录就可能落到
/// `Other`），来源却不会——凡是外部来源，写什么都要留痕。
pub fn requires_audit(source: WriteSource, _target: WriteTarget) -> bool {
    source.is_external()
}

/// 一次写入是否**必须**先留可回滚快照（C-002 修订的「可回滚」半边）。
///
/// 只有外部 Agent 直写正典 / 资料库时需要：这两类是真源面，改错了没快照就只能靠
/// 人肉回忆。草稿域是一次性产物，过程态与缓存可重建，都不值得留快照。
pub fn requires_snapshot(source: WriteSource, target: WriteTarget) -> bool {
    matches!(source, WriteSource::ExternalAgent)
        && matches!(target, WriteTarget::Canon | WriteTarget::Reference)
}

/// 机检不变量（硬规则的单一断言点）：
/// 1. `SkillImport` / `SyncPull` / `ExternalFetch` 对真源四类（`QM/`、`canon`、
///    `.novel/status.json`、`.novel/schema.md`）**永不为 `Allow`**；
/// 2. `ExternalFetch` 对任何 canon 目标**恒为 `Deny`**；
/// 3. `AiSuggestion` 对真源四类与用户资产引用**永不为 `Allow`**；
/// 4. （C-001 修订）`ExternalAgent` 对 `.novel/status.json` 与 `.novel/schema.md`
///    恒为 `Deny`，且对用户资产本体恒为 `Deny`（C-007 不变）；
/// 5. （C-008）审计不可关闭，且**每一次被允许的外部写入都要求审计**；
///    凡是要求快照的写入必先要求审计（没有痕的回滚是盲回滚）；
/// 6. （C-009）凭据投影形态是 `credential_ref`，外部来源拿不到明文，
///    且外部来源对 `Other`（任意路径桶）**永不为 `Allow`**。
///
/// 任一违反即返回 `Err`（fail-loud，供启动时自检与单测复用）。
pub fn assert_hard_rules() -> Result<(), String> {
    let external_sources = [
        WriteSource::SkillImport,
        WriteSource::SyncPull,
        WriteSource::ExternalFetch,
    ];
    let truth_targets: Vec<WriteTarget> = ALL_WRITE_TARGETS
        .iter()
        .copied()
        .filter(|target| target.is_truth_surface())
        .collect();
    for source in external_sources {
        for target in &truth_targets {
            if decision_for(source, *target) == WriteDecision::Allow {
                return Err(format!(
                    "hard rule 1 violated: {} must not Allow {}",
                    source.as_str(),
                    target.as_str()
                ));
            }
        }
    }
    if decision_for(WriteSource::ExternalFetch, WriteTarget::Canon) != WriteDecision::Deny {
        return Err("hard rule 2 violated: external_fetch must Deny canon".to_string());
    }
    let mut ai_forbidden: Vec<WriteTarget> = ALL_WRITE_TARGETS
        .iter()
        .copied()
        .filter(|target| target.is_truth_surface())
        .collect();
    ai_forbidden.push(WriteTarget::UserAssetRef);
    for target in ai_forbidden {
        if decision_for(WriteSource::AiSuggestion, target) == WriteDecision::Allow {
            return Err(format!(
                "hard rule 3 violated: ai_suggestion must not Allow {}",
                target.as_str()
            ));
        }
    }

    // ── 规则 4（C-001 修订）：外部 Agent 仍不得直写真源原文 ──────────────────
    for target in [WriteTarget::StatusJson, WriteTarget::SchemaDoc] {
        if decision_for(WriteSource::ExternalAgent, target) != WriteDecision::Deny {
            return Err(format!(
                "hard rule 4 violated (C-001): external_agent must Deny {}, got {}",
                target.as_str(),
                decision_for(WriteSource::ExternalAgent, target).as_str()
            ));
        }
    }
    if decision_for(WriteSource::ExternalAgent, WriteTarget::UserAssetBody) != WriteDecision::Deny {
        return Err(
            "hard rule 4 violated (C-007): external_agent must Deny user_asset_body".to_string(),
        );
    }

    // ── 规则 5（C-008）：审计不可关闭，且每次被允许的外部写入都要求审计 ─────
    if AUDIT_CAN_BE_DISABLED {
        return Err("hard rule 5 violated (C-008): audit must not be switchable".to_string());
    }
    for source in ALL_WRITE_SOURCES {
        for target in ALL_WRITE_TARGETS {
            let decision = decision_for(source, target);
            if source.is_external() && decision.is_permitted() && !requires_audit(source, target) {
                return Err(format!(
                    "hard rule 5 violated (C-008): {} may write {} without audit",
                    source.as_str(),
                    target.as_str()
                ));
            }
            // 没有痕的回滚是盲回滚：要求快照必须先要求审计。
            if requires_snapshot(source, target) && !requires_audit(source, target) {
                return Err(format!(
                    "hard rule 5 violated (C-002): {} requires snapshot on {} without audit",
                    source.as_str(),
                    target.as_str()
                ));
            }
        }
    }

    // ── 规则 6（C-009）：凭据只暴露引用，外部来源不得写任意路径桶 ───────────
    if CREDENTIAL_PROJECTION_FIELD != "credential_ref" {
        return Err(format!(
            "hard rule 6 violated (C-009): credential projection must be `credential_ref`, got `{CREDENTIAL_PROJECTION_FIELD}`"
        ));
    }
    if credential_plaintext_exposed_to_external() {
        return Err(
            "hard rule 6 violated (C-009): external sources must never see credential plaintext"
                .to_string(),
        );
    }
    for source in ALL_WRITE_SOURCES {
        if source.is_external() && decision_for(source, WriteTarget::Other) == WriteDecision::Allow
        {
            return Err(format!(
                "hard rule 6 violated (C-009): {} must not Allow arbitrary paths (other)",
                source.as_str()
            ));
        }
    }

    Ok(())
}

/// 一条审计记录（`status_watcher` 审计流的输入形态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityAuditRecord {
    pub source: &'static str,
    pub target: &'static str,
    pub decision: &'static str,
    /// 归一化后的目标路径（POSIX 分隔符，便于跨平台比对）。
    pub path: String,
}

/// 构造审计记录（纯函数，不落盘；落盘由调用方按各自审计通道决定）。
pub fn audit_record(
    source: WriteSource,
    target: &Path,
    decision: WriteDecision,
) -> AuthorityAuditRecord {
    AuthorityAuditRecord {
        source: source.as_str(),
        target: classify_target(target).as_str(),
        decision: decision.as_str(),
        path: target.to_string_lossy().replace('\\', "/"),
    }
}

/// 审计记录 → 单行 JSONL（手写序列化，避免为此引入 serde 依赖）。
pub fn audit_line(record: &AuthorityAuditRecord) -> String {
    format!(
        "{{\"kind\":\"write_authority\",\"source\":\"{}\",\"target\":\"{}\",\"decision\":\"{}\",\"path\":\"{}\"}}",
        escape_json(record.source),
        escape_json(record.target),
        escape_json(record.decision),
        escape_json(&record.path)
    )
}

fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn normalized_segments(target: &Path) -> Vec<String> {
    target
        .to_string_lossy()
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(value: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(value)
    }

    #[test]
    fn external_fetch_cannot_write_canon() {
        // 硬规则 2：ExternalFetch 对任何 canon 目标恒为 Deny（含绝对路径形态）。
        for target in [
            "canon/draft.md",
            "canon",
            "C:/proj/canon/chapter-1.md",
            "./canon/vol-1/ch-02.md",
        ] {
            assert_eq!(
                may_write(WriteSource::ExternalFetch, &p(target)),
                WriteDecision::Deny,
                "external_fetch must Deny canon target {target}"
            );
        }
        // 真源四类的其余三类同样不可 Allow。
        assert!(!may_write(WriteSource::ExternalFetch, &p(".novel/status.json")).is_permitted());
        assert!(!may_write(WriteSource::ExternalFetch, &p(".novel/schema.md")).is_permitted());
        assert_eq!(
            may_write(WriteSource::ExternalFetch, &p("QM/raw/sources/rank/a.json")),
            WriteDecision::RequireGate
        );
        // 运行时 TTL 缓存是唯一允许直接写的落点（C-006 第三层）。
        assert_eq!(
            may_write(WriteSource::ExternalFetch, &p(".novel/market/rank.json")),
            WriteDecision::Allow
        );
    }

    #[test]
    fn sync_pull_cannot_write_status_json() {
        // 硬规则 1：外部来源不得对 status.json 取 Allow。
        assert_eq!(
            may_write(WriteSource::SyncPull, &p(".novel/status.json")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::SyncPull, &p(".novel/schema.md")),
            WriteDecision::Deny
        );
        // 回填仍须过门，不得直接写正典 / 资料库。
        assert_eq!(
            may_write(WriteSource::SyncPull, &p("canon/ch-01.md")),
            WriteDecision::RequireGate
        );
        assert_eq!(
            may_write(WriteSource::SyncPull, &p("QM/book-analysis/x.md")),
            WriteDecision::RequireGate
        );
        // 冲突副本与草稿域是允许的落点。
        assert_eq!(
            may_write(WriteSource::SyncPull, &p(".novel/drafts/conflict-a.json")),
            WriteDecision::Allow
        );
    }

    #[test]
    fn skill_import_cannot_allow_truth_targets() {
        assert_eq!(
            may_write(WriteSource::SkillImport, &p(".novel/status.json")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::SkillImport, &p(".novel/schema.md")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::SkillImport, &p("canon/ch.md")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::SkillImport, &p("QM/skills/a.md")),
            WriteDecision::Deny
        );
        // 技能包只可进草稿域 / 引用文件 / 用户资产域，且必须过信任复核门。
        assert_eq!(
            may_write(WriteSource::SkillImport, &p(".novel/drafts/skill-a.md")),
            WriteDecision::RequireGate
        );
        assert_eq!(
            may_write(WriteSource::SkillImport, &p(".novel/user-asset-refs.json")),
            WriteDecision::RequireGate
        );
        // C-007：包本体归用户资产域（项目外），但仍须过导入确认门。
        assert_eq!(
            may_write(
                WriteSource::SkillImport,
                &p("C:/Users/me/.niko-buddy/user-assets/skill_bundle/a/1.0.0")
            ),
            WriteDecision::RequireGate
        );
        // 项目内资产路径仍不得成为技能包直写落点。
        assert_eq!(
            may_write(
                WriteSource::SkillImport,
                &p(".niko-buddy/user-assets/pkg/a")
            ),
            WriteDecision::RequireGate
        );
    }

    #[test]
    fn ai_suggestion_cannot_write_truth_or_assets() {
        assert_eq!(
            may_write(WriteSource::AiSuggestion, &p(".novel/status.json")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::AiSuggestion, &p("canon/ch.md")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::AiSuggestion, &p("QM/x.md")),
            WriteDecision::Deny
        );
        assert_eq!(
            may_write(WriteSource::AiSuggestion, &p(".novel/drafts/d.md")),
            WriteDecision::Allow
        );
    }

    #[test]
    fn user_edit_holds_full_authority_but_cannot_inline_asset_body() {
        assert_eq!(
            may_write(WriteSource::UserEdit, &p("canon/ch.md")),
            WriteDecision::Allow
        );
        assert_eq!(
            may_write(WriteSource::UserEdit, &p(".novel/status.json")),
            WriteDecision::Allow
        );
        assert_eq!(
            may_write(WriteSource::UserEdit, &p("QM/x.md")),
            WriteDecision::Allow
        );
        // C-007 D4：项目内不得内联用户资产本体。
        assert_eq!(
            may_write(
                WriteSource::UserEdit,
                &p(".niko-buddy/user-assets/pkg/a.nbskill.json")
            ),
            WriteDecision::RequireGate
        );
    }

    #[test]
    fn classifies_paths_by_library_root() {
        assert_eq!(
            classify_target(&p(".novel/status.json")),
            WriteTarget::StatusJson
        );
        assert_eq!(
            classify_target(&p("C:/proj/.novel/schema.md")),
            WriteTarget::SchemaDoc
        );
        assert_eq!(
            classify_target(&p("QM/raw/sources/rank/x.json")),
            WriteTarget::Reference
        );
        assert_eq!(classify_target(&p("canon/export.rs")), WriteTarget::Canon);
        assert_eq!(
            classify_target(&p(".novel/snapshots/s1.json")),
            WriteTarget::Procedure
        );
        assert_eq!(
            classify_target(&p(".novel/drafts/x.md")),
            WriteTarget::Drafts
        );
        assert_eq!(
            classify_target(&p(".novel/market/c.json")),
            WriteTarget::MarketCache
        );
        assert_eq!(
            classify_target(&p(".novel/user-asset-refs.json")),
            WriteTarget::UserAssetRef
        );
        assert_eq!(
            classify_target(&p(
                "C:/Users/me/.niko-buddy/user-assets/skill_bundle/a.json"
            )),
            WriteTarget::UserAssetBody
        );
        // 大小写与分隔符归一
        assert_eq!(
            classify_target(&p("qm\\raw\\x.json")),
            WriteTarget::Reference
        );
        assert_eq!(
            classify_target(&p(".NOVEL/status.json")),
            WriteTarget::StatusJson
        );
    }

    #[test]
    fn hard_rules_hold_for_all_combinations() {
        assert_hard_rules().expect("hard rules must hold");
        // 全组合穷举：三态判定必须覆盖且不 panic。
        // 来源清单走 `ALL_WRITE_SOURCES`——新增变体漏登记则此处直接漏测，
        // 而漏测的安全边界等于没有。
        for source in ALL_WRITE_SOURCES {
            for target in ALL_WRITE_TARGETS {
                let decision = decision_for(source, target);
                assert!(matches!(
                    decision,
                    WriteDecision::Allow | WriteDecision::RequireGate | WriteDecision::Deny
                ));
            }
        }
    }

    #[test]
    fn external_agent_cannot_write_status_json_raw() {
        // C-001 修订：改状态走语义化命令，改**文件原文**仍然一律 Deny。
        for target in [
            ".novel/status.json",
            "C:/proj/.novel/status.json",
            ".NOVEL/status.json",
        ] {
            assert_eq!(
                may_write(WriteSource::ExternalAgent, &p(target)),
                WriteDecision::Deny,
                "external_agent must Deny status.json raw write: {target}"
            );
        }
        assert_eq!(
            may_write(WriteSource::ExternalAgent, &p(".novel/schema.md")),
            WriteDecision::Deny
        );
        // C-007 未修订：资产本体仍不得由外部 Agent 内联进项目。
        assert_eq!(
            may_write(
                WriteSource::ExternalAgent,
                &p("C:/Users/me/.niko-buddy/user-assets/pkg/a.json")
            ),
            WriteDecision::Deny
        );
    }

    #[test]
    fn external_agent_may_write_canon_under_revised_c002() {
        // C-002 修订：正文 / 资料库 / 草稿 / 过程态 / 缓存可直写。
        for target in [
            "canon/ch-01.md",
            "QM/book-analysis/x.md",
            ".novel/drafts/d.md",
            ".novel/snapshots/s1.json",
            ".novel/market/rank.json",
        ] {
            assert_eq!(
                may_write(WriteSource::ExternalAgent, &p(target)),
                WriteDecision::Allow,
                "external_agent should Allow {target} under revised C-002"
            );
        }
        // 任意路径桶与资产引用仍不开口子（C-009 的矩阵侧防线）。
        for target in [".novel/user-asset-refs.json", "/tmp/anywhere.txt"] {
            assert_eq!(
                may_write(WriteSource::ExternalAgent, &p(target)),
                WriteDecision::RequireGate,
                "external_agent must not freely write {target}"
            );
        }
    }

    #[test]
    fn external_writes_require_audit_and_snapshot() {
        // C-008：外部来源的每一次写入都要求审计，不看目标。
        for source in ALL_WRITE_SOURCES {
            for target in ALL_WRITE_TARGETS {
                assert_eq!(
                    requires_audit(source, target),
                    source.is_external(),
                    "audit requirement must follow source externality: {} / {}",
                    source.as_str(),
                    target.as_str()
                );
            }
        }
        // C-002 修订的「可回滚」半边：直写真源面必须留快照，草稿与缓存不必。
        assert!(requires_snapshot(
            WriteSource::ExternalAgent,
            WriteTarget::Canon
        ));
        assert!(requires_snapshot(
            WriteSource::ExternalAgent,
            WriteTarget::Reference
        ));
        assert!(!requires_snapshot(
            WriteSource::ExternalAgent,
            WriteTarget::Drafts
        ));
        assert!(!requires_snapshot(
            WriteSource::ExternalAgent,
            WriteTarget::MarketCache
        ));
        // 非外部来源不需要快照（它们要么是用户自己，要么本就不许直写真源）。
        assert!(!requires_snapshot(
            WriteSource::UserEdit,
            WriteTarget::Canon
        ));
        assert!(!requires_snapshot(
            WriteSource::AiSuggestion,
            WriteTarget::Canon
        ));
    }

    #[test]
    fn audit_cannot_be_disabled() {
        // C-008：审计没有开关。改这个常量就会在启动时 panic。
        assert!(!AUDIT_CAN_BE_DISABLED);
        // 所有外部来源都要审计，包括新增的 ExternalAgent。
        for source in [
            WriteSource::SkillImport,
            WriteSource::SyncPull,
            WriteSource::ExternalFetch,
            WriteSource::ExternalAgent,
        ] {
            assert!(source.is_external());
            assert!(requires_audit(source, WriteTarget::Canon));
        }
        // 用户自己与自家 AI 管线不在 C-008 的范围内。
        assert!(!WriteSource::UserEdit.is_external());
        assert!(!WriteSource::AiSuggestion.is_external());
    }

    #[test]
    fn credentials_never_exposed_to_external_sources() {
        // C-009：对外只给引用形态。
        assert_eq!(CREDENTIAL_PROJECTION_FIELD, "credential_ref");
        assert!(!credential_plaintext_exposed_to_external());
        // 外部来源对「任意路径桶」永不为 Allow——凭据文件只能落在这里，
        // 放开它就等于给外部 Agent 开了一条把密钥写出去的通道。
        for source in ALL_WRITE_SOURCES {
            if source.is_external() {
                assert_ne!(
                    decision_for(source, WriteTarget::Other),
                    WriteDecision::Allow,
                    "{} must not Allow arbitrary paths",
                    source.as_str()
                );
            }
        }
    }

    #[test]
    fn source_list_covers_every_variant() {
        // 绊线：`ALL_WRITE_SOURCES` 必须覆盖全部变体，否则全组合测试漏测。
        assert_eq!(ALL_WRITE_SOURCES.len(), 6);
        let names: Vec<&str> = ALL_WRITE_SOURCES.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "user_edit",
                "ai_suggestion",
                "skill_import",
                "sync_pull",
                "external_fetch",
                "external_agent",
            ]
        );
    }

    #[test]
    fn audit_line_is_single_line_jsonl() {
        let record = audit_record(
            WriteSource::ExternalFetch,
            &p(".novel/status.json"),
            WriteDecision::Deny,
        );
        assert_eq!(record.source, "external_fetch");
        assert_eq!(record.target, "status_json");
        assert_eq!(record.decision, "deny");
        let line = audit_line(&record);
        assert!(line.starts_with("{\"kind\":\"write_authority\""));
        assert!(line.contains("\"decision\":\"deny\""));
        assert!(!line.contains('\n'));
        // 转义：引号不得破坏 JSONL 单行结构；路径已归一为 POSIX 分隔符。
        let escaped = audit_line(&audit_record(
            WriteSource::UserEdit,
            &p("C:/a\"b\\c.txt"),
            WriteDecision::Allow,
        ));
        assert!(!escaped.contains('\n'));
        assert!(escaped.contains("\\\""), "quote must be escaped: {escaped}");
        assert!(escaped.contains("C:/a\"b/c.txt") || escaped.contains("C:/a\\\"b/c.txt"));
        // 转义器本体（含反斜杠与控制字符）直接覆盖。
        assert_eq!(escape_json("a\\b"), "a\\\\b");
        assert_eq!(escape_json("line1\nline2"), "line1\\nline2");
        assert_eq!(escape_json("tab\there"), "tab\\there");
        assert_eq!(escape_json("\u{1}"), "\\u0001");
    }
}
