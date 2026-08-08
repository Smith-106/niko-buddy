/**
 * @license MIT © QMAI
 *
 * Dashboard issue state persistence, evidence matching, and
 * rewrite/insert operations for the novel quality dashboard.
 */
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import {
  rebuildChapterBody,
  replaceChapterBodySelection,
  splitChapterHeading,
  type ChapterBodySelection,
} from "@/lib/chapter-selection"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"

export interface DashboardIssueAnchor {
  evidence: string
  selection: ChapterBodySelection
}

export interface DashboardIssueRewriteBackup {
  itemId: string
  targetPath: string
  evidence: string
  originalText: string
  replacementText: string
  updatedAt: string
}

export interface DashboardFactCheckInsertPlan {
  anchorText: string
  insertText: string
}

export interface DashboardIssueState {
  ignored: Record<string, true>
  rewrites: Record<string, DashboardIssueRewriteBackup>
}

export interface DashboardRewriteMessage {
  role: "system" | "user"
  content: string
}

const STORE_FILE = ".qmai/dashboard-issues.json"

export function createEmptyDashboardIssueState(): DashboardIssueState {
  return { ignored: {}, rewrites: {} }
}

export function buildDashboardIssueId(parts: Array<string | number | null | undefined>): string {
  return parts.map((p) => String(p ?? "").trim()).map((p) => p.replace(/\s+/g, " ")).join("|")
}

export function getDashboardIssueStorePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${STORE_FILE}`
}

export async function loadDashboardIssueState(projectPath: string): Promise<DashboardIssueState> {
  try {
    const raw = await readFile(getDashboardIssueStorePath(projectPath))
    const parsed = JSON.parse(raw) as Partial<DashboardIssueState>
    return { ignored: normaliseIgnored(parsed.ignored), rewrites: normaliseRewrites(parsed.rewrites) }
  } catch {
    return createEmptyDashboardIssueState()
  }
}

export async function saveDashboardIssueState(projectPath: string, state: DashboardIssueState): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.qmai`).catch(() => {})
  await writeFile(
    getDashboardIssueStorePath(pp),
    JSON.stringify({ ignored: normaliseIgnored(state.ignored), rewrites: normaliseRewrites(state.rewrites) }, null, 2),
  )
}

/** Strip chapter prefixes, bracket markers, and surrounding quotes from evidence text. */
export function sanitizeDashboardEvidence(input: string): string {
  let text = String(input || "").trim()
  text = text.replace(/^第\s*\d+\s*章[：:]\s*/u, "")
  text = text.replace(/^\[[^\]]+\]\s*/u, "")
  text = text.replace(/^[“"'\[（(]+/u, "")
  text = text.replace(/[”"'\]）)]+$/u, "")
  return text.trim()
}

/** Locate evidence text within chapter body and return the selection. */
export function findChapterSelectionByEvidence(
  markdown: string,
  evidences: Array<string | null | undefined>,
): DashboardIssueAnchor | null {
  const { body: mdBody } = parseFrontmatter(markdown)
  const { body } = splitChapterHeading(mdBody)

  for (const evidence of evidences) {
    const candidate = sanitizeDashboardEvidence(evidence || "")
    if (!candidate) continue
    for (const snippet of buildCandidates(candidate)) {
      const start = body.indexOf(snippet)
      if (start < 0) continue
      return {
        evidence: candidate,
        selection: { start, end: start + snippet.length, text: body.slice(start, start + snippet.length), bodySnapshot: body },
      }
    }
  }
  return null
}

export function buildDashboardRewriteMessages(
  message: string,
  suggestion: string | undefined,
  sourceContent: string,
): DashboardRewriteMessage[] {
  return [
    {
      role: "system",
      content: ["你是长篇小说编辑。", "请根据问题说明和修改建议，直接改写给定正文片段。", "不要改变未被要求修改的剧情事实、人物关系、章节时序和关键信息。", "只输出修改后的正文片段，不要解释，不要加标题，不要加引号。"].join("\n"),
    },
    {
      role: "user",
      content: [
        `问题说明：${message}`,
        `修改建议：${suggestion || "请直接修正这个问题，并保持原段落信息不丢失。"}`,
        "需要修改的正文片段：",
        sourceContent,
      ].join("\n\n"),
    },
  ]
}

export function buildFactCheckInsertMessages(
  issueType: string,
  message: string,
  suggestion: string | undefined,
  evidenceA: string | undefined,
  evidenceB: string | undefined,
  chapterContent: string,
): DashboardRewriteMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是长篇小说编辑。",
        "请根据事实检查问题，为当前章节补写一小段必要的过渡事件。",
        "目标是补足中间因果、移动过程、物品转移或状态变化支撑，而不是整章重写。",
        "不要删除原文已有内容，不要改变章节主线，不要改动无关人物、时间线和设定。",
        "你必须先从当前章节正文中选择一个合适的插入锚点，再输出要插入的正文。",
        "只返回 JSON，不要解释，不要加代码块。",
        'JSON 格式：{"anchor_text":"从当前章节原文中原样复制的一句或一段锚点文本","insert_text":"需要补写到锚点前的正文内容"}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `问题类型：${issueType}`,
        `问题说明：${message}`,
        `修改建议：${suggestion || "请补足支撑这次事实变化的中间事件。"}`,
        evidenceA ? `上一处证据：${evidenceA}` : "",
        evidenceB ? `当前证据：${evidenceB}` : "",
        "当前章节正文：",
        chapterContent,
      ].filter(Boolean).join("\n\n"),
    },
  ]
}

