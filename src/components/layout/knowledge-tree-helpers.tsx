import { useTranslation } from "react-i18next"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fileExists } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { normalizeChapterStatus, resolveChapterTitle } from "@/lib/novel"
import { buildChapterWordCountLabel, getChapterStatusLabel } from "@/lib/chapter-display"
import { countChapterBodyWords } from "@/lib/chapter-word-count"
import type { ChapterStatus } from "@/lib/novel"
import type { KnowledgeCreateRequest } from "./knowledge-tree"

export interface WikiPageInfo {
  path: string
  title: string
  type: "chapter" | "outline"
  chapterNumber?: number
  tags: string[]
  origin?: string
  status?: ChapterStatus
  statusLabel?: string
  wordCount?: number
  wordCountLabel?: string
}

export interface KnowledgeTreeProps {
  filterType: "chapter" | "outline"
  refreshKey?: number
  pendingPages?: WikiPageInfo[]
  onRemovePendingPage?: (pagePath: string) => void
  onRequestCreate?: (request: KnowledgeCreateRequest) => void
}

export interface CreateMenuState {
  x: number
  y: number
  parentDir?: string
  targetFolderName?: string
  targetFolderPath?: string
}

export function parseChineseNumber(input: string): number | null {
  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }

  if (/^\d+$/.test(input)) return Number.parseInt(input, 10)
  if (input === "十") return 10

  const tenIndex = input.indexOf("十")
  if (tenIndex >= 0) {
    const left = input.slice(0, tenIndex)
    const right = input.slice(tenIndex + 1)
    const tens = left ? (digitMap[left] /* v8 ignore start */ /* v8 ignore stop */ ?? 0) : 1
    const units = right ? (digitMap[right] /* v8 ignore start */ /* v8 ignore stop */ ?? 0) : 0
    return tens * 10 + units
  }

  let value = 0
  for (const ch of input) {
    const digit = digitMap[ch]
    if (digit === undefined) return null
    value = value * 10 + digit
  }
  return value
}

export function extractPageOrderFromTitle(title: string): number | null {
  const titleMatch = title.match(/第\s*([0-9零一二两三四五六七八九十]+)\s*[章节卷]/)
  if (titleMatch?.[1]) {
    const value = parseChineseNumber(titleMatch[1])
    if (value !== null) return value
  }

  const numberMatch = title.match(/(\d+)/)
  if (numberMatch?.[1]) return Number.parseInt(numberMatch[1], 10)
  return null
}

