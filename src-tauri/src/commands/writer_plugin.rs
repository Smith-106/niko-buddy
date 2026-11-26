// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

//! Pure-declarative `niko-buddy-writer` plugin manager for Google Antigravity workspaces.
//!
//! ## Compliance & Security Invariants (C-007 + Google Antigravity ToS)
//! 1. **100% Declarative**: embedded plugin assets contain ONLY `.json` and `.md` files —
//!    ZERO executable scripts, ZERO `hooks.json`, ZERO shell wrappers.
//! 2. **Zero Config Pollution**: NEVER reads or modifies `~/.gemini/config/config.json`.
//! 3. **Zero Code-Repo Overhead (Isolated Default)**: project sync installs the shared plugin
//!    bundle into `<home>/.niko-buddy/agy-plugin/niko-buddy-writer/` (outside
//!    `~/.gemini/config/plugins/`) and links only the target novel project via a thin
//!    `<projectPath>/.agents/plugins.json` entry + bounded `AGENTS.md` marker block.
//! 4. **Optional Global Install (Disabled by Default)**: `writer_plugin_install_global`
//!    defaults to `enable = false` (`"disabled": true` in `plugin.json`) so unrelated code
//!    repositories incur zero idle prompt overhead unless explicitly enabled by the user.
//! 5. **Draft-first & Role Separation**: declarative playbooks document `[RO]` read-only
//!    roles (`canon-auditor`, `literary-critic`), whose actual write prohibition is enforced
//!    externally by the MCP `reviewer` profile + `SessionScope::Read`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::antigravity_acp::{clean_display_path, detect_parent_code_repo_warning};
use super::fs::{lock_file_mutations, write_atomic_physical_bytes};
use super::local_cli_config::resolve_home_dir;
use crate::agent_gate_policy::{
    assert_no_symlink_in_ancestors, metadata_is_symlink_or_reparse_point,
};

pub const WRITER_PLUGIN_NAME: &str = "niko-buddy-writer";
pub const WRITER_PLUGIN_VERSION: &str = "1.0.0";
const WRITER_PLUGIN_AUTHOR: &str = "Niko Buddy";
const WRITER_PLUGIN_DESCRIPTION: &str = "Pure-declarative long-form novel writing workspace plugin for Antigravity + Niko Buddy MCP (Draft-first, zero-LLM mechanical gates, 6 skills, 5 editorial role playbooks).";

const ISOLATED_PLUGIN_ROOT_REF: &str = "~/.niko-buddy/agy-plugin";
const MARKER_START: &str = "<!-- niko-buddy-writer:start -->";
const MARKER_VERSION_PREFIX: &str = "<!-- niko-buddy-writer:version=";
const MARKER_VERSION_SUFFIX: &str = " -->";
const MARKER_END: &str = "<!-- niko-buddy-writer:end -->";

const ENABLE_GLOBAL_COMMAND: &str = "agy plugin enable niko-buddy-writer";
const DISABLE_GLOBAL_COMMAND: &str = "agy plugin disable niko-buddy-writer";

const RULES_AGENTS_MD: &str = r#"# Niko Buddy Writing Workspace Rules

This workspace is a long-form fiction project managed by **Niko Buddy**, not a software repository. Stay strictly inside narrative planning, drafting, editing, and review workflows.

## Safety Boundaries
- **Draft-first**: Save drafts only via `chapter.write`. Never overwrite formal chapters or formal memory directly, and never expect a `draft.accept` tool — the author reviews and accepts drafts inside Niko Buddy.
- **Gate Priority**: `Consistency(P0) > Anti-AI(P1) > Quality(P2)`. Literary polish never overrides a P0 canon or continuity failure.
- **Zero-LLM Subscription Loop**: Use `context.prepare_write` + `rules.get(compact:true)` -> author with the host subscription model -> `chapter.write` -> `gate.check_mechanical(draftId, detailLevel:"compact")`. Avoid legacy internal LLM pipelines.

## Skills (`skills/*/SKILL.md`)
- `nb-book-architect` — Premise, volumes, outlines, and characters
- `nb-chapter-draft` — End-to-end chapter drafting and mechanical preflight
- `nb-consistency-audit` — Read-only P0 canon and continuity audit
- `nb-de-ai-polish` — Anti-AI prose polish preserving canon facts
- `nb-six-dim-review` — Read-only six-dimension literary review
- `nb-story-ops` — Workspace state, draft queue, and director diagnostics

## Declarative Editorial Playbooks (`agents/*.md`)
- `novel-architect` (`architect` / `writer-sub`)
- `novel-writer` (`writer-sub`)
- `canon-auditor` `[RO]`
- `de-ai-stylist` (`writer-sub`)
- `literary-critic` `[RO]`

`[RO]` enforcement for `canon-auditor` and `literary-critic` comes from MCP `reviewer` profile + `SessionScope::Read` (declarative playbooks alone do not enforce write permissions).
"#;

const SKILL_BOOK_ARCHITECT: &str = r#"---
name: nb-book-architect
description: Plan novel premises, volume arcs, outlines, and character ledgers using zero-LLM Niko Buddy MCP tools.
---

# Book Architect Workflow

Use this skill when designing or updating book setup, volume outlines, or character ledgers in Niko Buddy.

## Recommended MCP Profile
- `architect` or `writer-sub` with `SessionScope::Project`.

## Steps
1. Inspect current setup gates and state with `director.check`, `project.state`, and `rules.get(compact:true)`.
2. Query established canon facts with `canon.query` and list existing chapters/drafts via `chapter.list` and `draft.list`.
3. Assemble planning context via `context.prepare_write(includePlanningView:true)` when expanding an ongoing book.
4. Author structured outlines or character cards directly using the host subscription model — do not invoke legacy internal LLM generators.
5. Persist planning artifacts safely with `outline.write` (safe `.md` filename under `wiki/outlines/`) and `character.upsert`.
6. Never write formal chapters or formal memory directly. Keep narrative changes aligned with `Consistency(P0) > Anti-AI(P1) > Quality(P2)`.
"#;

const SKILL_CHAPTER_DRAFT: &str = r#"---
name: nb-chapter-draft
description: Draft a novel chapter in Niko Buddy using zero-LLM context prep, Draft-first saving, and mechanical preflight.
---

# Chapter Drafting Workflow

Use this skill to write a new chapter or revise an active draft with zero internal API LLM calls.

## Recommended MCP Profile
- `writer-sub` with `SessionScope::Project`.

## Steps
1. Call `context.prepare_write(targetChapter: N, includePlanningView: true, retrievalMode: "local_only")` to load planning context, recent continuity, and target chapter framing.
2. Call `rules.get(compact: true)` to retrieve active writing style, anti-AI rules, book rules, and planning guidance.
3. Call `canon.query` for key entities or knowledge boundaries involved in the scene.
4. Draft the full chapter prose directly in the host subscription model while honoring voice, pacing, and character knowledge constraints.
5. Save the draft with `chapter.write(chapterName, content)`. This writes ONLY to `.qm-drafts` (Draft-first).
6. Run `gate.check_mechanical(draftId, detailLevel: "compact")` to verify zero-LLM P0 Continuity preflight, BookRules, and P1 Anti-AI checks.
7. Fix any P0/P1 findings in a new `chapter.write` pass and re-run `gate.check_mechanical` until clean.
8. Remind the author to review and accept the draft inside Niko Buddy (never expect a `draft.accept` tool).
"#;

