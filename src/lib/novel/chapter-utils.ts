/**
 * 章节工具函数集合。
 * MIT licensed implementation.
 *
 * 提供章节编号提取、文件树平铺、章节号解析等公共工具。
 */

import { listDirectory, readFile } from "@/commands/fs"
import type { NovelTaskIntent } from "./task-router"

/**
 * 从文本中提取章节编号。
 * MIT licensed implementation.
 *
 * @param text - 待解析文本
 * @returns 章节编号或 null
 */
export function extractChapterNumber(text: string): number | null {
  const m = text.match(/第\s*(\d+)\s*[章节回]/)
  if (m?.[1]) return Number.parseInt(m[1], 10)
  const n = text.match(/(\d+)/)
  if (n?.[1]) return Number.parseInt(n[1], 10)
  return null
}

/**
 * 将未知类型的流式累积值强制转换为字符串。
 * MIT licensed implementation.
 *
 * Consolidated (ISS-20260712-MAINT-3) from deep-outline-generation.ts:232 — the
 * `formatStageThinking` defensive path needs this so a non-string chunk
 * (undefined / null from a failed stream callback) renders as "" instead of
 * the literal "undefined" string.
 *
 * @param value - 待转换的值
 * @returns 字符串结果
 */
export function ensureString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * 格式化阶段思考内容为 Markdown 二级标题 + 修剪后的内容。
 * MIT licensed implementation.
 *
 * Consolidated (ISS-20260712-MAINT-3) from deep-chapter-generation.ts:1894
 * and deep-outline-generation.ts:228 — unified on the defensive variant
 * (ensureString before trim). Callers in deep-chapter always pass strings, so
 * ensureString is a no-op there; deep-outline relies on it for chunk safety.
 *
 * @param title - 标题文本
 * @param content - 内容文本
 * @returns 格式化后的 Markdown 字符串
 */
export function formatStageThinking(title: string, content: string): string {
  return `## ${title}\n${ensureString(content).trim()}`
}

/**
 * 递归平铺文件树为 .md 文件列表（不排序）。
 * MIT licensed implementation.
 *
 * Consolidated (ISS-20260712-MAINT-3) base shape shared by
 * export.ts / rebuild.ts (which want raw traversal order) and by
 * `flattenMdFiles` below (which adds chapter-number sort). Hoisting the base
 * keeps the two callers from re-implementing the recursion a third/fourth time.
 *
 * @param nodes - 文件树节点数组
 * @returns 平铺后的 .md 文件列表
 */
export function flattenMdFilesBase(
  nodes: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = []
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) out.push(...flattenMdFilesBase(node.children))
      continue
    }
    if (node.name.endsWith(".md")) {
      out.push({ name: node.name, path: node.path })
    }
  }
  return out
}

/**
 * 递归平铺文件树并按章节号排序。
 * MIT licensed implementation.
 *
 * @param nodes - 文件树节点数组
 * @returns 排序后的 .md 文件列表
 */
export function flattenMdFiles(nodes: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>): Array<{ name: string; path: string }> {
  return flattenMdFilesBase(nodes).sort((a, b) => {
    const aNum = extractChapterNumber(a.name)
    const bNum = extractChapterNumber(b.name)
    if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum
    if (aNum !== null && bNum === null) return -1
    if (aNum === null && bNum !== null) return 1
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })
  })
}

/**
 * 章节索引中单个章节文件的元数据（ISS-20260724-005）。
 * MIT licensed implementation.
 *
 * 保留原有编号来源优先级语义：文件名 → chapter_number frontmatter → title。
 * frontmatter 命中时 byTitle 保持 null（与旧逻辑的 else 分支一致）；
 * 单个文件读取失败时三个来源都为 null（与旧逻辑的 ignore unreadable 一致）。
 */
interface ChapterIndexEntry {
  name: string
  path: string
  /** 从文件名提取的章节号（无则 null） */
  byName: number | null
  /** frontmatter chapter_number（无则 null） */
  byFrontmatter: number | null
  /** title 提取的章节号（frontmatter 存在时保持 null） */
  byTitle: number | null
}

/**
 * 项目级章节元数据索引（ISS-20260724-005）。
 * MIT licensed implementation.
 */
interface ChapterIndex {
  entries: ChapterIndexEntry[]
}

const chapterIndexCache = new Map<string, ChapterIndex>()
const chapterIndexInflight = new Map<string, Promise<ChapterIndex>>()
const chapterIndexVersions = new Map<string, number>()

/**
 * 归一化项目路径作为缓存键：统一分隔符并去掉尾部斜杠，
 * 避免同一项目以不同写法命中不同缓存条目。
 */
function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * 读取单个章节文件的元数据条目。
 * MIT licensed implementation.
 */
