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
pub const WRITER_PLUGIN_VERSION: &str = "1.4.0";
const WRITER_PLUGIN_AUTHOR: &str = "Niko Buddy";
const WRITER_PLUGIN_DESCRIPTION: &str = "Pure-declarative long-form novel writing workspace plugin for Antigravity + Niko Buddy MCP (Draft-first, zero-LLM mechanical gates, 6 skills, 5 editorial role playbooks).";

pub const DUAL_PROFILE_MCP_WRITER_SERVER_NAME: &str = "niko-buddy-writer";
pub const DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME: &str = "niko-buddy-reviewer";
pub const DUAL_PROFILE_MCP_TIMEOUT_SECONDS: u64 = 600;
pub const DUAL_PROFILE_MCP_TOKEN_PLACEHOLDER: &str = "<YOUR_BEARER_TOKEN>";
const DUAL_PROFILE_MCP_DEFAULT_ENDPOINT: &str = "http://127.0.0.1:45871/mcp";
const DUAL_PROFILE_MCP_EXAMPLE_FILENAME: &str = "mcp_config.dual-profile.example.json";

const ISOLATED_PLUGIN_ROOT_REF: &str = "~/.niko-buddy/agy-plugin";
const MARKER_START: &str = "<!-- niko-buddy-writer:start -->";
const MARKER_VERSION_PREFIX: &str = "<!-- niko-buddy-writer:version=";
const MARKER_VERSION_SUFFIX: &str = " -->";
const MARKER_END: &str = "<!-- niko-buddy-writer:end -->";

const ENABLE_GLOBAL_COMMAND: &str = "agy plugin enable niko-buddy-writer";
const DISABLE_GLOBAL_COMMAND: &str = "agy plugin disable niko-buddy-writer";

const RULES_AGENTS_MD: &str = r#"# Niko Buddy Writing Workspace Rules

Novel workspace managed by **Niko Buddy** (not a code repo). Stay inside narrative planning, drafting, editing, review.

## Boundaries
- **Draft-first**: `chapter.write`, `draft.patch` (`expectedSha256` via `draft.read`, `HARD_FUSE_LIMIT=5`), `draft.record_review` (`pending->ready`, NEVER accepts; UI accept only). Never overwrite formal chapters/memory.
- **Gate Priority**: `Consistency(P0) > Anti-AI(P1) > Quality(P2)` (Quality never overrides P0).
- **Zero-LLM Loop**: `workflow.next` -> `context.prepare_write` (`prepareId`+`page`) + `rules.get(compact:true)` + `skills.list`/`skills.get` + `canon.facts_known_by`/`canon.episodes` + `foreshadowing.list`/`character.read`/`outline.read`/`style.exemplars`/`chapter.search`/`audit.longform_health` -> model -> `chapter.write`/`draft.patch` -> `draft.diff` + `gate.check_mechanical` -> `draft.record_review`.
- **Planning Writes** (`architect`/`writer-sub`): `director.upsert_world`, `director.commit_phase`, `rules.upsert_book_rules`, `compass.update`, `foreshadowing.upsert`, `subplot.upsert`, `outline.write`, `character.upsert`.
- **WeKnora & Craft**: `craft|lore|tech` KBs (10% Iceberg); single POV, Beat flips, fair clues.

## Skills (`skills/*/SKILL.md`)
- `nb-book-architect` - World, rules, outlines, characters
- `nb-chapter-draft` - Drafting, patching, gates
- `nb-consistency-audit` - RO P0 canon audit
- `nb-de-ai-polish` - Anti-AI prose polish
- `nb-six-dim-review` - RO six-dim review
- `nb-story-ops` - Routing, ledgers, `ChapterSnapshot`

## Playbooks (`agents/*.md`)
- `novel-architect` (`architect`/`writer-sub`), `novel-writer` / `de-ai-stylist` (`writer-sub`)
- `canon-auditor` `[RO]`, `literary-critic` `[RO]` (`reviewer` + `SessionScope::Read`; `mcp_config.dual-profile.example.json`)
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
1. Call `workflow.next`, `director.check`, `project.state`, `rules.get(compact:true)`, and `skills.list(stage: "outline")` / `skills.get(stage: "outline")` to inspect current phase gates, book rules, and enabled planning skills.
2. Read existing planning state with `outline.read` (by volume/chapter window or safe `.md` filename), `character.read`, `foreshadowing.list`, `audit.longform_health`, `canon.query`, `canon.facts_known_by`, `canon.episodes`, `chapter.list`, `draft.list`, and `chapter.search`.
3. Assemble planning context via `context.prepare_write(includePlanningView:true)` when expanding an ongoing book; reuse `prepareId` + `page` for paged context without rebuilding.
4. Author world layers, book rules, outlines, character cards, compass goals, foreshadowing, and subplots directly using the host subscription model — do not invoke legacy internal LLM generators.
5. Persist planning/governance artifacts safely with `director.upsert_world`, `rules.upsert_book_rules`, `outline.write` (safe `.md` filename under `wiki/outlines/`), `character.upsert`, `compass.update`, `foreshadowing.upsert`, `subplot.upsert`, and commit verified setup gates via `director.commit_phase`.
6. Never write formal chapters or formal memory directly. Keep all narrative plans aligned with `Consistency(P0) > Anti-AI(P1) > Quality(P2)`.
"#;