const SKILL_CONSISTENCY_AUDIT: &str = r#"---
name: nb-consistency-audit
description: Run read-only P0 continuity, canon, and timeline audits on drafts or chapters without modifying project files.
---

# Consistency Audit Workflow (Read-Only)

Use this skill to perform a strict P0 continuity and canon verification pass.

## Recommended MCP Profile
- `reviewer` with `SessionScope::Read` (strictly zero write tools).

## Steps
1. Locate the target via `draft.list` + `draft.read` or `chapter.list` + `chapter.read`.
2. Run `gate.check_mechanical(draftId|chapter, detailLevel: "full")` to collect deterministic P0 Continuity preflight and BookRules diagnostics (when auditing raw `text`, always pass `chapterNumber`).
3. Cross-check character knowledge boundaries, locations, injuries, items, and timeline order using `canon.query` and `context.inspect`.
4. Report findings ordered strictly by `Consistency(P0) > Anti-AI(P1) > Quality(P2)` with exact quote locations, violated canon facts, and concrete repair instructions.
5. Never write or modify project files during an audit.
"#;

const SKILL_DE_AI_POLISH: &str = r#"---
name: nb-de-ai-polish
description: Remove AI prose tells and repetitive rhythm from a draft while preserving canon facts and P0 continuity.
---

# De-AI Prose Polish Workflow

Use this skill to refine prose texture and eliminate AI writing habits without breaking story continuity.

## Recommended MCP Profile
- `writer-sub` with `SessionScope::Project`.

## Steps
1. Fetch active style and anti-AI rules via `rules.get(sections: ["writingStyle", "antiAi"], compact: true)`.
2. Read the target draft via `draft.read` and inspect flagged tells via `gate.check_mechanical(draftId, detailLevel: "full")`.
3. Rewrite flagged passages to restore natural sentence cadence, concrete sensory detail, and character-specific dialogue while keeping every canon fact, timeline marker, and plot beat intact.
4. Save the polished revision into the draft area via `chapter.write` (Draft-first).
5. Re-run `gate.check_mechanical(draftId, detailLevel: "compact")` to confirm both P0 Continuity and P1 Anti-AI pass — never trade P0 continuity for style.
"#;

const SKILL_SIX_DIM_REVIEW: &str = r#"---
name: nb-six-dim-review
description: Evaluate a chapter or draft across six dimensions (thrill, consistency, pacing, character, continuity, pull).
---

# Six-Dimension Literary Review Workflow (Read-Only)

Use this skill to produce a structured diagnostic review across Niko Buddy's six literary dimensions.

## Recommended MCP Profile
- `reviewer` with `SessionScope::Read` (strictly zero write tools).

## Steps
1. Run `gate.check_mechanical(draftId|chapter, detailLevel: "compact")` first to establish the Track A hard gate (`Consistency(P0)` and `Anti-AI(P1)`).
2. Read the chapter or draft via `chapter.read` / `draft.read` and inspect framing via `context.inspect` or `context.prepare_write` for any requested dimension (`thrill`, `consistency`, `pacing`, `character`, `continuity`, `pull`).
3. Evaluate each dimension with grounded textual evidence and actionable revision priorities.
4. Keep Track A (P0/P1 hard gates) strictly separate from Track B (literary quality scores): a high literary score never overrides a P0 consistency failure.
5. Never modify files during review.
"#;

const SKILL_STORY_OPS: &str = r#"---
name: nb-story-ops
description: Inspect novel workspace health, draft queue, director phase gates, and active MCP profile or scope status.
---

# Story Operations Diagnostic Workflow (Read-Only)

Use this skill for fast read-only situational awareness before starting a writing or editing session.

## Recommended MCP Profile
- `reviewer`, `architect`, or `writer-sub` (`SessionScope::Read` is sufficient).

## Steps
1. Call `app.status` to confirm the active MCP `scope`, frozen `profile`, and server version.
2. Call `project.state` and `director.check` to read `.novel/status.json` progress, current chapter, and any blocked director gates.
3. Call `chapter.list` and `draft.list` to inspect published chapters vs. pending drafts awaiting author acceptance.
4. Summarize next recommended actions clearly without mutating any project state.
"#;

const AGENT_NOVEL_ARCHITECT: &str = r#"# Role Playbook: Novel Architect

Declarative editorial-room persona for book structure, worldbuilding, outlines, and character ledgers.

## Recommended Session Binding
- MCP Profile: `architect` (or `writer-sub`)
- MCP Scope: `project`

## Responsibilities
- Audit setup readiness with `director.check`, `project.state`, and `rules.get(compact:true)`.
- Check canon invariants via `canon.query` before revising arcs or character sheets.
- Author outlines and character docs directly with the host model and save via `outline.write` and `character.upsert`.

## Boundaries
- Never bypass Draft-first or touch formal chapters/memory.
- Keep `Consistency(P0) > Anti-AI(P1) > Quality(P2)` binding across all volume and chapter plans.
"#;

const AGENT_NOVEL_WRITER: &str = r#"# Role Playbook: Novel Writer

Declarative editorial-room persona for scene-level long-form chapter drafting.

## Recommended Session Binding
- MCP Profile: `writer-sub`
- MCP Scope: `project`

## Responsibilities
- Prepare context before writing via `context.prepare_write(targetChapter, includePlanningView:true)` and `rules.get(compact:true)`.
- Check character knowledge and world facts via `canon.query`.
- Draft full chapters in the host subscription model and save strictly to `.qm-drafts` via `chapter.write`.
- Self-check every draft via `gate.check_mechanical(draftId, detailLevel:"compact")` and fix P0/P1 issues before handoff.

## Boundaries
- Draft-first: never write formal chapters or formal memory directly; the human author accepts drafts in Niko Buddy.
"#;

const AGENT_CANON_AUDITOR: &str = r#"# Role Playbook: Canon Auditor [RO]

Strictly **read-only** editorial-room persona for P0 continuity, canon ledger, and timeline verification.

## Security Enforcement Note
- `[RO]` write prohibition is enforced externally by binding this session to MCP profile `reviewer` + `SessionScope::Read` (zero write tools exposed). Do not attempt any file or project mutation.

## Responsibilities
- Read drafts/chapters via `draft.list`, `draft.read`, `chapter.list`, `chapter.read`.
- Query canon edges via `canon.query` and inspect full context via `context.inspect`.
- Run `gate.check_mechanical(draftId|chapter, detailLevel:"full")` (include `chapterNumber` for raw `text`).
- Deliver precise P0 continuity findings with citations and surgical repair suggestions.
"#;

const AGENT_DE_AI_STYLIST: &str = r#"# Role Playbook: De-AI Stylist

Declarative editorial-room persona for prose naturalness, voice differentiation, and anti-AI polishing.

## Recommended Session Binding
- MCP Profile: `writer-sub`
- MCP Scope: `project`

## Responsibilities
- Load active prose guidelines via `rules.get(sections:["writingStyle","antiAi"], compact:true)`.
- Inspect draft text via `draft.read` and mechanical tells via `gate.check_mechanical(draftId, detailLevel:"full")`.
- Rewrite AI clichés and monotonous sentence patterns while preserving 100% of canon facts, character knowledge, and plot beats.
- Save polished drafts via `chapter.write` and re-verify via `gate.check_mechanical(draftId, detailLevel:"compact")`.

## Boundaries
- Never alter established canon facts for stylistic flair; `Consistency(P0)` always outranks `Anti-AI(P1)` and `Quality(P2)`.
"#;