async function readChapterIndexEntry(file: { name: string; path: string }): Promise<ChapterIndexEntry> {
  const byName = extractChapterNumber(file.name.replace(/\.md$/, ""))
  let byFrontmatter: number | null = null
  let byTitle: number | null = null
  try {
    const content = await readFile(file.path)
    const byFrontmatterMatch = content.match(/^chapter_number:\s*(\d+)\s*$/m)
    if (byFrontmatterMatch?.[1]) {
      byFrontmatter = Number.parseInt(byFrontmatterMatch[1], 10)
    } else {
      const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
      const extracted = titleMatch?.[1] ? extractChapterNumber(titleMatch[1]) : null
      byTitle = extracted
    }
  } catch {
    // ignore unreadable chapter file
  }
  return { name: file.name, path: file.path, byName, byFrontmatter, byTitle }
}

/**
 * 构建指定项目的章节元数据索引（一次 listDirectory + 每章一次 readFile）。
 * MIT licensed implementation.
 */
async function loadChapterIndex(projectPath: string): Promise<ChapterIndex> {
  const tree = await listDirectory(`${projectPath}/wiki/chapters`)
  const files = flattenMdFiles(tree)
  const entries: ChapterIndexEntry[] = []
  for (const file of files) {
    entries.push(await readChapterIndexEntry(file))
  }
  return { entries }
}

/**
 * 获取项目章节索引：命中缓存直接返回；未命中则加载并缓存。
 * 同一项目的并发调用共享同一次加载（in-flight 去重）。
 * 加载失败时不缓存（目录尚不存在等场景），下次调用自动重试。
 * MIT licensed implementation.
 */
async function getChapterIndex(projectPath: string): Promise<ChapterIndex> {
  const key = normalizeProjectPath(projectPath)
  const cached = chapterIndexCache.get(key)
  if (cached) return cached
  const inflight = chapterIndexInflight.get(key)
  if (inflight) return inflight
  const version = chapterIndexVersions.get(key) ?? 0
  const loading = (async () => {
    try {
      const index = await loadChapterIndex(projectPath)
      // 加载期间若发生过失效（写入/删除），丢弃本次快照，避免缓存过期数据
      if ((chapterIndexVersions.get(key) ?? 0) === version) {
        chapterIndexCache.set(key, index)
      }
      return index
    } finally {
      chapterIndexInflight.delete(key)
    }
  })()
  chapterIndexInflight.set(key, loading)
  return loading
}

/**
 * 使章节索引缓存失效。
 * MIT licensed implementation.
 *
 * 章节创建/保存/删除/导入后必须调用，否则后续 getNextChapterNumber /
 * findChapterFileByNumber 可能返回过期编号。不传 projectPath 时清空全部项目。
 *
 * @param projectPath - 项目根路径（可选；缺省清空所有项目缓存）
 */
export function invalidateChapterCache(projectPath?: string): void {
  if (projectPath) {
    const key = normalizeProjectPath(projectPath)
    chapterIndexCache.delete(key)
    chapterIndexInflight.delete(key)
    chapterIndexVersions.set(key, (chapterIndexVersions.get(key) ?? 0) + 1)
  } else {
    chapterIndexCache.clear()
    chapterIndexInflight.clear()
    chapterIndexVersions.clear()
  }
}

/**
 * 获取下一个章节编号。
 * MIT licensed implementation.
 *
 * 首次调用对指定项目构建一次元数据索引（一次 listDirectory + 每章一次
 * readFile），后续重复调用走内存聚合，不再逐章串行读盘（ISS-20260724-005）。
 * 章节增删后由调用方显式 invalidateChapterCache 失效。
 *
 * @param projectPath - 项目根路径
 * @returns 下一个可用的章节编号
 */
export async function getNextChapterNumber(projectPath: string): Promise<number> {
  let index: ChapterIndex
  try {
    index = await getChapterIndex(projectPath)
  } catch {
    // chapter dir may not exist yet
    index = { entries: [] }
  }
  let maxNum = 0
  let hasChapterOne = false
  for (const entry of index.entries) {
    if (entry.byName) {
      if (entry.byName === 1) hasChapterOne = true
      if (entry.byName > maxNum) maxNum = entry.byName
    }
    if (entry.byFrontmatter !== null) {
      if (entry.byFrontmatter === 1) hasChapterOne = true
      if (entry.byFrontmatter > maxNum) maxNum = entry.byFrontmatter
    } else if (entry.byTitle) {
      if (entry.byTitle === 1) hasChapterOne = true
      if (entry.byTitle > maxNum) maxNum = entry.byTitle
    }
  }
  if (!hasChapterOne && maxNum === 0) return 1
  return maxNum + 1
}

/**
 * 根据章节号查找对应的文件路径。
 * MIT licensed implementation.
 *
 * 复用项目章节索引缓存，不再对每个章节文件重复 readFile（ISS-20260724-005）。
 *
 * @param projectPath - 项目根路径
 * @param chapterNumber - 章节编号
 * @returns 文件路径或 null
 */
export async function findChapterFileByNumber(projectPath: string, chapterNumber: number): Promise<string | null> {
  let index: ChapterIndex
  try {
    index = await getChapterIndex(projectPath)
  } catch {
    // chapter dir may not exist yet
    index = { entries: [] }
  }
  for (const entry of index.entries) {
    if (entry.byName === chapterNumber) return entry.path
    if (entry.byFrontmatter === chapterNumber) return entry.path
  }
  return null
}

