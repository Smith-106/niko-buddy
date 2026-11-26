/**
 * context-engine-outline.ts — 大纲读取族 + emptyPack（纯搬迁，零逻辑变更）
 *
 * 从 context-engine.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 */
import {
  findChapterFileByNumber,
} from "./chapter-utils"
import {
  joinNonEmpty,
} from "./context-task-brief-builders"
import {
  flattenOutlineMarkdownFiles,
  groupOutlineSources,
  selectOutlineSources,
  includesChapterMarker,
  readFrontmatterChapterNumber,
} from "./context-engine-outline-helpers"
import {
  listDirectory,
  readFile,
} from "@/commands/fs"

import {
  parseFrontmatter,
} from "@/lib/frontmatter"
import {
  searchWiki,
} from "@/lib/search"
import {
  logger,
} from "@/lib/utils"

import { CHAPTER_OUTLINE_PROTECTED_CAP, currentBuildBudget, tieredSlice } from "./context-engine-gaps"
import type { ContextBuildSession } from "./context-data-source"
import type { ContextPack } from "./context-engine"

export function emptyPack(task: string): ContextPack {
  return {
    task,
    chapterGoal: "",
    outline: "",
    recentChapterContents: [],
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    voiceStyleGuide: undefined,
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    gaps: [],
    // EPIC-001/003: emptyPack 不注入（非小说模式 / legacy fallback）。
    styleExemplars: [],
    activeEntities: [],
  }
}

export async function readOutlineContent(pp: string): Promise<string> {
  try {
    const results = await searchWiki(pp, "outline type:outline")
    const selected = selectOutlineSources(results)
    if (selected.length > 0) {
      const contents = await Promise.all(
        selected.map(async (result) => {
          try {
            return await readFile(result.path)
          } catch {
            logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1702 })
            return ""
          }
        }),
      )
      return joinNonEmpty(contents, "\n\n---\n\n")
    }
  } catch {
    logger.warn("context-engine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1711 })
  }
  logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1709 })
  return ""
}

// ── outline 纯辅助子模块（arch-risk W4 god-object 拆分）───────────────────
// flattenOutlineMarkdownFiles/readFrontmatterChapterNumber/numberToChineseChapter/
// chapterLabels/includesChapterMarker 已抽离到 context-engine-outline-helpers.ts；
// import 供本模块使用。

/**
 * PERF-011 (TASK-007): resolve the protected-tier cap for chapter-outline
 * truncation. When invoked inside a `buildContextPack` call, the
 * module-level `currentBuildBudget` carries `computeContextBudget`'s
 * adaptive `maxPageSize` (driven by chapterAdaptiveScale + maxContextSize)
 * — chapter 500 gets a tighter cap than chapter 5, reflecting the larger
 * wiki at that point. Outside a build (direct `readChapterOutlineContent`
 * calls in tests / non-build paths), `currentBuildBudget` is null and we
 * fall back to the legacy static `CHAPTER_OUTLINE_PROTECTED_CAP` so
 * backward compatibility holds for every existing caller.
 */
export function resolveChapterOutlineProtectedCap(session?: ContextBuildSession): number {
  const budget = session ? session.budget : currentBuildBudget
  if (budget) return budget.maxPageSize
  return CHAPTER_OUTLINE_PROTECTED_CAP
}

export function pickChapterOutlineByNumber(
  candidates: Array<{ path: string; content: string }>,
  chapterNumber: number,
  session?: ContextBuildSession,
): string {
  const cap = resolveChapterOutlineProtectedCap(session)
  for (const group of groupOutlineSources(candidates)) {
    const frontmatterMatch = group.find((candidate) => readFrontmatterChapterNumber(candidate.content) === chapterNumber)
    if (frontmatterMatch) return tieredSlice(frontmatterMatch.content, "protected", cap, `chapter-outline:${chapterNumber}:frontmatter`, session)

    const headingMatch = group.find((candidate) =>
      includesChapterMarker(candidate.content, chapterNumber) || includesChapterMarker(candidate.path, chapterNumber),
    )
    if (headingMatch) return tieredSlice(headingMatch.content, "protected", cap, `chapter-outline:${chapterNumber}:heading`, session)
  }

  return ""
}