const AGENT_LITERARY_CRITIC: &str = r#"# Role Playbook: Literary Critic [RO]

Strictly **read-only** editorial-room persona for six-dimension literary critique (`thrill`, `consistency`, `pacing`, `character`, `continuity`, `pull`).

## Security Enforcement Note
- `[RO]` write prohibition is enforced externally by binding this session to MCP profile `reviewer` + `SessionScope::Read` (zero write tools exposed). Do not attempt any file or project mutation.

## Responsibilities
- Verify Track A hard gate status first via `gate.check_mechanical(draftId|chapter, detailLevel:"compact")`.
- Read chapter/draft text and dimension prompts via `chapter.read`, `draft.read`, `context.inspect`, and `context.prepare_write`.
- Score and critique all six dimensions with concrete line-level evidence and prioritized rewrite guidance.
- Respect gate priority: literary quality scores never override a P0 consistency failure.
"#;

const PROJECT_AGENTS_MD_BLOCK: &str = r#"<!-- niko-buddy-writer:start -->
<!-- niko-buddy-writer:version=1.0.0 -->
# Niko Buddy Novel Workspace
This directory is a long-form fiction project managed by Niko Buddy (not a code repository).
- Use the `niko-buddy-writer` plugin (`.agents/plugins.json`) and Niko Buddy MCP (`writer-sub` / `reviewer` / `architect`).
- Draft-first: save drafts via `chapter.write`; never directly overwrite formal chapters or formal memory.
- Gate priority: `Consistency(P0) > Anti-AI(P1) > Quality(P2)`.
<!-- niko-buddy-writer:end -->"#;

const PROJECT_CLAUDE_MD_BLOCK: &str = r#"<!-- niko-buddy-writer:start -->
<!-- niko-buddy-writer:version=1.0.0 -->
@AGENTS.md
<!-- niko-buddy-writer:end -->"#;

const STATIC_PLUGIN_MARKDOWN_FILES: [(&str, &str); 12] = [
    ("rules/AGENTS.md", RULES_AGENTS_MD),
    ("skills/nb-book-architect/SKILL.md", SKILL_BOOK_ARCHITECT),
    ("skills/nb-chapter-draft/SKILL.md", SKILL_CHAPTER_DRAFT),
    (
        "skills/nb-consistency-audit/SKILL.md",
        SKILL_CONSISTENCY_AUDIT,
    ),
    ("skills/nb-de-ai-polish/SKILL.md", SKILL_DE_AI_POLISH),
    ("skills/nb-six-dim-review/SKILL.md", SKILL_SIX_DIM_REVIEW),
    ("skills/nb-story-ops/SKILL.md", SKILL_STORY_OPS),
    ("agents/novel-architect.md", AGENT_NOVEL_ARCHITECT),
    ("agents/novel-writer.md", AGENT_NOVEL_WRITER),
    ("agents/canon-auditor.md", AGENT_CANON_AUDITOR),
    ("agents/de-ai-stylist.md", AGENT_DE_AI_STYLIST),
    ("agents/literary-critic.md", AGENT_LITERARY_CRITIC),
];

const SKILL_COUNT: usize = 6;
const AGENT_COUNT: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriterPluginStatus {
    pub plugin_name: String,
    pub plugin_version: String,
    pub declarative_only: bool,
    pub skill_count: usize,
    pub agent_count: usize,
    pub isolated_plugin_path: String,
    pub isolated_plugin_up_to_date: bool,
    pub project_path: Option<String>,
    pub project_state: String,
    pub project_version: Option<String>,
    pub project_has_claude_md: bool,
    pub global_installed: bool,
    pub global_enabled: bool,
    pub global_up_to_date: bool,
    pub global_path: Option<String>,
    pub parent_code_repo_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriterPluginSyncResult {
    pub ok: bool,
    pub plugin_name: String,
    pub plugin_version: String,
    pub project_path: String,
    pub include_claude_md: bool,
    pub written_files: Vec<String>,
    pub unchanged_files: Vec<String>,
    pub agents_md_preserved_user_content: bool,
    pub parent_code_repo_warning: Option<String>,
    pub status: WriterPluginStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriterPluginGlobalResult {
    pub ok: bool,
    pub plugin_name: String,
    pub plugin_version: String,
    pub install_path: String,
    pub enabled: bool,
    pub disabled: bool,
    pub written_files: Vec<String>,
    pub unchanged_files: Vec<String>,
    pub enable_command: String,
    pub disable_command: String,
}

fn render_plugin_manifest(disabled: Option<bool>) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("name".to_string(), json!(WRITER_PLUGIN_NAME));
    obj.insert("author".to_string(), json!(WRITER_PLUGIN_AUTHOR));
    obj.insert("version".to_string(), json!(WRITER_PLUGIN_VERSION));
    obj.insert("description".to_string(), json!(WRITER_PLUGIN_DESCRIPTION));
    if let Some(flag) = disabled {
        obj.insert("disabled".to_string(), json!(flag));
    }
    let mut out =
        serde_json::to_string_pretty(&Value::Object(obj)).unwrap_or_else(|_| "{}".to_string());
    out.push('\n');
    out
}

fn build_plugin_bundle(disabled: Option<bool>) -> Vec<(String, String)> {
    let mut files = Vec::with_capacity(1 + STATIC_PLUGIN_MARKDOWN_FILES.len());
    files.push(("plugin.json".to_string(), render_plugin_manifest(disabled)));
    for (rel, body) in STATIC_PLUGIN_MARKDOWN_FILES {
        files.push((rel.to_string(), body.to_string()));
    }
    files
}

fn isolated_plugin_dir(home: &Path) -> PathBuf {
    home.join(".niko-buddy")
        .join("agy-plugin")
        .join(WRITER_PLUGIN_NAME)
}

fn global_plugin_dir(home: &Path) -> PathBuf {
    home.join(".gemini")
        .join("config")
        .join("plugins")
        .join(WRITER_PLUGIN_NAME)
}

fn validate_existing_dir_root(raw: &str, label: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.trim().is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if raw.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(format!(
            "{label} must not contain NUL or control characters"
        ));
    }
    let normalized_slashes = raw.replace('\\', "/");
    if normalized_slashes.split('/').any(|seg| seg == "..") {
        return Err(format!("{label} must not contain '..' traversal segments"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path: {raw}"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!(
            "{label} must not contain parent traversal components"
        ));
    }
    // Strip any trailing separator (and trailing `.`) so `symlink_metadata` inspects
    // the directory entry itself instead of traversing a symlink/junction root.
    let normalized: PathBuf = path.components().collect();
    let meta = fs::symlink_metadata(&normalized)
        .map_err(|e| format!("{label} does not exist or cannot be inspected: {e}"))?;
    if metadata_is_symlink_or_reparse_point(&meta) {
        return Err(format!(
            "{label} must not be a symlink or reparse point: {}",
            clean_display_path(&normalized)
        ));
    }
    if !meta.is_dir() {
        return Err(format!(
            "{label} must be an existing directory: {}",
            clean_display_path(&normalized)
        ));
    }
    let canonical = fs::canonicalize(&normalized)
        .map_err(|e| format!("Failed to canonicalize {label}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!(
            "{label} is not a directory: {}",
            clean_display_path(&canonical)
        ));
    }
    Ok(canonical)
}

