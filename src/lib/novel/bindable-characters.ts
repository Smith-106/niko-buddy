/**
 * ISS-20260712-ARCH-1 (Wave 1, 第 2 文件): 可绑定角色列表集群 (outline 角色解析)。
 *
 * 从 character-aura.ts 抽出——该集群是独立抽象层 (从 wiki/entities + wiki/outlines
 * markdown 树解析可绑定角色名, 供 aura 绑定下拉用), 与 character-aura.ts 的 aura
 * store CRUD / aura 匹配 / 自定义 aura 生成流水线正交。守 S-20260720-86pp
 * (SRP 巨文件拆分按抽象层分文件, 非按函数数量机械分)。
 *
 * listBindableNovelCharacters 由 character-aura.ts re-export 保持向后兼容
 * (3 个组件 use-library-operations / character-aura-view / book-analysis-result-viewer
 * 的 import 路径不变, 守 Never break backward compatibility)。
 */
import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"

function extractEntityTags(fm: Record<string, FrontmatterValue> | null): string[] {
  if (!fm) return []
  const tags = fm.tags
  if (!tags) return []
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim().toLowerCase())
  return String(tags).split(",").map((t) => t.trim().toLowerCase())
}

function isCharacterEntityContent(content: string): boolean {
  const { frontmatter } = parseFrontmatter(content)
  if (!frontmatter) return false
  if (frontmatter.type !== "entity") return false
  const tags = extractEntityTags(frontmatter)
  return tags.includes("character")
}

const IGNORE_BINDABLE_CHARACTER_NAMES = new Set([
  "人物小传",
  "人物设定",
  "角色设定",
  "角色小传",
  "主要人物",
  "配角",
  "人物关系",
  "角色关系",
  "总大纲",
  "章节细纲",
])

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "")
}

function extractPrimaryTitle(content: string, fallbackFileName: string): string {
  const frontmatterTitle = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
  if (frontmatterTitle) return frontmatterTitle
  const headingTitle = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (headingTitle) return headingTitle
  return stripFileExtension(fallbackFileName)
}

function flattenMarkdownNodes(nodes: { name: string; path: string; is_dir: boolean; children?: unknown[] }[]): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = []
  for (const node of nodes) {
    if (node.is_dir && Array.isArray(node.children)) {
      files.push(...flattenMarkdownNodes(node.children as { name: string; path: string; is_dir: boolean; children?: unknown[] }[]))
      continue
    }
    if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) {
      files.push({ name: node.name, path: normalizePath(node.path) })
    }
  }
  return files
}

function isCharacterOutlineFile(filePath: string, pageTitle: string, content: string): boolean {
  const normalizedPath = normalizePath(filePath)
  return (
    /人物|角色/.test(normalizedPath)
    || /人物|角色/.test(pageTitle)
    || /^outline_category:\s*characters\s*$/m.test(content)
  )
}

type OutlineCharacterSection = {
  level: number
  title: string
  body: string
}

const NON_CHARACTER_OUTLINE_TITLE_PATTERNS = [
  /总览$/,
  /整体状态$/,
  /关系$/,
  /线$/,
  /小队$/,
  /残部$/,
]

function isBindableCharacterOutlineSection(section: OutlineCharacterSection): boolean {
  const title = section.title.trim()
  if (!title) return false
  if (IGNORE_BINDABLE_CHARACTER_NAMES.has(title)) return false
  if (NON_CHARACTER_OUTLINE_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return false
  if (/性格与群像定位/.test(section.body)) return false
  return true
}

function extractCharacterNamesFromOutline(content: string): string[] {
  const names = new Set<string>()
  const addName = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 40) return
    if (IGNORE_BINDABLE_CHARACTER_NAMES.has(trimmed)) return
    names.add(trimmed)
  }

  const headingMatches = [...content.matchAll(/^(#{2,6})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    title: match[2].replace(/[：:].*$/, "").trim(),
    index: match.index ?? 0,
    rawLength: match[0].length,
  }))

  if (headingMatches.length === 0) return []

  const headingLevelCounts = new Map<number, number>()
  for (const match of headingMatches) {
    headingLevelCounts.set(match.level, (headingLevelCounts.get(match.level) ?? 0) + 1)
  }

  const primaryHeadingLevel =
    [2, 3, 4, 5, 6].find((level) => (headingLevelCounts.get(level) ?? 0) >= 2)
    ?? Math.min(...headingMatches.map((match) => match.level))

  const primarySections: OutlineCharacterSection[] = headingMatches
    .filter((match) => match.level === primaryHeadingLevel)
    .map((match, index, matches) => {
      const nextMatch = matches[index + 1]
      const bodyStart = match.index + match.rawLength
      const bodyEnd = nextMatch?.index ?? content.length
      return {
        level: match.level,
        title: match.title,
        body: content.slice(bodyStart, bodyEnd),
      }
    })

  for (const section of primarySections) {
    if (isBindableCharacterOutlineSection(section)) {
      addName(section.title)
    }
  }

  return [...names]
}

export async function listBindableNovelCharacters(projectPath: string): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const names = new Set<string>()

  const addName = (value: string | null | undefined) => {
    const trimmed = value?.trim()
    if (!trimmed || trimmed.length > 40) return
    if (IGNORE_BINDABLE_CHARACTER_NAMES.has(trimmed)) return
    names.add(trimmed)
  }

  try {
    const entityTree = await listDirectory(`${pp}/wiki/entities`)
    for (const file of flattenMarkdownNodes(entityTree)) {
      try {
        const content = await readFile(file.path)
        if (!isCharacterEntityContent(content)) continue
        addName(extractPrimaryTitle(content, file.name))
      } catch {
        // Skip entities that can't be read.
      }
    }
  } catch {
    // Projects may not have entity pages yet.
  }

  try {
    const outlineTree = await listDirectory(`${pp}/wiki/outlines`)
    for (const file of flattenMarkdownNodes(outlineTree)) {
      try {
        const content = await readFile(file.path)
        const pageTitle = extractPrimaryTitle(content, file.name)
        if (!isCharacterOutlineFile(file.path, pageTitle, content)) continue
        const extractedNames = extractCharacterNamesFromOutline(content)
        if (extractedNames.length === 0) {
          addName(pageTitle)
          continue
        }
        for (const characterName of extractedNames) {
          addName(characterName)
        }
      } catch {
        // Keep the dropdown resilient when a single outline page is broken.
      }
    }
  } catch {
    // Projects may not have outline pages yet.
  }

  return [...names].sort((left, right) => left.localeCompare(right, "zh-CN"))
}