export function parseFactCheckInsertPlan(raw: string): DashboardFactCheckInsertPlan | null {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
  if (!cleaned) return null
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const anchorText = String(parsed.anchorText || parsed.anchor_text || "").trim()
    const insertText = String(parsed.insertText || parsed.insert_text || "").trim()
    if (!anchorText || !insertText) return null
    return { anchorText, insertText }
  } catch {
    return null
  }
}

export function applyDashboardRewriteToMarkdown(
  markdown: string,
  anchor: DashboardIssueAnchor,
  replacement: string,
): string | null {
  const { rawBlock, body: mdBody } = parseFrontmatter(markdown)
  const { heading, body } = splitChapterHeading(mdBody)
  const result = replaceChapterBodySelection(body, anchor.selection, replacement)
  if (!result.ok) return null
  return rawBlock + rebuildChapterBody(heading, result.body)
}

export function applyDashboardInsertBeforeToMarkdown(
  markdown: string,
  anchor: DashboardIssueAnchor,
  insertion: string,
): string | null {
  const norm = insertion.trim()
  if (!norm) return null
  return applyDashboardRewriteToMarkdown(markdown, anchor, `${norm}\n${anchor.selection.text}`)
}

export function restoreDashboardRewriteInMarkdown(
  markdown: string,
  backup: DashboardIssueRewriteBackup,
): string | null {
  const { rawBlock, body: mdBody } = parseFrontmatter(markdown)
  const { heading, body } = splitChapterHeading(mdBody)

  const idx = body.indexOf(backup.replacementText)
  if (idx >= 0) {
    const restored = `${body.slice(0, idx)}${backup.originalText}${body.slice(idx + backup.replacementText.length)}`
    return rawBlock + rebuildChapterBody(heading, restored)
  }

  const anchor = findChapterSelectionByEvidence(markdown, [backup.evidence, backup.originalText])
  if (!anchor) return null
  const result = replaceChapterBodySelection(body, anchor.selection, backup.originalText)
  if (!result.ok) return null
  return rawBlock + rebuildChapterBody(heading, result.body)
}

// ── Internal helpers ───────────────────────────────────────────────

function buildCandidates(evidence: string): string[] {
  const direct = normaliseForMatch(evidence.trim())
  const parts = direct.split(/[，。！？；：“”‘’,.!?;:\n…]+/u).map((p) => p.trim()).filter((p) => p.length >= 4).sort((a, b) => b.length - a.length)
  const prefixes = buildPrefixes(direct)
  return Array.from(new Set([direct, ...parts, ...prefixes].filter(Boolean)))
}

function normaliseForMatch(e: string): string {
  return e.replace(/(\.\.\.|…)+$/u, "").replace(/[“”‘’]/gu, "").trim()
}

function buildPrefixes(evidence: string): string[] {
  const norm = evidence.trim()
  if (norm.length < 8) return norm ? [norm] : []
  const sizes = [Math.min(norm.length, 24), Math.min(norm.length, 18), Math.min(norm.length, 12)]
  return Array.from(new Set(sizes.filter((s) => s >= 8).map((s) => norm.slice(0, s).trim()).filter(Boolean)))
}

function normaliseIgnored(input: unknown): Record<string, true> {
  if (!input || typeof input !== "object") return {}
  const out: Record<string, true> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) if (v) out[k] = true
  return out
}

function normaliseRewrites(input: unknown): Record<string, DashboardIssueRewriteBackup> {
  if (!input || typeof input !== "object") return {}
  const out: Record<string, DashboardIssueRewriteBackup> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const r = v as Partial<DashboardIssueRewriteBackup>
    if (!r.itemId || !r.targetPath || !r.originalText || !r.replacementText) continue
    out[k] = {
      itemId: String(r.itemId), targetPath: String(r.targetPath),
      evidence: String(r.evidence || ""), originalText: String(r.originalText),
      replacementText: String(r.replacementText), updatedAt: String(r.updatedAt || ""),
    }
  }
  return out
}