fn probe_dir_writable(dir: &Path, label: &str) -> Result<(), String> {
    let probe_name = format!(
        ".nb-write-probe-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let probe_path = dir.join(probe_name);
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
        .map_err(|e| format!("{label} is not writable ({}): {e}", clean_display_path(dir)))?;
    drop(file);
    let _ = fs::remove_file(&probe_path);
    Ok(())
}

fn read_regular_file_if_present(root: &Path, target: &Path) -> Result<Option<Vec<u8>>, String> {
    assert_no_symlink_in_ancestors(root, target)?;
    match fs::symlink_metadata(target) {
        Ok(meta) => {
            if metadata_is_symlink_or_reparse_point(&meta) {
                return Err(format!(
                    "Symlink or reparse point rejected: {}",
                    clean_display_path(target)
                ));
            }
            if !meta.is_file() {
                return Err(format!(
                    "Expected regular file but found non-file: {}",
                    clean_display_path(target)
                ));
            }
            let bytes = fs::read(target)
                .map_err(|e| format!("Failed to read '{}': {e}", clean_display_path(target)))?;
            Ok(Some(bytes))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "Failed to inspect '{}': {e}",
            clean_display_path(target)
        )),
    }
}

fn write_managed_file(
    root: &Path,
    target: &Path,
    content: &[u8],
    written_files: &mut Vec<String>,
    unchanged_files: &mut Vec<String>,
) -> Result<(), String> {
    assert_no_symlink_in_ancestors(root, target)?;
    if let Some(parent) = target.parent() {
        assert_no_symlink_in_ancestors(root, parent)?;
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create directory '{}': {e}",
                clean_display_path(parent)
            )
        })?;
    }
    assert_no_symlink_in_ancestors(root, target)?;

    let display = clean_display_path(target);
    if let Some(existing) = read_regular_file_if_present(root, target)? {
        if existing == content {
            unchanged_files.push(display);
            return Ok(());
        }
    }
    write_atomic_physical_bytes(target, content)?;
    written_files.push(display);
    Ok(())
}

fn write_plugin_bundle(
    home_root: &Path,
    plugin_dir: &Path,
    disabled: Option<bool>,
    written_files: &mut Vec<String>,
    unchanged_files: &mut Vec<String>,
) -> Result<(), String> {
    assert_no_symlink_in_ancestors(home_root, plugin_dir)?;
    fs::create_dir_all(plugin_dir).map_err(|e| {
        format!(
            "Failed to create plugin directory '{}': {e}",
            clean_display_path(plugin_dir)
        )
    })?;
    assert_no_symlink_in_ancestors(home_root, plugin_dir)?;
    probe_dir_writable(plugin_dir, "Plugin directory")?;

    for (rel_path, body) in build_plugin_bundle(disabled) {
        let mut target = plugin_dir.to_path_buf();
        for seg in rel_path.split('/') {
            target.push(seg);
        }
        write_managed_file(
            home_root,
            &target,
            body.as_bytes(),
            written_files,
            unchanged_files,
        )?;
    }
    Ok(())
}

fn is_plugin_bundle_up_to_date(
    home_root: &Path,
    plugin_dir: &Path,
    disabled: Option<bool>,
) -> bool {
    if assert_no_symlink_in_ancestors(home_root, plugin_dir).is_err() {
        return false;
    }
    for (rel_path, expected_body) in build_plugin_bundle(disabled) {
        let mut target = plugin_dir.to_path_buf();
        for seg in rel_path.split('/') {
            target.push(seg);
        }
        match read_regular_file_if_present(home_root, &target) {
            Ok(Some(actual)) if actual == expected_body.as_bytes() => {}
            _ => return false,
        }
    }
    true
}

/// Merge `{"path": "~/.niko-buddy/agy-plugin"}` into `<projectPath>/.agents/plugins.json`.
/// Fail-closed on malformed JSON, non-object root, or non-array `"entries"`.
pub(crate) fn merge_project_plugins_json(existing: Option<&str>) -> Result<String, String> {
    match existing {
        None => {
            let doc = json!({
                "entries": [
                    { "path": ISOLATED_PLUGIN_ROOT_REF }
                ]
            });
            let mut out = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
            out.push('\n');
            Ok(out)
        }
        Some(raw) => {
            let mut doc: Value = serde_json::from_str(raw).map_err(|e| {
                format!(
                    "Existing .agents/plugins.json is malformed JSON (refusing to overwrite): {e}"
                )
            })?;
            let root = doc.as_object_mut().ok_or_else(|| {
                "Existing .agents/plugins.json root must be a JSON object (refusing to overwrite)"
                    .to_string()
            })?;
            let entries_val = root
                .entry("entries".to_string())
                .or_insert_with(|| json!([]));
            let entries = entries_val.as_array_mut().ok_or_else(|| {
                "Existing .agents/plugins.json `entries` must be a JSON array (refusing to overwrite)"
                    .to_string()
            })?;
            let already_present = entries.iter().any(|entry| {
                entry.get("path").and_then(Value::as_str) == Some(ISOLATED_PLUGIN_ROOT_REF)
            });
            if already_present {
                return Ok(raw.to_string());
            }
            entries.push(json!({ "path": ISOLATED_PLUGIN_ROOT_REF }));
            let mut out = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
            out.push('\n');
            Ok(out)
        }
    }
}

fn project_plugins_json_has_entry(raw: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    doc.as_object()
        .and_then(|o| o.get("entries"))
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("path").and_then(Value::as_str) == Some(ISOLATED_PLUGIN_ROOT_REF)
            })
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MarkerInspect<'a> {
    Absent,
    Valid {
        start: usize,
        end_exclusive: usize,
        block: &'a str,
        version: Option<String>,
    },
    Malformed(String),
}

fn inspect_marker_block<'a>(raw: &'a str, file_label: &str) -> MarkerInspect<'a> {
    let starts: Vec<usize> = raw.match_indices(MARKER_START).map(|(i, _)| i).collect();
    let ends: Vec<usize> = raw.match_indices(MARKER_END).map(|(i, _)| i).collect();
    if starts.is_empty() && ends.is_empty() {
        return MarkerInspect::Absent;
    }
    if starts.len() > 1 || ends.len() > 1 {
        return MarkerInspect::Malformed(format!(
            "{file_label} contains duplicate `{MARKER_START}`/`{MARKER_END}` markers; fix manually before syncing"
        ));
    }
    if starts.len() != ends.len() {
        return MarkerInspect::Malformed(format!(
            "{file_label} contains mismatched `{MARKER_START}`/`{MARKER_END}` markers; fix manually before syncing"
        ));
    }
    let start = starts[0];
    let end = ends[0];
    if end < start + MARKER_START.len() {
        return MarkerInspect::Malformed(format!(
            "{file_label} contains reversed `{MARKER_END}` before `{MARKER_START}`; fix manually before syncing"
        ));
    }
    let end_exclusive = end + MARKER_END.len();
    let block = &raw[start..end_exclusive];
    let version = block.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix(MARKER_VERSION_PREFIX)
            .and_then(|rest| rest.strip_suffix(MARKER_VERSION_SUFFIX))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    });
    MarkerInspect::Valid {
        start,
        end_exclusive,
        block,
        version,
    }
}