const SKILL_CHAPTER_DRAFT: &str = r#"---
name: nb-chapter-draft
description: Draft and surgically revise a novel chapter using zero-LLM context prep, Draft-first patching, and review gates.
---

# Chapter Drafting Workflow

Use this skill to write a new chapter or revise an active draft with zero internal API LLM calls.

## Recommended MCP Profile
- `writer-sub` with `SessionScope::Project`.

## Steps
1. Call `workflow.next(targetChapter: N)` to confirm the deterministic next action from `.novel/status.json`.
2. Call `context.prepare_write(targetChapter: N, includePlanningView: true, retrievalMode: "local_only")`. Reuse the returned `prepareId` with 1-based `page` (mutually exclusive with `offset`) to page context without rebuilding.
3. Load style, skill, and canon references via `rules.get(compact: true)`, `skills.list(stage: "writing")` / `skills.get(stage: "writing")`, `style.exemplars`, `outline.read`, `character.read`, `foreshadowing.list`, `canon.query`, `canon.facts_known_by(pov, atChapter)`, `canon.episodes(chapterNumber)`, and `chapter.search`.
4. Draft the full chapter prose directly in the host subscription model while honoring voice, pacing, foreshadowing threads, and character knowledge constraints.
5. Save the initial draft via `chapter.write(chapterName, content)`. This writes ONLY to `.qm-drafts/` (Draft-first).
6. Run `gate.check_mechanical(draftId, detailLevel: "compact")` to verify zero-LLM P0 Continuity preflight, BookRules, and P1 Anti-AI checks.
7. For targeted fixes, read the draft via `draft.read` to get `bodySha256` and 1-based line numbers, then apply surgical edits with `draft.patch(draftId, expectedSha256, edits)` (preserves `parentDraftId`, enforces `HARD_FUSE_LIMIT=5`). Re-run `gate.check_mechanical` after patching.
8. Record verified P0/P1/P2 gate verdicts with `draft.record_review(draftId, expectedSha256, gates, ...)` — promotes `.novel/status.json` `draft_status` at most `pending -> ready`, NEVER accepts.
9. Remind the author to review and accept the draft inside Niko Buddy (formal acceptance happens exclusively via human click inside Niko Buddy UI; no MCP acceptance tool exists).
"#;

const SKILL_CONSISTENCY_AUDIT: &str = r#"---
name: nb-consistency-audit
description: Run read-only P0 continuity, canon, and timeline audits on drafts or chapters without modifying project files.
---

# Consistency Audit Workflow (Read-Only)

Use this skill to perform a strict P0 continuity and canon verification pass.

## Recommended MCP Profile
- `reviewer` (`niko-buddy-reviewer`, `?profile=reviewer`) with `SessionScope::Read` (strictly zero write tools; see `mcp_config.dual-profile.example.json`).

## Steps
1. Call `workflow.next` and locate the target via `draft.list` + `draft.read` (note `bodySha256` and line numbers) or `chapter.list` + `chapter.read`.
2. Run `gate.check_mechanical(draftId|chapter, detailLevel: "full")` to collect deterministic P0 Continuity preflight and BookRules diagnostics (when auditing raw `text`, always pass `chapterNumber`).
3. Audit POV cognition isolation via `canon.facts_known_by(pov, atChapter)`, check chapter provenance via `canon.episodes(chapterNumber)`, hydrate relevant review rules on demand via `skills.list` / `skills.get(stage: "review")`, and cross-check ledgers with `character.read`, `foreshadowing.list`, `outline.read`, `canon.query`, `chapter.search`, and `context.inspect` / `context.prepare_write` (reusing `prepareId` + `page`).
4. Report findings ordered strictly by `Consistency(P0) > Anti-AI(P1) > Quality(P2)` with exact line/quote locations, violated canon facts, and structured patch/gate data for `writer-sub` to apply via `draft.patch` and record via `draft.record_review`.
5. Never write or modify project files during an audit.
"#;

const SKILL_DE_AI_POLISH: &str = r#"---
name: nb-de-ai-polish
description: Surgically remove AI prose tells and repetitive rhythm from a draft while preserving canon facts and P0 continuity.
---

# De-AI Prose Polish Workflow

Use this skill to refine prose texture and eliminate AI writing habits without breaking story continuity.

## Recommended MCP Profile
- `writer-sub` with `SessionScope::Project`.

