/**
 * @license MIT © Niko Buddy
 *
 * Wiki project templates — each bundles a schema document, a purpose
 * scaffold, and any extra directories the template expects.
 */

/** Describes one wiki-project template available during project creation. */
export interface WikiTemplate {
  id: string
  name: string
  description: string
  icon: string
  schema: string
  purpose: string
  extraDirs: string[]
  /** F3（Round-1 评估）：演示模板种子文件（零 API 试写）。普通模板缺省。 */
  seedFiles?: { path: string; content: string }[]
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

const SCHEMA_TYPES = `| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| overview | wiki/ | High-level project summary (one per project) |`

const NAMING_RULES = `- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`openai.md\`, \`gpt-4.md\`)`

const FRONTMATTER_SPEC = `All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\``

const INDEX_FORMAT = `\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\``

const LOG_FORMAT = `\`wiki/log.md\` records activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\``

const CROSSREF_RULES = `- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity should appear in \`wiki/index.md\`
- Link entities to the pages they draw on via \`related:\``

const CONTRADICTION_RULES = `When sources contradict each other:
1. Note the contradiction on the relevant entity page
2. Link both conflicting claims from the entity page
3. Resolve on the entity page once sufficient evidence exists`

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const researchTemplate: WikiTemplate = {
  id: "research",
  name: "Research",
  description: "Deep-dive research with hypothesis tracking and methodology notes",
  icon: "🔍",
  extraDirs: ["wiki/methodology", "wiki/findings", "wiki/thesis"],
  schema: `# Wiki Schema — Research Deep-Dive

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${SCHEMA_TYPES}
| thesis | wiki/thesis/ | Working hypothesis and its evolution over time |
| methodology | wiki/methodology/ | Research methods, protocols, and study designs |
| finding | wiki/findings/ | Individual empirical results or observations |

## Naming Conventions

${NAMING_RULES}
- Theses: hypothesis as slug (e.g., \`scaling-improves-reasoning.md\`)
- Methodologies: method name (e.g., \`systematic-review.md\`, \`ablation-study.md\`)
- Findings: descriptive slug (e.g., \`larger-models-better-few-shot.md\`)

## Frontmatter

${FRONTMATTER_SPEC}

Thesis pages also include:
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

Finding pages also include:
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## Index Format

${INDEX_FORMAT}

## Log Format

${LOG_FORMAT}

## Cross-referencing Rules

${CROSSREF_RULES}
- Findings link back to their source via the \`source:\` frontmatter field
- Thesis pages reference supporting and refuting findings via \`related:\`
- Methodology pages are cited by the findings that used them

## Contradiction Handling

${CONTRADICTION_RULES}

## Research-Specific Conventions

- Keep the thesis pages updated as evidence accumulates — they are living documents
- Every finding should assess replication status when known
- Methodology pages explain the *why* (rationale) not just the *how*
- Distinguish between direct evidence and inference in finding pages
`,
  purpose: `# Project Purpose — Research Deep-Dive

## Research Question

<!-- State the central question this research aims to answer. Be specific and falsifiable. -->

>

## Hypothesis / Working Thesis

<!-- Your current best guess. This will evolve — update it as evidence accumulates. -->

>

## Background

<!-- What prior work or context motivates this research? What gap does it fill? -->

## Sub-questions

<!-- Break down the main question into tractable sub-questions. -->

1.
2.
3.
4.

## Scope

**In scope:**
-

**Out of scope:**
-

## Methodology

<!-- How will you investigate this? What types of sources or experiments are relevant? -->

-

## Success Criteria

<!-- How will you know when you have a satisfying answer? -->

-

## Current Status

> Not started — update this section as research progresses.
`,
}

const readingTemplate: WikiTemplate = {
  id: "reading",
  name: "Reading",
  description: "Track a book's characters, themes, plot threads, and chapter notes",
  icon: "⚔️",
  extraDirs: ["wiki/characters", "wiki/themes", "wiki/plot-threads", "wiki/chapters"],
  schema: `# Wiki Schema — Reading a Book

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${SCHEMA_TYPES}
| character | wiki/characters/ | People and figures in the book |
| theme | wiki/themes/ | Recurring ideas, motifs, and symbolic threads |
| plot-thread | wiki/plot-threads/ | Storylines or narrative arcs being tracked |
| chapter | wiki/chapters/ | Per-chapter notes and summaries |

## Naming Conventions

${NAMING_RULES}
- Characters: character name in kebab-case (e.g., \`elizabeth-bennet.md\`)
- Themes: thematic noun phrase (e.g., \`social-class-mobility.md\`, \`deception-vs-honesty.md\`)
- Plot threads: arc description (e.g., \`darcys-redemption-arc.md\`)
- Chapters: \`ch-NN-slug.md\` (e.g., \`ch-01-opening-scene.md\`)

## Frontmatter

${FRONTMATTER_SPEC}

Character pages also include:
\`\`\`yaml
first_appearance: "Ch. N"
role: protagonist | antagonist | supporting | minor
\`\`\`

Chapter pages also include:
\`\`\`yaml
chapter: N
pages: "1-24"
\`\`\`

## Index Format

${INDEX_FORMAT}

## Log Format

${LOG_FORMAT}

## Cross-referencing Rules

${CROSSREF_RULES}
- Chapter notes reference characters appearing in that chapter via \`related:\`
- Theme pages link to the chapters where the theme is most prominent
- Plot thread pages list chapters that advance the arc

## Contradiction Handling

${CONTRADICTION_RULES}

## Reading-Specific Conventions

- Chapter pages are written during or immediately after reading — capture fresh reactions
- Distinguish between plot summary and personal interpretation in chapter notes
- Theme pages should track *development* across the book, not just state that a theme exists
- Flag unresolved plot threads with status: \`open\` until resolved
- Note page numbers for important quotes to enable re-finding later
`,
  purpose: `# Project Purpose — Reading

## Book Details

**Title:**
**Author:**
**Year:**
**Genre:**

## Why I'm Reading This

<!-- What drew you to this book? What do you hope to get from it? -->

## Key Themes to Track

<!-- What thematic threads do you expect or want to follow? -->

1.
2.
3.

## Questions Going In

<!-- What do you want answered or explored by the end? -->

1.
2.

## Reading Pace

**Started:**
**Target finish:**
**Current chapter:**

## First Impressions

<!-- Update after first chapter or first sitting. -->

>

## Final Takeaways

<!-- Fill in when finished. What did this book teach you? -->

>
`,
}

const personalTemplate: WikiTemplate = {
  id: "personal",
  name: "Personal Growth",
  description: "Track goals, habits, reflections, and journal entries for self-improvement",
  icon: "💕",
  extraDirs: ["wiki/goals", "wiki/habits", "wiki/reflections", "wiki/journal"],
  schema: `# Wiki Schema — Personal Growth

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${SCHEMA_TYPES}
| goal | wiki/goals/ | Specific outcomes you are working toward |
| habit | wiki/habits/ | Recurring behaviours and their tracking |
| reflection | wiki/reflections/ | Periodic reviews and lessons learned |
| journal | wiki/journal/ | Freeform daily or session entries |

## Naming Conventions

${NAMING_RULES}
- Goals: outcome as slug (e.g., \`run-a-marathon.md\`, \`learn-spanish.md\`)
- Habits: behaviour name (e.g., \`daily-meditation.md\`, \`morning-pages.md\`)
- Reflections: type + date (e.g., \`weekly-2024-03.md\`, \`quarterly-2024-q1.md\`)
- Journal: date slug (e.g., \`2024-03-15.md\`)

## Frontmatter

${FRONTMATTER_SPEC}

Goal pages also include:
\`\`\`yaml
target_date: YYYY-MM-DD
status: active | paused | achieved | abandoned
progress: 0-100
\`\`\`

Habit pages also include:
\`\`\`yaml
frequency: daily | weekly | monthly
streak: N
status: active | paused | dropped
\`\`\`

Reflection pages also include:
\`\`\`yaml
period: weekly | monthly | quarterly | annual
\`\`\`

## Index Format

${INDEX_FORMAT}

## Log Format

${LOG_FORMAT}

## Cross-referencing Rules

${CROSSREF_RULES}
- Reflection pages reference the goals and habits reviewed during that period
- Goals link to the habits that support them via \`related:\`
- Journal entries can reference goals and reflections inline with \`[[slug]]\`

## Contradiction Handling

${CONTRADICTION_RULES}

## Personal Growth Conventions

- Be honest in journal and reflection entries — this wiki is for you, not an audience
- Update goal progress fields regularly; stale data is worse than no data
- Distinguish between outcome goals (what you want) and process goals (what you will do)
- Reflect on *why* habits succeed or fail, not just whether they did
- Use the synthesis directory for cross-cutting insights that span multiple goals or periods
`,
  purpose: `# Project Purpose — Personal Growth

## Focus Areas

<!-- What areas of your life or self are you actively working on? -->

1.
2.
3.

## Motivation

<!-- Why now? What prompted you to start this wiki? -->

## Current Goals (Summary)

<!-- High-level list — create detailed goal pages in wiki/goals/ -->

- [ ]
- [ ]
- [ ]

## Active Habits

<!-- High-level list — create detailed habit pages in wiki/habits/ -->

-
-

## Review Cadence

**Daily journal:** Yes / No
**Weekly reflection:**
**Monthly reflection:**
**Quarterly reflection:**

## Guiding Principles

<!-- What values or principles guide your growth work? -->

1.
2.
3.

## This Year's Theme

<!-- One phrase or sentence that captures your intention for the year. -->

>
`,
}

const businessTemplate: WikiTemplate = {
  id: "business",
  name: "Business",
  description: "Manage meetings, decisions, projects, and stakeholder context for a team",
  icon: "🏰",
  extraDirs: ["wiki/meetings", "wiki/decisions", "wiki/projects", "wiki/stakeholders"],
  schema: `# Wiki Schema — Business / Team

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${SCHEMA_TYPES}
| meeting | wiki/meetings/ | Meeting notes, agendas, and action items |
| decision | wiki/decisions/ | Architectural or strategic decisions (ADR-style) |
| project | wiki/projects/ | Project briefs, status, and retrospectives |
| stakeholder | wiki/stakeholders/ | People, teams, and organisations involved |

## Naming Conventions

${NAMING_RULES}
- Meetings: \`YYYY-MM-DD-slug.md\` (e.g., \`2024-03-15-sprint-planning.md\`)
- Decisions: \`NNN-slug.md\` (e.g., \`001-adopt-typescript.md\`)
- Projects: descriptive slug (e.g., \`payments-redesign.md\`)
- Stakeholders: name or team in kebab-case (e.g., \`alice-chen.md\`, \`platform-team.md\`)

## Frontmatter

${FRONTMATTER_SPEC}

Meeting pages also include:
\`\`\`yaml
date: YYYY-MM-DD
attendees: []
action_items: []
\`\`\`

Decision pages also include:
\`\`\`yaml
status: proposed | accepted | deprecated | superseded
deciders: []
date: YYYY-MM-DD
supersedes: ""   # slug of ADR this replaces, if any
\`\`\`

Project pages also include:
\`\`\`yaml
status: planned | active | on-hold | complete | cancelled
owner: ""
start_date: YYYY-MM-DD
target_date: YYYY-MM-DD
\`\`\`

## Index Format

${INDEX_FORMAT}

## Log Format

${LOG_FORMAT}

## Cross-referencing Rules

${CROSSREF_RULES}
- Meeting notes reference attendees via \`attendees:\` frontmatter and \`[[stakeholder-slug]]\` links
- Decision pages link to the meetings where the decision was discussed
- Project pages link to their key decisions via \`related:\`
- Stakeholder pages list projects and decisions they are involved in

## Contradiction Handling

${CONTRADICTION_RULES}

## Business-Specific Conventions

- Write meeting notes during or within 24 hours — memory fades fast
- Action items must have a named owner and due date to be actionable
- Decision pages capture *context and consequences*, not just the decision itself
- Deprecated decisions should link to the decision that superseded them
- Projects should have a retrospective section added on completion
`,
  purpose: `# Project Purpose — Business / Team

## Business Context

**Organisation / Team:**
**Domain:**
**Time period covered:**

## Objectives

<!-- What are the top-level business objectives this wiki supports? -->

1.
2.
3.

## Key Projects

<!-- High-level list — create detailed pages in wiki/projects/ -->

-
-

## Key Stakeholders

<!-- Who are the primary people or teams involved? -->

-
-

## Open Decisions

<!-- Decisions currently in flight — create ADR pages in wiki/decisions/ -->

-
-

## Metrics / Success Criteria

<!-- How does the team measure progress toward its objectives? -->

-

## Constraints and Risks

<!-- Known constraints (budget, time, org) and risks to track -->

-

## Review Cadence

**Weekly sync notes:**
**Monthly status update:**
**Quarterly retrospective:**
`,
}

const generalTemplate: WikiTemplate = {
  id: "general",
  name: "General",
  description: "Minimal setup — a blank slate for any purpose",
  icon: "✍️",
  extraDirs: [],
  schema: `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
${SCHEMA_TYPES}

## Naming Conventions

${NAMING_RULES}

## Frontmatter

${FRONTMATTER_SPEC}

## Index Format

${INDEX_FORMAT}

## Log Format

${LOG_FORMAT}

## Cross-referencing Rules

${CROSSREF_RULES}

## Contradiction Handling

${CONTRADICTION_RULES}
`,
  purpose: `# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this project -->

1.
2.
3.

## Scope

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as the project progresses) -->

> TBD
`,
}

/** All available wiki project templates. */
/** F3（Round-1 评估）：小说演示模板 —— 零 API 也能打开试写。
 * 种子文件均为明确标注的演示样例（非伪造 AI 生成），用户可直接浏览
 * 大纲/人物卡/第一章样例，体验 Draft-first 审阅链路（本地规则审查
 * 可用，LLM 生成需配置模型服务）。 */
const novelDemoTemplate: WikiTemplate = {
  id: "novel-demo",
  name: "小说演示",
  description: "零配置试写：内置大纲 + 人物卡 + 第一章样例，无需 API",
  icon: "📖",
  extraDirs: ["wiki/chapters", "wiki/characters"],
  schema: `# Wiki Schema（小说演示项目）

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| chapter | wiki/chapters/ | 章节正文（含样例第一章） |
| character | wiki/characters/ | 人物卡 |
| outline | wiki/ | 大纲 |

## Naming Conventions

${NAMING_RULES}
`,
  purpose: `# Project Purpose（演示项目）

## Goal

零配置体验 niko-buddy 的写作链路：浏览样例大纲/人物卡/第一章，
试用审阅与记忆摄取（本地规则部分），配置模型服务后可真写续章。

## Key Questions

1. 样例第一章的人物状态是否被记忆正确摄取？
2. 审查中心的本地规则项对样例章打分如何？
`,
  seedFiles: [
    {
      path: "wiki/outline.md",
      content: `# 《雾港旧信》 · 大纲（演示样例）

> 本文件为演示样例，非 AI 生成，供零配置试写体验。

## 卷一 雾港

- 第 1 章（样例）：林晚收到旧宅钥匙，雾夜入宅发现旧信警告。
- 第 2 章（待写·需配置模型服务）：旧信末两行水渍下的字。
- 第 3 章（待写）：送钥匙的人现身。

## 核心悬念

- 旧信警告「不要相信送钥匙的人」——谁送的钥匙？
- 旧宅在第 3/4 章已被搜过——谁先到的？
`,
    },
    {
      path: "wiki/characters/lin-wan.md",
      content: `---
type: entity
title: 林晚
tags: [protagonist]
related: [old-house]
created: 2026-09-30
updated: 2026-09-30
---

# 林晚（演示样例人物卡）

> 本文件为演示样例。

- 身份：雾港晚报记者，对钥匙的掌控感随剧情加深。
- 状态：第 1 章后开始警惕送钥匙之人。
- 关系：与旧宅历史有隐秘联系（待展开）。
`,
    },
    {
      path: "wiki/chapters/chapter-001.md",
      content: `# 第 1 章 雾夜旧宅（演示样例）

> 本章为演示样例正文（约 800 字），非 AI 生成。配置模型服务后可续写第 2 章。

雾是半夜涨起来的。林晚把钥匙攥出汗时，渡口的汽笛正穿过雾，钝得像隔了一层水。

钥匙是三天前寄到的，没有寄件人，只有一张卡片：旧宅的东西，该你来拿。字迹她认得——五年前跑旧宅失火案时，档案袋上的批注就是这笔字。

她推开铁门。院子里的杂草结着白霜，堂屋的门虚掩着，门缝里漏出一线暖黄的光。有人先到了。或者说，有人一直没走。

桌上摆着一封信。信纸受过潮，末两行糊成一片深色的水渍。她把信举到灯下，只辨出半句：不要相信送——

送什么？送钥匙的人吗？她后颈一凉，回头看门。门缝里的光灭了。

（样例完。续写第 2 章需要配置模型服务：「设置 → LLM 提供商」。）
`,
    },
  ],
}

export const templates: WikiTemplate[] = [
  novelDemoTemplate,
  researchTemplate,
  readingTemplate,
  personalTemplate,
  businessTemplate,
  generalTemplate,
]

/**
 * Retrieve a template by its unique identifier.
 * @throws if the identifier does not match any registered template.
 */
export function getTemplate(id: string): WikiTemplate {
  const found = templates.find((t) => t.id === id)
  if (!found) throw new Error(`Unknown template id: "${id}"`)
  return found
}