/// Non-destructive marker-block merge preserving user text before/after markers.
/// Fail-closed on duplicate, mismatched, or reversed markers.
pub(crate) fn merge_marker_block(
    existing: Option<&str>,
    managed_block: &str,
    file_label: &str,
) -> Result<(String, bool), String> {
    let Some(raw) = existing else {
        return Ok((format!("{managed_block}\n"), false));
    };

    match inspect_marker_block(raw, file_label) {
        MarkerInspect::Malformed(err) => Err(err),
        MarkerInspect::Valid {
            start,
            end_exclusive,
            ..
        } => {
            let before = &raw[..start];
            let after = &raw[end_exclusive..];
            let preserved = !before.trim().is_empty() || !after.trim().is_empty();
            let mut merged =
                String::with_capacity(before.len() + managed_block.len() + after.len() + 1);
            merged.push_str(before);
            merged.push_str(managed_block);
            merged.push_str(after);
            if after.is_empty() && !merged.ends_with('\n') {
                merged.push('\n');
            }
            Ok((merged, preserved))
        }
        MarkerInspect::Absent => {
            if raw.trim().is_empty() {
                return Ok((format!("{managed_block}\n"), false));
            }
            let mut merged = raw.to_string();
            if !merged.ends_with('\n') {
                merged.push('\n');
            }
            merged.push('\n');
            merged.push_str(managed_block);
            merged.push('\n');
            Ok((merged, true))
        }
    }
}

/// Inspect isolated plugin status, optional project sync state, and optional global install status.
pub(crate) fn status_in(
    home: &Path,
    project_path: Option<&str>,
) -> Result<WriterPluginStatus, String> {
    let home_root = validate_existing_dir_root(&home.to_string_lossy(), "homeDir")?;
    let isolated_dir = isolated_plugin_dir(&home_root);
    let isolated_up_to_date = is_plugin_bundle_up_to_date(&home_root, &isolated_dir, None);

    let global_dir = global_plugin_dir(&home_root);
    let global_manifest_path = global_dir.join("plugin.json");
    let (global_installed, global_enabled, global_up_to_date, global_path) =
        match read_regular_file_if_present(&home_root, &global_manifest_path) {
            Ok(Some(manifest_bytes)) => {
                let parsed = serde_json::from_slice::<Value>(&manifest_bytes).ok();
                let enabled = parsed
                    .as_ref()
                    .and_then(|v| v.get("disabled"))
                    .and_then(Value::as_bool)
                    .map(|disabled| !disabled)
                    .unwrap_or_else(|| parsed.is_some());
                let up_to_date = parsed.is_some()
                    && is_plugin_bundle_up_to_date(&home_root, &global_dir, Some(!enabled));
                (
                    true,
                    enabled,
                    up_to_date,
                    Some(clean_display_path(&global_dir)),
                )
            }
            _ => (false, false, false, None),
        };

    let trimmed_project = project_path.map(str::trim).filter(|s| !s.is_empty());
    let (resolved_project_path, project_state, project_version, project_has_claude_md, parent_warn) =
        if let Some(raw_proj) = trimmed_project {
            let proj_root = validate_existing_dir_root(raw_proj, "projectPath")?;
            let warning = detect_parent_code_repo_warning(&proj_root);

            let plugins_json_path = proj_root.join(".agents").join("plugins.json");
            let has_plugins_entry =
                match read_regular_file_if_present(&proj_root, &plugins_json_path) {
                    Ok(Some(bytes)) => String::from_utf8(bytes)
                        .map(|s| project_plugins_json_has_entry(&s))
                        .unwrap_or(false),
                    _ => false,
                };

            let agents_md_path = proj_root.join("AGENTS.md");
            let (agents_marker_present, agents_block_up_to_date, project_version) =
                match read_regular_file_if_present(&proj_root, &agents_md_path) {
                    Ok(Some(bytes)) => match String::from_utf8(bytes) {
                        Ok(text) => match inspect_marker_block(&text, "AGENTS.md") {
                            MarkerInspect::Valid { block, version, .. } => {
                                (true, block == PROJECT_AGENTS_MD_BLOCK, version)
                            }
                            MarkerInspect::Malformed(_) => (true, false, None),
                            MarkerInspect::Absent => (false, false, None),
                        },
                        Err(_) => (false, false, None),
                    },
                    _ => (false, false, None),
                };

            let claude_md_path = proj_root.join("CLAUDE.md");
            let (claude_marker_present, claude_block_up_to_date) =
                match read_regular_file_if_present(&proj_root, &claude_md_path) {
                    Ok(Some(bytes)) => match String::from_utf8(bytes) {
                        Ok(text) => match inspect_marker_block(&text, "CLAUDE.md") {
                            MarkerInspect::Valid { block, .. } => {
                                (true, block == PROJECT_CLAUDE_MD_BLOCK)
                            }
                            MarkerInspect::Malformed(_) => (true, false),
                            MarkerInspect::Absent => (false, false),
                        },
                        Err(_) => (false, false),
                    },
                    _ => (false, false),
                };

            let state = if has_plugins_entry && agents_marker_present {
                if isolated_up_to_date
                    && agents_block_up_to_date
                    && project_version.as_deref() == Some(WRITER_PLUGIN_VERSION)
                    && (!claude_marker_present || claude_block_up_to_date)
                {
                    "synced"
                } else {
                    "needs_update"
                }
            } else if has_plugins_entry || agents_marker_present || claude_marker_present {
                "needs_update"
            } else {
                "not_synced"
            };

            (
                Some(clean_display_path(&proj_root)),
                state.to_string(),
                project_version,
                claude_marker_present,
                warning,
            )
        } else {
            (None, "not_synced".to_string(), None, false, None)
        };

    Ok(WriterPluginStatus {
        plugin_name: WRITER_PLUGIN_NAME.to_string(),
        plugin_version: WRITER_PLUGIN_VERSION.to_string(),
        declarative_only: true,
        skill_count: SKILL_COUNT,
        agent_count: AGENT_COUNT,
        isolated_plugin_path: clean_display_path(&isolated_dir),
        isolated_plugin_up_to_date: isolated_up_to_date,
        project_path: resolved_project_path,
        project_state,
        project_version,
        project_has_claude_md,
        global_installed,
        global_enabled,
        global_up_to_date,
        global_path,
        parent_code_repo_warning: parent_warn,
    })
}