export function extractChapterNumberFromContent(content: string): number | null {
  const match = content.match(/^chapter_number:\s*(\d+)\s*$/m)
  if (!match?.[1]) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function getDirName(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  /* v8 ignore start */
  return index >= 0 ? normalized.slice(0, index) : ""
  /* v8 ignore stop */
}

export async function getUniquePagePath(dir: string, fileName: string, excludePath?: string): Promise<string> {
  const firstPath = `${dir}/${fileName}`
  if (firstPath === excludePath || !(await fileExists(firstPath))) return firstPath

  const extensionIndex = fileName.lastIndexOf(".")
  /* v8 ignore start */
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  /* v8 ignore stop */
  /* v8 ignore start */
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  /* v8 ignore stop */
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${dir}/${stem}-${index}${extension}`
    if (candidate === excludePath || !(await fileExists(candidate))) return candidate
  }

  return `${dir}/${stem}-${Date.now()}${extension}`
}

export function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
      continue
    }
    if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

export function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
      continue
    }
    if (!node.is_dir) files.push(node)
  }
  return files
}

export async function cleanupDeletedSourceMemory(
  projectPath: string,
  input: { kind: "chapter" | "outline"; pagePath: string; content?: string },
): Promise<void> {
  const { deleteNovelSourceMemory } = await import("@/lib/novel/delete-source-memory")
  await deleteNovelSourceMemory(projectPath, input)
}

export function parsePageInfo(path: string, fileName: string, content: string): WikiPageInfo | null {
  const normalizedPath = normalizePath(path)
  const type = normalizedPath.includes("/wiki/chapters/") ? "chapter" : normalizedPath.includes("/wiki/outlines/") ? "outline" : null
  if (!type) return null

  let title = fileName.replace(/\.md$/, "").replace(/-/g, " ")
  const tags: string[] = []
  let origin: string | undefined
  let status: ChapterStatus | undefined

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1]
    const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch?.[1]) title = titleMatch[1].trim()

    const tagsMatch = frontmatter.match(/^tags:\s*\[(.+?)\]/m)
    if (tagsMatch?.[1]) {
      tags.push(...tagsMatch[1].split(",").map((value) => value.trim().replace(/["']/g, "")))
    }

    const originMatch = frontmatter.match(/^origin:\s*(.+)$/m)
    if (originMatch?.[1]) origin = originMatch[1].trim()

    if (type === "chapter") {
      const statusMatch = frontmatter.match(/^chapter_status:\s*["']?(.+?)["']?\s*$/m)
      status = normalizeChapterStatus(statusMatch?.[1])
    }
  }

  if (title === fileName.replace(/\.md$/, "").replace(/-/g, " ")) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    if (headingMatch?.[1]) title = headingMatch[1].trim()
  }

  // 裸标签升级：frontmatter 只有「第N章」时，用正文富 H1 的章节名（resolveChapterTitle 只升级不降级）
  if (type === "chapter") title = resolveChapterTitle(content, title)

  const wordCount = type === "chapter" ? countChapterBodyWords(content) : undefined
  const chapterNumber = type === "chapter"
    ? (extractChapterNumberFromContent(content) ?? extractPageOrderFromTitle(title) ?? undefined)
    : undefined

  return {
    path: normalizedPath,
    title,
    type,
    chapterNumber,
    tags,
    origin,
    status,
    statusLabel: status ? getChapterStatusLabel(status) : undefined,
    wordCount,
    wordCountLabel: typeof wordCount === "number" ? buildChapterWordCountLabel(wordCount) : undefined,
  }
}

/**
 * 章节状态点配色（Draft-first 可见性）。
 *
 * 背景（findings-2 W-10 / findings-1 F-10，2026-10-16）：parsePageInfo 早已解析出
 * `status/statusLabel`，但列表行只渲染字数 —— 作者在「选章」这一步无法分辨哪章是草稿、
 * 哪章已定稿，而这正是 Draft-first 工作流每日第一个要判断的信息。
 * 这里把已有只读数据渲染为一个带 tooltip + aria-label 的状态点（不新增真源、不改主链）。
 */
export function chapterStatusDotClass(status: ChapterStatus | undefined): string {
  switch (status) {
    case "final":
      return "bg-success"
    case "revised":
      return "bg-warning"
    case "draft":
      return "bg-muted-foreground/60"
    case "archived":
      return "bg-muted-foreground/30"
    default:
      return "bg-muted-foreground/40"
  }
}

export function findNodeByPath(nodes: FileNode[], targetPath: string): FileNode | null {
  for (const node of nodes) {
    if (normalizePath(node.path) === targetPath) return node
    if (node.is_dir && node.children) {
      const childMatch = findNodeByPath(node.children, targetPath)
      if (childMatch) return childMatch
    }
  }
  return null
}

export function sortFileNodes(
  nodes: readonly FileNode[],
  pageInfoByPath: Map<string, WikiPageInfo>,
  filterType: "chapter" | "outline",
): FileNode[] {
  return [...nodes].sort((left, right) => {
    if (left.is_dir && !right.is_dir) return -1
    if (!left.is_dir && right.is_dir) return 1
    if (left.is_dir && right.is_dir) return left.name.localeCompare(right.name, "zh-CN")

    const leftInfo = pageInfoByPath.get(normalizePath(left.path))
    const rightInfo = pageInfoByPath.get(normalizePath(right.path))
    /* v8 ignore next */
    if (filterType === "chapter" || filterType === "outline") {
      const leftOrder = leftInfo?.chapterNumber ?? extractPageOrderFromTitle(leftInfo?.title ?? left.name)
      const rightOrder = rightInfo?.chapterNumber ?? extractPageOrderFromTitle(rightInfo?.title ?? right.name)
      if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
        return leftOrder - rightOrder
      }
      if (leftOrder !== null && rightOrder === null) return -1
      if (leftOrder === null && rightOrder !== null) return 1
    }

    return (leftInfo?.title ?? left.name).localeCompare(rightInfo?.title ?? right.name, "zh-CN")
  })
}

export function countMarkdownDescendants(node: FileNode): number {
  if (!node.is_dir) return node.name.endsWith(".md") ? 1 : 0
  return (node.children ?? []).reduce((total, child) => total + countMarkdownDescendants(child), 0)
}

export function DeleteButton({
  armed,
  deleting,
  onClick,
  name,
  className = "",
}: {
  armed: boolean
  deleting: boolean
  onClick: () => void
  name: string
  className?: string
}) {
  const { t } = useTranslation()

  if (deleting) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 shrink-0 cursor-default ${className}`}
        disabled
        title={t("knowledgeTree.deletingTitle", { name })}
        aria-label={t("common.delete")}
      >
        <Trash2 className="h-3 w-3 shrink-0 animate-pulse text-destructive" />
      </Button>
    )
  }

  if (armed) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={`h-6 shrink-0 px-1.5 text-xs font-semibold animate-pulse ${className}`}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        title={t("knowledgeTree.confirmDeleteTitle", { name })}
      >
        <Trash2 className="mr-0.5 h-3 w-3 shrink-0" />
        {t("knowledgeTree.confirmDelete")}
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive ${className}`}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      title={t("knowledgeTree.deleteTitle", { name })}
    >
      <Trash2 className="h-3 w-3 shrink-0" />
    </Button>
  )
}
