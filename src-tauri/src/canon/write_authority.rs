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
//! - **C-001**：`.novel/status.json` 是运行时唯一真源 —— 外部来源（技能包 / 同步 / 抓取）
//!   **不得**对其取 `Allow`。
//! - **C-002**：AI 与外部产物先进 Draft 域，accept 后才回填正式正文与正式记忆。
//! - **C-006 / C-007**：外部时间事实落 `QM/raw/`，运行时缓存落 `.novel/market/`，
//!   用户资产本体落**项目外**的资产域，项目内只存引用。
//! - **硬否决**：不新增第二同步引擎、不新增在线技能市场、不引入可执行脚本通道。
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
}

impl WriteSource {
    /// 稳定标识（审计与日志用；不随代码重构漂移）。
    pub fn as_str(self) -> &'static str {
        match self {
            WriteSource::UserEdit => "user_edit",
            WriteSource::AiSuggestion => "ai_suggestion",
            WriteSource::SkillImport => "skill_import",
            WriteSource::SyncPull => "sync_pull",
            WriteSource::ExternalFetch => "external_fetch",
        }
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
    }
}

/// 权限判定主入口：给定来源与目标路径，返回三态判定。
pub fn may_write(source: WriteSource, target: &Path) -> WriteDecision {
    decision_for(source, classify_target(target))
}

/// 机检不变量（硬规则的单一断言点）：
/// 1. `SkillImport` / `SyncPull` / `ExternalFetch` 对真源四类（`QM/`、`canon`、
///    `.novel/status.json`、`.novel/schema.md`）**永不为 `Allow`**；
/// 2. `ExternalFetch` 对任何 canon 目标**恒为 `Deny``；
/// 3. `AiSuggestion` 对真源四类与用户资产引用**永不为 `Allow``。
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
                &p("C:/Users/me/.qmai/user-assets/skill_bundle/a/1.0.0")
            ),
            WriteDecision::RequireGate
        );
        // 项目内资产路径仍不得成为技能包直写落点。
        assert_eq!(
            may_write(WriteSource::SkillImport, &p(".qmai/user-assets/pkg/a")),
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
                &p(".qmai/user-assets/pkg/a.nbskill.json")
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
            classify_target(&p("C:/Users/me/.qmai/user-assets/skill_bundle/a.json")),
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
        let sources = [
            WriteSource::UserEdit,
            WriteSource::AiSuggestion,
            WriteSource::SkillImport,
            WriteSource::SyncPull,
            WriteSource::ExternalFetch,
        ];
        let targets = ALL_WRITE_TARGETS;
        for source in sources {
            for target in targets {
                let decision = decision_for(source, target);
                assert!(matches!(
                    decision,
                    WriteDecision::Allow | WriteDecision::RequireGate | WriteDecision::Deny
                ));
            }
        }
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