## Steps
1. Fetch active prose rules, De-AI skills, and author benchmarks via `rules.get(sections: ["writingStyle", "antiAi"], compact: true)`, `skills.list(kind: "de_ai")` / `skills.get(stage: "rewrite", includeDeAi: true)`, and `style.exemplars(markTypes: ["style", "voice", "pacing"])`.
2. Read the target draft via `draft.read` (capture `bodySha256` and 1-based line numbers), verify POV knowledge bounds via `canon.facts_known_by`, and inspect flagged tells via `gate.check_mechanical(draftId, detailLevel: "full")`.
3. Apply targeted rewrites via `draft.patch(draftId, expectedSha256, edits)` (preserving `parentDraftId`, respecting `HARD_FUSE_LIMIT=5`) to restore natural sentence cadence, concrete sensory detail, and character-specific dialogue while keeping every canon fact and plot beat intact.
4. Verify surgical deltas via `draft.diff` and re-run `gate.check_mechanical(draftId, detailLevel: "compact")` to confirm both P0 Continuity and P1 Anti-AI pass — never trade P0 continuity for style.
5. Record the updated review status via `draft.record_review(draftId, expectedSha256, gates, ...)` (promotes at most `pending -> ready`, never accepts).
"#;

const SKILL_SIX_DIM_REVIEW: &str = r#"---
name: nb-six-dim-review
description: Evaluate a chapter or draft across six dimensions (thrill, consistency, pacing, character, continuity, pull).
---

# Six-Dimension Literary Review Workflow (Read-Only)

Use this skill to produce a structured diagnostic review across Niko Buddy's six literary dimensions.

## Recommended MCP Profile
- `reviewer` (`niko-buddy-reviewer`, `?profile=reviewer`) with `SessionScope::Read` (strictly zero write tools; see `mcp_config.dual-profile.example.json`).

## Steps
1. Run `gate.check_mechanical(draftId|chapter, detailLevel: "compact")` first to establish the Track A hard gate (`Consistency(P0)` and `Anti-AI(P1)`).
2. Read the chapter or draft via `chapter.read` / `draft.read` (note `bodySha256`) and load dimension prompts via `context.prepare_write` (reuse `prepareId` + `page` across all six dimensions: `thrill`, `consistency`, `pacing`, `character`, `continuity`, `pull`) or `context.inspect`.
3. Hydrate style/De-AI skill rules on demand via `skills.list` / `skills.get(stage: "review")` and cross-reference author benchmarks, POV cognition, chapter provenance, revision deltas, and narrative ledgers via `canon.facts_known_by`, `canon.episodes`, `style.exemplars`, `draft.diff`, `foreshadowing.list`, `character.read`, `outline.read`, and `chapter.search`.
4. Score each dimension with grounded textual evidence and return structured `gates`, `overallScore`, `dimensionScores`, `summary`, and `blockingIssues` so `writer-sub` can persist them via `draft.record_review`.
5. Keep Track A (P0/P1 hard gates) strictly separate from Track B (literary quality scores): a high literary score never overrides a P0 consistency failure. Never modify files during review.
"#;

const SKILL_STORY_OPS: &str = r#"---
name: nb-story-ops
description: Route next workflow steps, inspect ledgers and draft queue, and prepare human-confirmed ChapterSnapshot JSON.
---

# Story Operations & Snapshot Prep Workflow (Read-Only)

Use this skill for fast read-only situational awareness, ledger diagnostics, and interactive post-acceptance `ChapterSnapshot` JSON preparation.

## Recommended MCP Profile
- `reviewer`, `architect`, or `writer-sub` (`SessionScope::Read` is sufficient).

## Steps
1. Call `app.status` and `workflow.next` to confirm active MCP `scope`, frozen `profile`, and deterministic next recommended step.
2. Call `project.state`, `director.check`, `chapter.list`, and `draft.list` to inspect `.novel/status.json` progress, blocked director gates, published chapters, and pending/ready drafts awaiting author acceptance.
3. Query narrative health and skill catalogs via `audit.longform_health`, `skills.list` / `skills.get`, `foreshadowing.list(includeDebt: true)`, `character.read(includeState: true)`, `outline.read(includeSummaryOnly: true)`, `canon.facts_known_by`, `canon.episodes`, and `chapter.search` as needed.
4. **Interactive `ChapterSnapshot` JSON Preparation (Read-Only)**: When an author asks to ingest an already accepted formal chapter into formal memory without internal API LLM calls, read the chapter via `chapter.read` plus existing ledgers (`character.read`, `foreshadowing.list`, `canon.query`, `canon.facts_known_by`, `canon.episodes`), then generate a clean structured `ChapterSnapshot` JSON candidate (summary, character state deltas, foreshadowing updates, new canon facts) for the human author to inspect and confirm inside Niko Buddy via `commitPreparedChapterIngest`.
5. Never write formal memory or accept drafts directly from this workflow.
"#;

