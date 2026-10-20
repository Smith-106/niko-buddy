import { fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseChapterMeta } from "@/lib/novel"
import { parseFrontmatter } from "@/lib/frontmatter"
import { formatChapterWriting } from "@/lib/chapter-formatting"
import { makeChapterFileName } from "@/lib/wiki-filename"
import type { FileNode } from "@/types/wiki"

export function inferEditorMode(path: string): "read" | "edit" {
  const normalized = path.replace(/\\/g, "/")
  // QM 为当前知识根，wiki 为 legacy——两者都进编辑模式
  if (
    normalized.includes("/QM/chapters/") || normalized.includes("/wiki/chapters/") ||
    normalized.includes("/QM/outlines/") || normalized.includes("/wiki/outlines/")
  ) {
    return "edit"
  }
  return "read"
}

// 选中文本去AI味/AI润色入口：组件级 deadline（统一约束 HTTP 与 Claude-CLI 通道，
// 并截断 5 分钟网络重试）。不改动 llm-client.ts 的全局 30 分钟默认值。
export const DE_AI_SELECTION_TIMEOUT_MS = 90_000

// 区分「模型全程零输出（疑似网络黑洞/冷启动失败）」与「部分生成后超时」的中文报错。
export function selectionTimeoutMessage(label: string, gotAnyToken: boolean): string {
  if (gotAnyToken) {
    return `${label}生成超时：已收到部分内容但 90 秒内未完成。请缩短选中文本或更换更快的模型后重试。`
  }
  return `${label}超时：模型在 90 秒内未返回任何内容，可能网络不通或代理不可达（本地代理 127.0.0.1:8756 未响应）、模型服务不可用或冷启动失败。请检查网络与模型设置后重试。`
}

export function isChapterPath(path: string): boolean {
  const n = path.replace(/\\/g, "/")
  return n.includes("/wiki/chapters/") || n.includes("/QM/chapters/")
}

export function isOutlinePath(path: string): boolean {
  const n = path.replace(/\\/g, "/")
  return n.includes("/wiki/outlines/") || n.includes("/QM/outlines/")
}

export function getDirName(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  /* v8 ignore start */
  return index >= 0 ? normalized.slice(0, index) : ""
  /* v8 ignore stop */
}

export async function getUniqueSiblingPath(dir: string, fileName: string, currentPath: string): Promise<string> {
  const firstPath = `${dir}/${fileName}`
  if (firstPath === currentPath || !(await fileExists(firstPath))) return firstPath
  const extensionIndex = fileName.lastIndexOf(".")
  /* v8 ignore start */
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  /* v8 ignore stop */
  /* v8 ignore start */
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  /* v8 ignore stop */
  for (let i = 2; i <= 99; i++) {
    const candidate = `${dir}/${stem}-${i}${extension}`
    if (candidate === currentPath || !(await fileExists(candidate))) return candidate
  }
  return `${dir}/${stem}-${Date.now()}${extension}`
}

export async function getCanonicalChapterPath(currentPath: string, markdown: string, chapterNumber: number | null): Promise<string> {
  const { frontmatter, body } = parseFrontmatter(markdown)
  const title = typeof (frontmatter as Record<string, unknown> | null)?.title === "string"
    ? String((frontmatter as Record<string, unknown>).title).trim()
    : body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ""
  if (!title) return currentPath
  return getUniqueSiblingPath(getDirName(currentPath), makeChapterFileName(title, chapterNumber), currentPath)
}

export function extractChapterNumberFromMarkdown(markdown: string): number | null {
  const { frontmatter } = parseFrontmatter(markdown)
  if (!frontmatter || typeof frontmatter !== "object") return null
  return parseChapterMeta(frontmatter as Record<string, unknown>)?.chapterNumber ?? null
}

export function formatWritingBodyWithIndent(markdown: string): string {
  return formatChapterWriting(markdown)
  /*
  const lines = body.split("\n")
  let inFence = false
  const formatted = lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    if (!trimmed) return line
    if (/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\|)/.test(trimmed)) return line
    if (/^\s*[-]{3,}\s*$/.test(trimmed)) return line
    if (/^\s*[　 ]{2}/.test(line)) return line
    return `　　${line}`
  })
  return rawBlock + formatted.join("\n")
  */
}

export function normalizeChapterWriting(markdown: string): string {
  return formatWritingBodyWithIndent(syncChapterFrontmatterTitle(markdown))
}

export function updateChapterHeading(markdown: string, nextTitle: string): string {
  const { rawBlock, body } = parseFrontmatter(markdown)
  const normalizedTitle = nextTitle.trim()
  const bodyWithoutHeading = body.replace(/^#\s+.+$(\r?\n)?/m, "").replace(/^\n+/, "")
  /* v8 ignore start */
  const nextBody = normalizedTitle
    ? `# ${normalizedTitle}${bodyWithoutHeading ? `\n\n${bodyWithoutHeading}` : "\n"}`
    : bodyWithoutHeading
  /* v8 ignore stop */
  return rawBlock + nextBody
}

export function syncChapterFrontmatterTitle(markdown: string): string {
  const { rawBlock, body, frontmatter } = parseFrontmatter(markdown)
  if (!rawBlock || !frontmatter) return markdown
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (!heading) return markdown
  const fmTitle = typeof (frontmatter as Record<string, unknown>).title === "string"
    ? String((frontmatter as Record<string, unknown>).title).trim()
    : ""
  if (!fmTitle || fmTitle === heading) return markdown
  const escaped = heading.replace(/"/g, '\\"')
  const nextRaw = rawBlock.replace(/^title:\s*.*$/m, `title: "${escaped}"`)
  return nextRaw + body
}

export function getChapterTitleFromPath(path: string): string {
  /* v8 ignore next */
  const fileName = normalizePath(path).split("/").pop() ?? ""
  return fileName.replace(/\.md$/i, "").trim()
}

export const CHAPTER_TITLE_MIN_WIDTH_PX = 48

/** 文件树 → 章节快捷入口（展示层只读投影：按章号倒序，最多 6 条）。 */
export function chapterOrderFromFileName(name: string): number {
  const match = name.match(/(\d{1,4})/)
  return match ? Number(match[1]) : 0
}

export function collectRecentChapterFiles(nodes: FileNode[]): { path: string; label: string; order: number }[] {
  const out: { path: string; label: string; order: number }[] = []
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        if (node.children) walk(node.children)
        continue
      }
      if (!/\.md$/i.test(node.name)) continue
      if (!isChapterPath(node.path)) continue
      out.push({ path: node.path, label: getChapterTitleFromPath(node.path), order: chapterOrderFromFileName(node.name) })
    }
  }
  walk(nodes)
  return out.sort((a, b) => b.order - a.order).slice(0, 6)
}
export const CHAPTER_TITLE_RESTING_EXTRA_WIDTH_PX = 2
export const CHAPTER_TITLE_EDITING_EXTRA_WIDTH_PX = 16