export async function readChapterOutlineDirect(
  pp: string,
  chapterNumber: number,
  session?: ContextBuildSession,
): Promise<string> {
  try {
    const tree = await listDirectory(`${pp}/wiki/outlines`)
    // 来源选择先于 first80；备份文件不能挤掉正式大纲，也不能凭较早的 frontmatter 胜出。
    const files = selectOutlineSources(flattenOutlineMarkdownFiles(tree))
    const scoped = files.slice(0, 80)
    const BATCH = 10
    // 组内仍按增量批读找 frontmatter 首见；读完该组后才用 heading 回退。
    for (const group of groupOutlineSources(scoped)) {
      const candidates: Array<{ path: string; content: string }> = []
      for (let i = 0; i < group.length; i += BATCH) {
        const batch = group.slice(i, i + BATCH)
        // 每次现读，不做跨调用内容缓存，避免大纲编辑后仍取旧内容。
        const contents = await Promise.all(
          batch.map((file) => readFile(file.path).catch(() => "")),
        )
        for (let j = 0; j < batch.length; j += 1) {
          candidates.push({ path: batch[j].path, content: contents[j] })
        }
        const prefixHit = candidates.find(
          (candidate) => readFrontmatterChapterNumber(candidate.content) === chapterNumber,
        )
        if (prefixHit) {
          return pickChapterOutlineByNumber(
            candidates.filter((candidate) => candidate.content.trim()),
            chapterNumber,
            session,
          )
        }
      }
      const fromWiki = pickChapterOutlineByNumber(
        candidates.filter((candidate) => candidate.content.trim()),
        chapterNumber,
        session,
      )
      if (fromWiki.trim()) return fromWiki
    }
  } catch {
    // fall through to project-root FILLED outlines (M1)
  }
  const rootFilled = await readProjectRootFilledOutline(pp, chapterNumber, session)
  if (rootFilled.trim()) return rootFilled

  // 探测骨架章节（大纲解构分发生成物：chapter_status: "planned" 或正文大纲梗概）
  try {
    const chapterFilePath = await findChapterFileByNumber(pp, chapterNumber)
    if (chapterFilePath) {
      const content = await readFile(chapterFilePath)
      const { frontmatter, body } = parseFrontmatter(content)
      const status = frontmatter?.chapter_status
      // 只要不是已经定稿完成的正式章节（例如 planned 或草稿中含有概要/大纲提示）
      if (status === "planned" || status === "draft" || status === "outline") {
        const summary = typeof frontmatter?.summary === "string" ? frontmatter.summary.trim() : ""
        const cleanBody = body.trim()
        if (summary || cleanBody) {
          const outlineText = summary
            ? `# 第${chapterNumber}章大纲纲要\n\n${summary}\n\n${cleanBody}`
            : cleanBody
          return tieredSlice(
            outlineText,
            "protected",
            resolveChapterOutlineProtectedCap(session),
            `chapter-outline:${chapterNumber}:skeleton`,
            session,
          )
        }
      }
    }
  } catch {
    // 降级忽略
  }

  return ""
}

/**
 * M1: projects that keep outlines as `Chapter-N-Outline-FILLED.md` at project root
 * (e.g. 8人 without wiki/) still feed buildContextPack. Prefer wiki/outlines when present.
 */
export async function readProjectRootFilledOutline(
  pp: string,
  chapterNumber: number,
  session?: ContextBuildSession,
): Promise<string> {
  const names = [
    `Chapter-${chapterNumber}-Outline-FILLED.md`,
    `Chapter-${chapterNumber}-Outline.md`,
    `chapter-${chapterNumber}-outline-filled.md`,
    `chapter-${chapterNumber}-outline.md`,
  ]
  for (const name of names) {
    try {
      const content = await readFile(`${pp}/${name}`)
      if (content.trim()) {
        return tieredSlice(
          content,
          "protected",
          resolveChapterOutlineProtectedCap(session),
          `chapter-outline:${chapterNumber}:project-root-filled`,
          session,
        )
      }
    } catch {
      // try next name
    }
  }
  return ""
}

export async function readChapterOutlineContent(
  pp: string,
  chapterNumber?: number,
  session?: ContextBuildSession,
): Promise<string> {
  if (!chapterNumber) return ""
  const direct = await readChapterOutlineDirect(pp, chapterNumber, session)
  if (direct.trim()) return direct
  const queries = [
    `第${chapterNumber}章细纲 outline`,
    `chapter ${chapterNumber} outline`,
    `chapter_number:${chapterNumber} outline_type:chapter-outline`,
  ]
  // PERF (odyssey-review): probe all queries concurrently, then pick the
  // first within the preferred source group (original query/result order).
  // Previously each query awaited searchWiki serially (up to 3×2 round-trips).
  const allResults = await Promise.all(
    queries.map((query) => searchWiki(pp, query).catch(() => [])),
  )
  const selectedResults = selectOutlineSources(allResults.flat())
  for (const result of selectedResults) {
    try {
      const content = await readFile(result.path)
      return tieredSlice(
        content,
        "protected",
        resolveChapterOutlineProtectedCap(session),
        `chapter-outline:${chapterNumber}:search`,
        session,
      )
    } catch {
      logger.warn("context-engine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1829 })
    }
    logger.warn("ContextEngine", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1876 })
  }

  return ""
}