const AGENT_NOVEL_ARCHITECT: &str = r#"# Role Playbook: Novel Architect

Declarative editorial-room persona for book structure, worldbuilding, outlines, and character ledgers.

## Recommended Session Binding
- MCP Profile: `architect` (or `writer-sub`)
- MCP Scope: `project`

## Responsibilities
- Route and audit setup readiness with `workflow.next`, `director.check`, `project.state`, `rules.get(compact:true)`, and `skills.list`/`skills.get`.
- Inspect existing outlines, characters, foreshadowing, book-wide health, canon ledgers, and prior chapters via `outline.read`, `character.read`, `foreshadowing.list`, `audit.longform_health`, `canon.query`, `canon.facts_known_by`, `canon.episodes`, and `chapter.search`.
- Prepare planning context with `context.prepare_write(includePlanningView:true)` (reusing `prepareId` + `page` when paging).
- Author world layers, book rules, outlines, character docs, compass, foreshadowing, and subplot plans directly with the host model and save via `director.upsert_world`, `rules.upsert_book_rules`, `outline.write`, `character.upsert`, `compass.update`, `foreshadowing.upsert`, `subplot.upsert`, and `director.commit_phase`.

## Boundaries
- Never bypass Draft-first or touch formal chapters/memory.
- Keep `Consistency(P0) > Anti-AI(P1) > Quality(P2)` binding across all volume and chapter plans.
"#;

const AGENT_NOVEL_WRITER: &str = r#"# Role Playbook: Novel Writer

Declarative editorial-room persona for scene-level long-form chapter drafting and surgical draft revision.

## Recommended Session Binding
- MCP Profile: `writer-sub` (`niko-buddy-writer`, `?profile=writer-sub`)
- MCP Scope: `project`

## Responsibilities
- Start with `workflow.next` and assemble context via `context.prepare_write(targetChapter, includePlanningView:true)` (reuse `prepareId` + `page` instead of rebuilding), `rules.get(compact:true)`, and `skills.list`/`skills.get`.
- Check character state, POV cognition, chapter provenance, foreshadowing threads, outlines, style exemplars, and canon edges via `character.read`, `foreshadowing.list`, `outline.read`, `style.exemplars`, `chapter.search`, `canon.query`, `canon.facts_known_by`, and `canon.episodes`.
- Draft full chapters in the host subscription model and save initial drafts strictly to `.qm-drafts/` via `chapter.write`.
- Self-check every draft via `gate.check_mechanical(draftId, detailLevel:"compact")`, apply surgical fixes via `draft.patch(draftId, expectedSha256, edits)` (`HARD_FUSE_LIMIT=5`, using `bodySha256` from `draft.read`), verify changes via `draft.diff`, and record verified outcomes via `draft.record_review` (promotes at most `pending -> ready`, never accepts).

## Boundaries
- Draft-first: never write formal chapters or formal memory directly; the human author accepts drafts in Niko Buddy.
"#;

const AGENT_CANON_AUDITOR: &str = r#"# Role Playbook: Canon Auditor [RO]

Strictly **read-only** editorial-room persona for P0 continuity, POV cognition isolation, canon ledger, and timeline verification.

## Security Enforcement Note
- `[RO]` write prohibition is enforced externally by binding this session to dual-profile MCP server `niko-buddy-reviewer` (`?profile=reviewer`, `SessionScope::Read`, zero write tools exposed; see `mcp_config.dual-profile.example.json`). Do not attempt any file or project mutation.

## Responsibilities
- Check routing via `workflow.next` and read drafts/chapters via `draft.list`, `draft.read` (recording `bodySha256`), `chapter.list`, `chapter.read`.
- Audit POV cognition isolation strictly with `canon.facts_known_by(pov, atChapter)` (ensuring characters never act on unknown facts) and verify chapter provenance with `canon.episodes(chapterNumber)` alongside `canon.query`.
- Hydrate relevant writing/review rules on demand via `skills.list` and `skills.get` without loading unused skill bodies.
- Cross-verify character states, foreshadowing threads, outlines, and past text via `character.read`, `foreshadowing.list`, `outline.read`, `chapter.search`, `audit.longform_health`, and `context.inspect`.
- Run `gate.check_mechanical(draftId|chapter, detailLevel:"full")` (include `chapterNumber` for raw `text`).
- Deliver precise P0 continuity findings with line citations and structured repair/gate payloads back to `writer-sub` (do not invoke any write tool from this read-only session).
"#;

const AGENT_DE_AI_STYLIST: &str = r#"# Role Playbook: De-AI Stylist

Declarative editorial-room persona for prose naturalness, voice differentiation, and anti-AI surgical polishing.

## Recommended Session Binding
- MCP Profile: `writer-sub`
- MCP Scope: `project`