/// Sync the shared isolated `niko-buddy-writer` bundle (`<home>/.niko-buddy/agy-plugin/niko-buddy-writer`)
/// and write the thin non-destructive scaffold inside `<projectPath>`.
pub(crate) fn sync_project_in(
    home: &Path,
    project_path: &str,
    include_claude_md: bool,
) -> Result<WriterPluginSyncResult, String> {
    let _mutation = lock_file_mutations()?;
    let home_root = validate_existing_dir_root(&home.to_string_lossy(), "homeDir")?;
    let proj_root = validate_existing_dir_root(project_path.trim(), "projectPath")?;
    probe_dir_writable(&proj_root, "Project directory")?;

    // Pre-validate all existing project files BEFORE mutating anything on disk (fail-closed!).
    let plugins_json_path = proj_root.join(".agents").join("plugins.json");
    let existing_plugins_raw = match read_regular_file_if_present(&proj_root, &plugins_json_path)? {
        Some(bytes) => Some(String::from_utf8(bytes).map_err(|_| {
            "Existing .agents/plugins.json is not valid UTF-8 (refusing to overwrite)".to_string()
        })?),
        None => None,
    };
    let merged_plugins_json = merge_project_plugins_json(existing_plugins_raw.as_deref())?;

    let agents_md_path = proj_root.join("AGENTS.md");
    let existing_agents_raw = match read_regular_file_if_present(&proj_root, &agents_md_path)? {
        Some(bytes) => Some(String::from_utf8(bytes).map_err(|_| {
            "Existing AGENTS.md is not valid UTF-8 (refusing to overwrite)".to_string()
        })?),
        None => None,
    };
    let (merged_agents_md, agents_md_preserved_user_content) = merge_marker_block(
        existing_agents_raw.as_deref(),
        PROJECT_AGENTS_MD_BLOCK,
        "AGENTS.md",
    )?;

    let claude_md_path = proj_root.join("CLAUDE.md");
    let merged_claude_md = if include_claude_md {
        let existing_claude_raw = match read_regular_file_if_present(&proj_root, &claude_md_path)? {
            Some(bytes) => Some(String::from_utf8(bytes).map_err(|_| {
                "Existing CLAUDE.md is not valid UTF-8 (refusing to overwrite)".to_string()
            })?),
            None => None,
        };
        let (merged, _) = merge_marker_block(
            existing_claude_raw.as_deref(),
            PROJECT_CLAUDE_MD_BLOCK,
            "CLAUDE.md",
        )?;
        Some(merged)
    } else {
        None
    };

    let mut written_files = Vec::new();
    let mut unchanged_files = Vec::new();

    // 1. Write/update isolated shared plugin directory (outside ~/.gemini/config/plugins/).
    let isolated_dir = isolated_plugin_dir(&home_root);
    write_plugin_bundle(
        &home_root,
        &isolated_dir,
        None,
        &mut written_files,
        &mut unchanged_files,
    )?;

    // 2. Write thin project scaffold files atomically.
    write_managed_file(
        &proj_root,
        &plugins_json_path,
        merged_plugins_json.as_bytes(),
        &mut written_files,
        &mut unchanged_files,
    )?;
    write_managed_file(
        &proj_root,
        &agents_md_path,
        merged_agents_md.as_bytes(),
        &mut written_files,
        &mut unchanged_files,
    )?;
    if let Some(claude_content) = merged_claude_md {
        write_managed_file(
            &proj_root,
            &claude_md_path,
            claude_content.as_bytes(),
            &mut written_files,
            &mut unchanged_files,
        )?;
    }

    let status = status_in(&home_root, Some(&clean_display_path(&proj_root)))?;
    let parent_code_repo_warning = status.parent_code_repo_warning.clone();

    Ok(WriterPluginSyncResult {
        ok: true,
        plugin_name: WRITER_PLUGIN_NAME.to_string(),
        plugin_version: WRITER_PLUGIN_VERSION.to_string(),
        project_path: clean_display_path(&proj_root),
        include_claude_md,
        written_files,
        unchanged_files,
        agents_md_preserved_user_content,
        parent_code_repo_warning,
        status,
    })
}

/// Optional global install into `<home>/.gemini/config/plugins/niko-buddy-writer/`
/// (defaults to `enable = false` -> `"disabled": true`). NEVER touches `~/.gemini/config/config.json`.
pub(crate) fn install_global_in(
    home: &Path,
    enable: bool,
) -> Result<WriterPluginGlobalResult, String> {
    let _mutation = lock_file_mutations()?;
    let home_root = validate_existing_dir_root(&home.to_string_lossy(), "homeDir")?;
    let global_dir = global_plugin_dir(&home_root);
    let disabled = !enable;

    let mut written_files = Vec::new();
    let mut unchanged_files = Vec::new();

    write_plugin_bundle(
        &home_root,
        &global_dir,
        Some(disabled),
        &mut written_files,
        &mut unchanged_files,
    )?;

    Ok(WriterPluginGlobalResult {
        ok: true,
        plugin_name: WRITER_PLUGIN_NAME.to_string(),
        plugin_version: WRITER_PLUGIN_VERSION.to_string(),
        install_path: clean_display_path(&global_dir),
        enabled: enable,
        disabled,
        written_files,
        unchanged_files,
        enable_command: ENABLE_GLOBAL_COMMAND.to_string(),
        disable_command: DISABLE_GLOBAL_COMMAND.to_string(),
    })
}

fn require_home_dir() -> Result<PathBuf, String> {
    resolve_home_dir().ok_or_else(|| "Unable to resolve user home directory".to_string())
}

#[tauri::command]
pub async fn writer_plugin_status(
    project_path: Option<String>,
) -> Result<WriterPluginStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = require_home_dir()?;
        status_in(&home, project_path.as_deref())
    })
    .await
    .map_err(|e| format!("writer_plugin_status task join error: {e}"))?
}

#[tauri::command]
pub async fn writer_plugin_sync_project(
    project_path: String,
    include_claude_md: Option<bool>,
) -> Result<WriterPluginSyncResult, String> {
    let include_claude = include_claude_md.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let home = require_home_dir()?;
        sync_project_in(&home, &project_path, include_claude)
    })
    .await
    .map_err(|e| format!("writer_plugin_sync_project task join error: {e}"))?
}