/**
 * 解析目标章节号的输入参数。
 * MIT licensed implementation.
 */
export interface ResolveTargetChapterNumberForChatInput {
  projectPath: string
  userRequest: string
  routeIntent?: NovelTaskIntent
  routeChapterNumber?: number
  selectedFile?: string | null
  /**
   * 当前会话里上一次已生成章节的章节号（可能还没保存到章节库）。
   * 修复 issue #6：第1章生成成功但尚未保存时，点击“继续生成下一章”
   * 不应因为章节库为空而再次生成第1章。
   */
  lastGeneratedChapterNumber?: number | null
}

/**
 * 解析聊天输入中的目标章节号。
 * MIT licensed implementation.
 *
 * 修复 issue #6：第 1 章生成成功但尚未保存时，点击“继续生成下一章”
 * 不应因为章节库为空而再次生成第 1 章。
 *
 * @param input - 解析输入参数
 * @returns 目标章节号或 undefined
 */
export async function resolveTargetChapterNumberForChat(input: ResolveTargetChapterNumberForChatInput): Promise<number | undefined> {
  if (input.routeChapterNumber && input.routeChapterNumber > 0) {
    return input.routeChapterNumber
  }

  if (!shouldResolveNextChapter(input.userRequest, input.routeIntent)) {
    return undefined
  }

  const lastGenerated = input.lastGeneratedChapterNumber ?? 0
  const minimumNextChapter = lastGenerated > 0 ? lastGenerated + 1 : 0

  const selectedChapterNumber = await readSelectedChapterNumber(input.selectedFile)
  if (selectedChapterNumber && selectedChapterNumber > 0) {
    return Math.max(selectedChapterNumber + 1, minimumNextChapter)
  }

  return Math.max(await getNextChapterNumber(input.projectPath), minimumNextChapter)
}

/**
 * 生成的章节内容的强标记模式（用于识别最后生成的章节号）。
 * MIT licensed implementation.
 */
const GENERATED_CHAPTER_PATTERNS = [
  // 深度生成思考过程中的目标章节标记
  /目标章节：第(\d+)章/,
  /按黄金三章规则生成第(\d+)章正文/,
  // 章节正文标题行
  /^#\s*第\s*(\d+)\s*章/m,
]

/**
 * 从会话的 AI 回复内容里识别上一次生成的章节号。
 * MIT licensed implementation.
 *
 * 只匹配章节生成特有的强标记（思考过程目标章节、正文标题行），
 * 避免普通问答里顺带提到“第 N 章”造成误判。
 *
 * @param assistantContents - AI 回复内容数组
 * @returns 最后生成的章节号或 undefined
 */
export function detectLastGeneratedChapterNumber(assistantContents: string[]): number | undefined {
  for (let index = assistantContents.length - 1; index >= 0; index -= 1) {
    const content = assistantContents[index]
    if (!content) continue
    for (const pattern of GENERATED_CHAPTER_PATTERNS) {
      const match = content.match(pattern)
      if (match?.[1]) {
        const chapterNumber = Number.parseInt(match[1], 10)
        if (Number.isFinite(chapterNumber) && chapterNumber > 0) return chapterNumber
      }
    }
  }
  return undefined
}

function shouldResolveNextChapter(userRequest: string, routeIntent?: NovelTaskIntent): boolean {
  if (routeIntent !== "continue_chapter" && routeIntent !== "write_chapter") return false
  const compact = userRequest.replace(/\s+/g, "")
  return /下一章|下1章|下章|新的?一章/.test(compact)
}

/**
 * 解析选中文件的章节号。
 * MIT licensed implementation.
 *
 * @param selectedFile - 选中文件路径
 * @returns 章节号或 undefined
 */
async function readSelectedChapterNumber(selectedFile?: string | null): Promise<number | undefined> {
  if (!selectedFile) return undefined
  const normalized = selectedFile.replace(/\\/g, "/")
  if (!/\/wiki\/chapters\//i.test(normalized)) return undefined

  /* v8 ignore next */
  const byName = extractChapterNumber(normalized.split("/").pop()?.replace(/\.md$/i, "") ?? "")
  if (byName) return byName

  try {
    const content = await readFile(selectedFile)
    const byFrontmatter = content.match(/^chapter_number:\s*(\d+)\s*$/m)
    if (byFrontmatter?.[1]) {
      const n = Number.parseInt(byFrontmatter[1], 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    // ignore unreadable selected chapter file
  }
  return undefined
}

/**
 * 解析选中文件的章节号（对外接口）。
 * MIT licensed implementation.
 *
 * @param selectedFile - 选中文件路径
 * @returns 章节号或 undefined
 */
export async function readSelectedChapterNumberForFile(selectedFile?: string | null): Promise<number | undefined> {
  return readSelectedChapterNumber(selectedFile)
}