## Responsibilities
- Load active prose guidelines, De-AI skills, and author benchmarks via `rules.get(sections:["writingStyle","antiAi"], compact:true)`, `skills.list`/`skills.get`, and `style.exemplars`.
- Inspect draft text via `draft.read` (`bodySha256` + line numbers), check POV knowledge boundaries via `canon.facts_known_by`, and check mechanical tells via `gate.check_mechanical(draftId, detailLevel:"full")`.
- Rewrite AI clichés and monotonous cadence using surgical `draft.patch(draftId, expectedSha256, edits)` (`HARD_FUSE_LIMIT=5`) while preserving 100% of canon facts, character knowledge, and plot beats.
- Inspect revision deltas via `draft.diff`, re-verify via `gate.check_mechanical(draftId, detailLevel:"compact")`, and update draft status via `draft.record_review` (never accepts).

## Boundaries
- Never alter established canon facts for stylistic flair; `Consistency(P0)` always outranks `Anti-AI(P1)` and `Quality(P2)`.
"#;

const AGENT_LITERARY_CRITIC: &str = r#"# Role Playbook: Literary Critic [RO]

Strictly **read-only** editorial-room persona for six-dimension literary critique (`thrill`, `consistency`, `pacing`, `character`, `continuity`, `pull`).

## Security Enforcement Note
- `[RO]` write prohibition is enforced externally by binding this session to dual-profile MCP server `niko-buddy-reviewer` (`?profile=reviewer`, `SessionScope::Read`, zero write tools exposed; see `mcp_config.dual-profile.example.json`). Do not attempt any file or project mutation.

## Responsibilities
- Verify Track A hard gate status first via `gate.check_mechanical(draftId|chapter, detailLevel:"compact")`.
- Read chapter/draft text and dimension prompts via `chapter.read`, `draft.read` (`bodySha256`), `context.prepare_write` (reuse `prepareId` + `page` across dimensions), and `context.inspect`.
- Hydrate style and De-AI review criteria on demand via `skills.list` and `skills.get(stage:"review")`, and verify character cognition and chapter beats via `canon.facts_known_by` and `canon.episodes`.
- Ground critique in author benchmarks, draft diffs, and story ledgers via `style.exemplars`, `draft.diff`, `foreshadowing.list`, `character.read`, `outline.read`, and `chapter.search`.
- Score all six dimensions with line-level evidence and hand structured `gates` / `overallScore` / `dimensionScores` / `blockingIssues` back to `writer-sub` (do not invoke any write tool from this read-only session).
- Respect gate priority: literary quality scores never override a P0 consistency failure.
"#;

const PROJECT_AGENTS_MD_BLOCK: &str = r#"<!-- niko-buddy-writer:start -->
<!-- niko-buddy-writer:version=1.4.0 -->
# Niko Buddy Novel Workspace
This directory is a long-form fiction project managed by Niko Buddy (not a code repository).
- Use `niko-buddy-writer` (`.agents/plugins.json`) and Niko Buddy MCP (`writer-sub` / `reviewer` / `architect`), starting with `workflow.next`.
- Draft-first: save/revise via `chapter.write` + `draft.patch`; record gates via `draft.record_review` (never accepts).
- Gate priority: `Consistency(P0) > Anti-AI(P1) > Quality(P2)`.
<!-- niko-buddy-writer:end -->"#;

const PROJECT_CLAUDE_MD_BLOCK: &str = r#"<!-- niko-buddy-writer:start -->
<!-- niko-buddy-writer:version=1.4.0 -->
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

fn append_profile_query(base_endpoint: &str, profile: &str) -> String {
    let trimmed = base_endpoint.trim();
    let effective = if trimmed.is_empty() {
        DUAL_PROFILE_MCP_DEFAULT_ENDPOINT
    } else {
        trimmed
    };
    let (without_frag, frag) = match effective.split_once('#') {
        Some((head, tail)) => (head, Some(tail)),
        None => (effective, None),
    };
    let (base, existing_query) = match without_frag.split_once('?') {
        Some((head, tail)) => (head, Some(tail)),
        None => (without_frag, None),
    };
    let mut kept_params: Vec<&str> = Vec::new();
    if let Some(q) = existing_query {
        for part in q.split('&') {
            if part.is_empty() {
                continue;
            }
            let key = part.split_once('=').map(|(k, _)| k).unwrap_or(part);
            if key.eq_ignore_ascii_case("profile") {
                continue;
            }
            kept_params.push(part);
        }
    }
    let mut out = String::from(base);
    out.push('?');
    for part in kept_params {
        out.push_str(part);
        out.push('&');
    }
    out.push_str("profile=");
    out.push_str(profile);
    if let Some(f) = frag {
        out.push('#');
        out.push_str(f);
    }
    out
}