#[tauri::command]
pub async fn writer_plugin_install_global(
    enable: Option<bool>,
) -> Result<WriterPluginGlobalResult, String> {
    let enabled = enable.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let home = require_home_dir()?;
        install_global_in(&home, enabled)
    })
    .await
    .map_err(|e| format!("writer_plugin_install_global task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDirGuard(PathBuf);

    impl TempDirGuard {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nb-writer-plugin-{tag}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn embedded_bundle_is_strictly_declarative_and_within_budget() {
        let bundle = build_plugin_bundle(None);
        assert_eq!(
            bundle.len(),
            13,
            "plugin bundle must contain exactly 13 files"
        );
        assert!(
            RULES_AGENTS_MD.len() <= 1800,
            "rules/AGENTS.md must be <= 1800 bytes, got {}",
            RULES_AGENTS_MD.len()
        );
        assert!(
            PROJECT_AGENTS_MD_BLOCK.len() <= 600,
            "project AGENTS.md block must be <= 600 bytes, got {}",
            PROJECT_AGENTS_MD_BLOCK.len()
        );

        let mut skill_count = 0usize;
        let mut agent_count = 0usize;
        let mut total_frontmatter_words = 0usize;

        for (rel_path, content) in &bundle {
            // C-007: strictly ONLY .json and .md, ZERO hooks.json, ZERO scripts!
            assert!(
                rel_path.ends_with(".json") || rel_path.ends_with(".md"),
                "non-declarative file extension rejected: {rel_path}"
            );
            assert!(
                !rel_path.contains("hooks"),
                "hooks artifacts are strictly forbidden: {rel_path}"
            );
            // Zero forbidden ToS flags anywhere in embedded content.
            for forbidden in [
                "agy -p",
                "--dangerously-skip-permissions",
                "--override_user_agent_name",
                "--yolo",
            ] {
                assert!(
                    !content.contains(forbidden),
                    "{rel_path} contains forbidden string `{forbidden}`"
                );
            }

            if rel_path.starts_with("skills/") && rel_path.ends_with("/SKILL.md") {
                skill_count += 1;
                let dir_id = rel_path
                    .strip_prefix("skills/")
                    .and_then(|s| s.strip_suffix("/SKILL.md"))
                    .expect("skill id");
                let mut lines = content.lines();
                assert_eq!(
                    lines.next(),
                    Some("---"),
                    "{rel_path} must start with YAML frontmatter"
                );
                let mut keys = Vec::new();
                let mut parsed_name = None;
                let mut fm_text = String::new();
                for line in lines {
                    if line == "---" {
                        break;
                    }
                    fm_text.push_str(line);
                    fm_text.push(' ');
                    let (k, v) = line
                        .split_once(':')
                        .unwrap_or_else(|| panic!("{rel_path} malformed frontmatter line: {line}"));
                    let key = k.trim();
                    keys.push(key.to_string());
                    if key == "name" {
                        parsed_name = Some(v.trim().to_string());
                    }
                }
                assert_eq!(
                    keys,
                    vec!["name".to_string(), "description".to_string()],
                    "{rel_path} frontmatter must strictly contain ONLY `name` and `description`"
                );
                assert_eq!(parsed_name.as_deref(), Some(dir_id));
                total_frontmatter_words += fm_text.split_whitespace().count();
            } else if rel_path.starts_with("agents/") && rel_path.ends_with(".md") {
                agent_count += 1;
            }
        }

        assert_eq!(skill_count, SKILL_COUNT);
        assert_eq!(agent_count, AGENT_COUNT);
        // Conservative token estimate (~1.5 tokens/word) must stay strictly < 450 idle tokens.
        let estimated_tokens = (total_frontmatter_words * 3).div_ceil(2);
        assert!(
            estimated_tokens < 450,
            "idle frontmatter tokens too high: ~{estimated_tokens} ({total_frontmatter_words} words)"
        );

        // Isolated manifest omits `disabled`; global manifest sets `"disabled": !enable`.
        let isolated_manifest: Value =
            serde_json::from_str(&render_plugin_manifest(None)).expect("manifest json");
        assert_eq!(isolated_manifest["name"], WRITER_PLUGIN_NAME);
        assert_eq!(isolated_manifest["version"], WRITER_PLUGIN_VERSION);
        assert!(isolated_manifest.get("disabled").is_none());

        let global_disabled: Value =
            serde_json::from_str(&render_plugin_manifest(Some(true))).expect("manifest json");
        assert_eq!(global_disabled["disabled"], json!(true));
        let global_enabled: Value =
            serde_json::from_str(&render_plugin_manifest(Some(false))).expect("manifest json");
        assert_eq!(global_enabled["disabled"], json!(false));

        // rules/AGENTS.md must explicitly mention [RO] enforcement comes from MCP reviewer profile + Read scope.
        assert!(RULES_AGENTS_MD.contains("reviewer"));
        assert!(RULES_AGENTS_MD.contains("SessionScope::Read"));
        assert!(RULES_AGENTS_MD.contains("Consistency(P0) > Anti-AI(P1) > Quality(P2)"));
    }

    #[test]
    fn sync_project_is_idempotent_preserves_user_content_and_keeps_global_untouched() {
        let home = TempDirGuard::new("home");
        let project = TempDirGuard::new("novel");

        // Pre-seed user `.agents/plugins.json` and `AGENTS.md` with custom entries & notes.
        fs::create_dir_all(project.0.join(".agents")).unwrap();
        fs::write(
            project.0.join(".agents").join("plugins.json"),
            r#"{"entries":[{"path":"~/my-custom-plugin"}],"extraFlag":true}"#,
        )
        .unwrap();
        fs::write(
            project.0.join("AGENTS.md"),
            "# My Novel World Notes\nKeep magic system grounded.\n",
        )
        .unwrap();

        let before = status_in(&home.0, Some(&project.0.to_string_lossy())).expect("status");
        assert_eq!(before.project_state, "not_synced");
        assert!(!before.isolated_plugin_up_to_date);
        assert!(!before.global_installed);
        assert!(!before.project_has_claude_md);

        // First sync (include_claude_md = false): writes 13 isolated + 2 project = 15 files.
        let sync1 = sync_project_in(&home.0, &project.0.to_string_lossy(), false).expect("sync1");
        assert!(sync1.ok);
        assert_eq!(sync1.written_files.len(), 15);
        assert!(sync1.unchanged_files.is_empty());
        assert!(sync1.agents_md_preserved_user_content);
        assert_eq!(sync1.status.project_state, "synced");
        assert_eq!(
            sync1.status.project_version.as_deref(),
            Some(WRITER_PLUGIN_VERSION)
        );
        assert!(sync1.status.isolated_plugin_up_to_date);
        assert!(!sync1.status.project_has_claude_md);
        assert!(!project.0.join("CLAUDE.md").exists());

        // Global plugins dir and `~/.gemini/config/config.json` must NEVER be created/touched!
        assert!(!home.0.join(".gemini").exists());

        // Verify user entries in `.agents/plugins.json` were preserved.
        let plugins_doc: Value = serde_json::from_str(
            &fs::read_to_string(project.0.join(".agents").join("plugins.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(plugins_doc["extraFlag"], json!(true));
        let entries = plugins_doc["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["path"], json!("~/my-custom-plugin"));
        assert_eq!(entries[1]["path"], json!(ISOLATED_PLUGIN_ROOT_REF));

        // Verify user content in `AGENTS.md` was preserved before marker block.
        let agents_text = fs::read_to_string(project.0.join("AGENTS.md")).unwrap();
        assert!(agents_text.contains("# My Novel World Notes"));
        assert!(agents_text.contains("Keep magic system grounded."));
        assert!(agents_text.contains(MARKER_START));
        assert!(agents_text.contains(MARKER_END));

        // Second sync is 100% idempotent: 0 written, 15 unchanged!
        let sync2 = sync_project_in(&home.0, &project.0.to_string_lossy(), false).expect("sync2");
        assert!(sync2.written_files.is_empty());
        assert_eq!(sync2.unchanged_files.len(), 15);
        assert!(sync2.agents_md_preserved_user_content);
        assert_eq!(sync2.status.project_state, "synced");

        // Sync with `include_claude_md = true` writes only `CLAUDE.md` with `@AGENTS.md`.
        let sync3 = sync_project_in(&home.0, &project.0.to_string_lossy(), true).expect("sync3");
        assert_eq!(sync3.written_files.len(), 1);
        assert_eq!(sync3.unchanged_files.len(), 15);
        assert!(sync3.status.project_has_claude_md);
        let claude_text = fs::read_to_string(project.0.join("CLAUDE.md")).unwrap();
        assert!(claude_text.contains("@AGENTS.md"));
        assert!(claude_text.contains(MARKER_START));
        assert!(claude_text.contains(MARKER_END));

        // Outdated version marker in AGENTS.md triggers `needs_update` and repairs cleanly.
        let stale_agents = agents_text.replace("version=1.0.0", "version=0.9.0");
        fs::write(project.0.join("AGENTS.md"), stale_agents).unwrap();
        let stale_status = status_in(&home.0, Some(&project.0.to_string_lossy())).expect("stale");
        assert_eq!(stale_status.project_state, "needs_update");
        assert_eq!(stale_status.project_version.as_deref(), Some("0.9.0"));
    }

    #[test]
    fn sync_project_fails_closed_on_malformed_json_or_markers_and_bad_paths() {
        let home = TempDirGuard::new("home-fail");
        let project = TempDirGuard::new("novel-fail");

        // 1) Malformed `.agents/plugins.json` fails closed without writing anything.
        fs::create_dir_all(project.0.join(".agents")).unwrap();
        fs::write(project.0.join(".agents").join("plugins.json"), "{bad json").unwrap();
        assert!(sync_project_in(&home.0, &project.0.to_string_lossy(), false).is_err());
        assert!(
            !home.0.join(".niko-buddy").exists(),
            "fail-closed pre-check must prevent partial isolated writes"
        );

        // Non-array `entries` also fails closed.
        fs::write(
            project.0.join(".agents").join("plugins.json"),
            r#"{"entries":"not-an-array"}"#,
        )
        .unwrap();
        assert!(sync_project_in(&home.0, &project.0.to_string_lossy(), false).is_err());
        fs::remove_file(project.0.join(".agents").join("plugins.json")).unwrap();

        // 2) Mismatched / duplicate / reversed markers in `AGENTS.md` fail closed.
        for bad_agents in [
            format!("hello\n{MARKER_START}\nmissing end"),
            format!("hello\n{MARKER_END}\nmissing start"),
            format!("{MARKER_END}\n{MARKER_START}"),
            format!("{MARKER_START}\na\n{MARKER_END}\n{MARKER_START}\nb\n{MARKER_END}"),
        ] {
            fs::write(project.0.join("AGENTS.md"), &bad_agents).unwrap();
            assert!(
                sync_project_in(&home.0, &project.0.to_string_lossy(), false).is_err(),
                "malformed markers must fail closed: {bad_agents}"
            );
        }

        // 3) Bad paths (empty, relative, traversal, control bytes, non-existent) fail closed.
        for bad_path in [
            "",
            "   ",
            "relative/novel",
            "C:\\a\\..\\b",
            "C:\\bad\0path",
            "C:\\bad\npath",
            &project.0.join("does-not-exist").to_string_lossy(),
        ] {
            assert!(
                sync_project_in(&home.0, bad_path, false).is_err(),
                "bad path must fail closed: {bad_path:?}"
            );
        }
    }

    #[test]
    fn install_global_defaults_disabled_toggles_cleanly_and_never_touches_config_json() {
        let home = TempDirGuard::new("home-global");

        // Default install (`enable = false`) writes 13 files with `"disabled": true`.
        let res1 = install_global_in(&home.0, false).expect("install global disabled");
        assert!(res1.ok);
        assert!(!res1.enabled);
        assert!(res1.disabled);
        assert_eq!(res1.written_files.len(), 13);
        assert!(res1.unchanged_files.is_empty());
        assert!(!res1.enable_command.is_empty());
        assert!(!res1.disable_command.is_empty());
        assert!(
            !home
                .0
                .join(".gemini")
                .join("config")
                .join("config.json")
                .exists(),
            "MUST NEVER create or touch ~/.gemini/config/config.json"
        );

        let st1 = status_in(&home.0, None).expect("status after disabled global");
        assert!(st1.global_installed);
        assert!(!st1.global_enabled);
        assert!(st1.global_up_to_date);
        assert_eq!(st1.global_path.as_deref(), Some(res1.install_path.as_str()));

        // Toggle to `enable = true`: updates ONLY `plugin.json`, leaves 12 md files unchanged!
        let res2 = install_global_in(&home.0, true).expect("install global enabled");
        assert!(res2.enabled);
        assert!(!res2.disabled);
        assert_eq!(res2.written_files.len(), 1);
        assert_eq!(res2.unchanged_files.len(), 12);

        let st2 = status_in(&home.0, None).expect("status after enabled global");
        assert!(st2.global_installed);
        assert!(st2.global_enabled);
        assert!(st2.global_up_to_date);
    }

    #[test]
    fn return_structs_serialize_exact_locked_camel_case_contracts() {
        let home = TempDirGuard::new("home-contract");
        let project = TempDirGuard::new("novel-contract");

        let sync = sync_project_in(&home.0, &project.0.to_string_lossy(), true).expect("sync");
        let sync_json = serde_json::to_value(&sync).expect("serialize sync");
        for key in [
            "ok",
            "pluginName",
            "pluginVersion",
            "projectPath",
            "includeClaudeMd",
            "writtenFiles",
            "unchangedFiles",
            "agentsMdPreservedUserContent",
            "parentCodeRepoWarning",
            "status",
        ] {
            assert!(
                sync_json.get(key).is_some(),
                "WriterPluginSyncResult missing key `{key}`: {sync_json}"
            );
        }

        let status_json = &sync_json["status"];
        for key in [
            "pluginName",
            "pluginVersion",
            "declarativeOnly",
            "skillCount",
            "agentCount",
            "isolatedPluginPath",
            "isolatedPluginUpToDate",
            "projectPath",
            "projectState",
            "projectVersion",
            "projectHasClaudeMd",
            "globalInstalled",
            "globalEnabled",
            "globalUpToDate",
            "globalPath",
            "parentCodeRepoWarning",
        ] {
            assert!(
                status_json.get(key).is_some(),
                "WriterPluginStatus missing key `{key}`: {status_json}"
            );
        }

        let global = install_global_in(&home.0, false).expect("global");
        let global_json = serde_json::to_value(&global).expect("serialize global");
        for key in [
            "ok",
            "pluginName",
            "pluginVersion",
            "installPath",
            "enabled",
            "disabled",
            "writtenFiles",
            "unchangedFiles",
            "enableCommand",
            "disableCommand",
        ] {
            assert!(
                global_json.get(key).is_some(),
                "WriterPluginGlobalResult missing key `{key}`: {global_json}"
            );
        }
    }

    #[test]
    fn sync_project_rejects_symlink_or_junction_root_and_subdir_escape() {
        let home = TempDirGuard::new("home-sym");
        let real_project = TempDirGuard::new("real-proj");
        let outside = TempDirGuard::new("outside");
        let link_parent = TempDirGuard::new("link-parent");

        #[cfg(windows)]
        let make_dir_link = |target: &Path, link: &Path| -> bool {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
                || std::process::Command::new("cmd")
                    .args([
                        "/c",
                        "mklink",
                        "/J",
                        &link.to_string_lossy(),
                        &target.to_string_lossy(),
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
        };

        #[cfg(unix)]
        let make_dir_link = |target: &Path, link: &Path| -> bool {
            std::os::unix::fs::symlink(target, link).is_ok()
        };

        // 1) Project root itself is a symlink/junction (with or without trailing separator) -> rejected!
        let linked_root = link_parent.0.join("linked-novel");
        assert!(make_dir_link(&real_project.0, &linked_root));
        let linked_str = linked_root.to_string_lossy().to_string();
        for candidate in [
            linked_str.clone(),
            format!("{linked_str}/"),
            format!("{linked_str}\\"),
            format!("  {linked_str}/  "),
        ] {
            assert!(
                sync_project_in(&home.0, &candidate, false).is_err(),
                "symlink/junction project root must be rejected (even with trailing separator): {candidate:?}"
            );
            assert!(
                status_in(&home.0, Some(&candidate)).is_err(),
                "status_in must reject symlink/junction project root: {candidate:?}"
            );
        }
        let _ = fs::remove_dir(&linked_root);

        // Trimmed real project path with trailing separator succeeds consistently in sync_project_in & status_in.
        let padded_real = format!("  {}/  ", real_project.0.to_string_lossy());
        let synced = sync_project_in(&home.0, &padded_real, false)
            .expect("trimmed real directory with trailing separator must sync cleanly");
        assert_eq!(synced.status.project_state, "synced");

        // 2) `.agents` inside project is a symlink/junction pointing outside -> rejected!
        let linked_agents = real_project.0.join(".agents");
        let _ = fs::remove_dir_all(&linked_agents);
        assert!(make_dir_link(&outside.0, &linked_agents));
        assert!(
            sync_project_in(&home.0, &real_project.0.to_string_lossy(), false).is_err(),
            "symlink/junction `.agents` subdir must be rejected"
        );
        assert!(
            !outside.0.join("plugins.json").exists(),
            "escape write must never land outside project"
        );
        let _ = fs::remove_dir(&linked_agents);
    }
}