/// 构造标准双 Profile Antigravity IDE `mcp_config.json` 值对象：
/// - `niko-buddy-writer` 指向 `?profile=writer-sub`（写/改草稿）；
/// - `niko-buddy-reviewer` 指向 `?profile=reviewer`（严格全只读隔离审校）；
/// - 自动剥离 `base_endpoint` 中已有的重复 `profile` query 参数，未提供 token 时默认填充 `<YOUR_BEARER_TOKEN>` 占位符。
pub fn build_dual_profile_antigravity_mcp_config(
    base_endpoint: &str,
    bearer_token: Option<&str>,
) -> Value {
    let token = bearer_token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(DUAL_PROFILE_MCP_TOKEN_PLACEHOLDER);
    let auth_header = format!("Bearer {token}");
    let writer_url = append_profile_query(base_endpoint, "writer-sub");
    let reviewer_url = append_profile_query(base_endpoint, "reviewer");
    json!({
        "mcpServers": {
            DUAL_PROFILE_MCP_WRITER_SERVER_NAME: {
                "serverUrl": writer_url,
                "headers": {
                    "Authorization": auth_header,
                },
                "timeoutSeconds": DUAL_PROFILE_MCP_TIMEOUT_SECONDS,
            },
            DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME: {
                "serverUrl": reviewer_url,
                "headers": {
                    "Authorization": auth_header,
                },
                "timeoutSeconds": DUAL_PROFILE_MCP_TIMEOUT_SECONDS,
            },
        }
    })
}

/// 渲染格式化后的双 Profile Antigravity IDE `mcp_config.json` 文本（以换行结尾）。
pub fn render_dual_profile_antigravity_mcp_config_json(
    base_endpoint: &str,
    bearer_token: Option<&str>,
) -> String {
    let doc = build_dual_profile_antigravity_mcp_config(base_endpoint, bearer_token);
    let mut out = serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".to_string());
    out.push('\n');
    out
}

fn build_plugin_bundle(disabled: Option<bool>) -> Vec<(String, String)> {
    let mut files = Vec::with_capacity(2 + STATIC_PLUGIN_MARKDOWN_FILES.len());
    files.push(("plugin.json".to_string(), render_plugin_manifest(disabled)));
    files.push((
        DUAL_PROFILE_MCP_EXAMPLE_FILENAME.to_string(),
        render_dual_profile_antigravity_mcp_config_json(DUAL_PROFILE_MCP_DEFAULT_ENDPOINT, None),
    ));
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
            14,
            "plugin bundle must contain exactly 14 declarative files"
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

        for (block_name, block_content) in [
            ("PROJECT_AGENTS_MD_BLOCK", PROJECT_AGENTS_MD_BLOCK),
            ("PROJECT_CLAUDE_MD_BLOCK", PROJECT_CLAUDE_MD_BLOCK),
        ] {
            for forbidden in [
                "agy -p",
                "--dangerously-skip-permissions",
                "--override_user_agent_name",
                "--yolo",
                "draft.accept",
            ] {
                assert!(
                    !block_content.contains(forbidden),
                    "{block_name} contains forbidden string `{forbidden}`"
                );
            }
        }

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
            // Zero forbidden ToS flags or non-existent acceptance tool names anywhere in embedded content.
            for forbidden in [
                "agy -p",
                "--dangerously-skip-permissions",
                "--override_user_agent_name",
                "--yolo",
                "draft.accept",
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

        // Phase 2/3/v1.4.0 canonical tools and interactive ChapterSnapshot ingest prep must be taught.
        assert_eq!(WRITER_PLUGIN_VERSION, "1.4.0");
        for needle in [
            "workflow.next",
            "prepareId",
            "page",
            "draft.patch",
            "expectedSha256",
            "HARD_FUSE_LIMIT=5",
            "draft.record_review",
            "foreshadowing.list",
            "character.read",
            "outline.read",
            "style.exemplars",
            "chapter.search",
            "draft.diff",
            "audit.longform_health",
            "skills.list",
            "skills.get",
            "canon.facts_known_by",
            "canon.episodes",
            "mcp_config.dual-profile.example.json",
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(
                RULES_AGENTS_MD.contains(needle),
                "rules/AGENTS.md missing canonical token `{needle}`"
            );
        }
        for planning_write in [
            "director.upsert_world",
            "director.commit_phase",
            "rules.upsert_book_rules",
            "compass.update",
            "foreshadowing.upsert",
            "subplot.upsert",
        ] {
            assert!(
                SKILL_BOOK_ARCHITECT.contains(planning_write),
                "nb-book-architect missing `{planning_write}`"
            );
            assert!(
                AGENT_NOVEL_ARCHITECT.contains(planning_write),
                "novel-architect missing `{planning_write}`"
            );
        }
        // [RO] agent playbooks must NEVER mention any write tool.
        for ro_agent in [
            ("canon-auditor", AGENT_CANON_AUDITOR),
            ("literary-critic", AGENT_LITERARY_CRITIC),
        ] {
            for write_tool in [
                "chapter.write",
                "chapter.write_direct",
                "draft.write",
                "draft.patch",
                "draft.record_review",
                "draft.accept",
                "outline.write",
                "character.upsert",
                "director.upsert_world",
                "director.commit_phase",
                "rules.upsert_book_rules",
                "compass.update",
                "foreshadowing.upsert",
                "subplot.upsert",
                "settings.set",
                "memory.write",
                "undo_last",
            ] {
                assert!(
                    !ro_agent.1.contains(write_tool),
                    "[RO] agent `{}` must NEVER mention write tool `{write_tool}`",
                    ro_agent.0
                );
            }
            for ro_read_tool in [
                "canon.facts_known_by",
                "canon.episodes",
                "skills.list",
                "skills.get",
                "niko-buddy-reviewer",
            ] {
                assert!(
                    ro_agent.1.contains(ro_read_tool),
                    "[RO] agent `{}` must teach `{ro_read_tool}`",
                    ro_agent.0
                );
            }
        }
        assert!(SKILL_DE_AI_POLISH.contains("draft.diff"));
        assert!(SKILL_SIX_DIM_REVIEW.contains("draft.diff"));
        assert!(AGENT_NOVEL_WRITER.contains("draft.diff"));
        assert!(AGENT_DE_AI_STYLIST.contains("draft.diff"));
        assert!(AGENT_LITERARY_CRITIC.contains("draft.diff"));
        assert!(
            !AGENT_NOVEL_ARCHITECT.contains("draft.diff"),
            "novel-architect playbook must NEVER recommend hidden tool draft.diff"
        );
        assert!(SKILL_STORY_OPS.contains("audit.longform_health"));
        assert!(SKILL_BOOK_ARCHITECT.contains("audit.longform_health"));
        assert!(AGENT_NOVEL_ARCHITECT.contains("audit.longform_health"));
        assert!(SKILL_STORY_OPS.contains("ChapterSnapshot"));
        assert!(SKILL_STORY_OPS.contains("commitPreparedChapterIngest"));
        assert!(PROJECT_AGENTS_MD_BLOCK.contains("version=1.4.0"));
        assert!(PROJECT_CLAUDE_MD_BLOCK.contains("version=1.4.0"));

        // Declarative dual-profile MCP template must exist in bundle and strictly use placeholder token.
        let (_, dual_tpl) = bundle
            .iter()
            .find(|(rel, _)| rel == DUAL_PROFILE_MCP_EXAMPLE_FILENAME)
            .expect("bundle must contain mcp_config.dual-profile.example.json");
        let dual_json: Value = serde_json::from_str(dual_tpl).expect("valid dual-profile json");
        let writer_entry = &dual_json["mcpServers"][DUAL_PROFILE_MCP_WRITER_SERVER_NAME];
        let reviewer_entry = &dual_json["mcpServers"][DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME];
        assert_eq!(
            writer_entry["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?profile=writer-sub")
        );
        assert_eq!(
            reviewer_entry["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?profile=reviewer")
        );
        assert_eq!(
            writer_entry["headers"]["Authorization"],
            json!("Bearer <YOUR_BEARER_TOKEN>")
        );
        assert_eq!(
            reviewer_entry["headers"]["Authorization"],
            json!("Bearer <YOUR_BEARER_TOKEN>")
        );
        assert_eq!(writer_entry["timeoutSeconds"], json!(600));
        assert_eq!(reviewer_entry["timeoutSeconds"], json!(600));
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

        // First sync (include_claude_md = false): writes 14 isolated + 2 project = 16 files.
        let sync1 = sync_project_in(&home.0, &project.0.to_string_lossy(), false).expect("sync1");
        assert!(sync1.ok);
        assert_eq!(sync1.written_files.len(), 16);
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

        // Second sync is 100% idempotent: 0 written, 16 unchanged!
        let sync2 = sync_project_in(&home.0, &project.0.to_string_lossy(), false).expect("sync2");
        assert!(sync2.written_files.is_empty());
        assert_eq!(sync2.unchanged_files.len(), 16);
        assert!(sync2.agents_md_preserved_user_content);
        assert_eq!(sync2.status.project_state, "synced");

        // Sync with `include_claude_md = true` writes only `CLAUDE.md` with `@AGENTS.md`.
        let sync3 = sync_project_in(&home.0, &project.0.to_string_lossy(), true).expect("sync3");
        assert_eq!(sync3.written_files.len(), 1);
        assert_eq!(sync3.unchanged_files.len(), 16);
        assert!(sync3.status.project_has_claude_md);
        let claude_text = fs::read_to_string(project.0.join("CLAUDE.md")).unwrap();
        assert!(claude_text.contains("@AGENTS.md"));
        assert!(claude_text.contains(MARKER_START));
        assert!(claude_text.contains(MARKER_END));

        // Outdated version marker (v1.1.0 -> v1.2.0) in AGENTS.md triggers `needs_update` and upgrades cleanly.
        let current_marker = format!("version={WRITER_PLUGIN_VERSION}");
        assert!(agents_text.contains(&current_marker));
        let stale_agents = agents_text.replace(&current_marker, "version=1.1.0");
        fs::write(project.0.join("AGENTS.md"), stale_agents).unwrap();
        let stale_status = status_in(&home.0, Some(&project.0.to_string_lossy())).expect("stale");
        assert_eq!(stale_status.project_state, "needs_update");
        assert_eq!(stale_status.project_version.as_deref(), Some("1.1.0"));

        let upgraded =
            sync_project_in(&home.0, &project.0.to_string_lossy(), false).expect("upgrade");
        assert_eq!(upgraded.status.project_state, "synced");
        assert_eq!(
            upgraded.status.project_version.as_deref(),
            Some(WRITER_PLUGIN_VERSION)
        );
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

        // Default install (`enable = false`) writes 14 files with `"disabled": true`.
        let res1 = install_global_in(&home.0, false).expect("install global disabled");
        assert!(res1.ok);
        assert!(!res1.enabled);
        assert!(res1.disabled);
        assert_eq!(res1.written_files.len(), 14);
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

        // Toggle to `enable = true`: updates ONLY `plugin.json`, leaves 13 static declarative files unchanged!
        let res2 = install_global_in(&home.0, true).expect("install global enabled");
        assert!(res2.enabled);
        assert!(!res2.disabled);
        assert_eq!(res2.written_files.len(), 1);
        assert_eq!(res2.unchanged_files.len(), 13);

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

    #[test]
    fn dual_profile_antigravity_mcp_config_helper_strips_duplicate_profile_and_uses_placeholder() {
        // 1) Default placeholder token + strips existing profile query
        let cfg = build_dual_profile_antigravity_mcp_config(
            "http://127.0.0.1:49999/mcp?profile=full-legacy",
            None,
        );
        let servers = cfg["mcpServers"].as_object().expect("mcpServers object");
        assert_eq!(servers.len(), 2);
        assert_eq!(
            servers[DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:49999/mcp?profile=writer-sub")
        );
        assert_eq!(
            servers[DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:49999/mcp?profile=reviewer")
        );
        assert_eq!(
            servers[DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["headers"]["Authorization"],
            json!(format!("Bearer {DUAL_PROFILE_MCP_TOKEN_PLACEHOLDER}"))
        );
        assert_eq!(
            servers[DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["headers"]["Authorization"],
            json!(format!("Bearer {DUAL_PROFILE_MCP_TOKEN_PLACEHOLDER}"))
        );
        assert_eq!(
            servers[DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["timeoutSeconds"],
            json!(DUAL_PROFILE_MCP_TIMEOUT_SECONDS)
        );
        assert_eq!(
            servers[DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["timeoutSeconds"],
            json!(DUAL_PROFILE_MCP_TIMEOUT_SECONDS)
        );

        // 2) Preserves unrelated query params and strips duplicate/case-insensitive profile params
        let preserved = build_dual_profile_antigravity_mcp_config(
            "http://127.0.0.1:45871/mcp?foo=bar&profile=architect&Profile=reviewer&baz=1",
            Some("  tok-abc-123  "),
        );
        assert_eq!(
            preserved["mcpServers"][DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?foo=bar&baz=1&profile=writer-sub")
        );
        assert_eq!(
            preserved["mcpServers"][DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?foo=bar&baz=1&profile=reviewer")
        );
        assert_eq!(
            preserved["mcpServers"][DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["headers"]
                ["Authorization"],
            json!("Bearer tok-abc-123")
        );
        assert_eq!(
            preserved["mcpServers"][DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["headers"]
                ["Authorization"],
            json!("Bearer tok-abc-123")
        );

        // 3) Blank endpoint falls back to default loopback endpoint; blank token falls back to placeholder
        let fallback_json = render_dual_profile_antigravity_mcp_config_json("   ", Some("   "));
        assert!(fallback_json.ends_with('\n'));
        let parsed: Value = serde_json::from_str(&fallback_json).expect("valid rendered json");
        assert_eq!(
            parsed["mcpServers"][DUAL_PROFILE_MCP_WRITER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?profile=writer-sub")
        );
        assert_eq!(
            parsed["mcpServers"][DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["serverUrl"],
            json!("http://127.0.0.1:45871/mcp?profile=reviewer")
        );
        assert_eq!(
            parsed["mcpServers"][DUAL_PROFILE_MCP_REVIEWER_SERVER_NAME]["headers"]["Authorization"],
            json!("Bearer <YOUR_BEARER_TOKEN>")
        );
    }
}
