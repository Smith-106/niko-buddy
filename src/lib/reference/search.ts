/**
 * Wave 2 @引用系统 — IO 编排层。
 *
 * searchReferences：novelMixedSearch 薄封装（三路融合 + LRU 缓存 + 并发上限）。
 * buildReferenceContext：全链路（parse → resolve → search → 格式化引用段）。
 */

import type {
  ReferenceContextOptions,
  ReferenceSearchHit,
  ResolvedReference,
} from "./types"
import { parseReferences, resolveReferences } from "./resolve"
import { loadAllReferenceCandidates } from "./providers"
import { novelMixedSearch } from "@/lib/novel/search-adapter"
import { getUserPreferenceText } from "@/lib/user-memory/store"
import { loadUserMemoryForProject } from "@/lib/user-memory/session"
import { clipText } from "@/lib/novel/character-aura-utils"

/** 引用段字符上限（与 relatedChapters 同量级） */
export const REFERENCE_SECTION_CAP = 2000
/** 每条 snippet 上限 */
export const REFERENCE_SNIPPET_CAP = 300
/** 每引用检索 topK */
export const REFERENCE_TOP_K = 3
/** LRU 缓存上限 */
export const REFERENCE_CACHE_MAX = 16
/** 并发检索上限（信号量，禁裸 Promise.all 全量） */
export const REFERENCE_CONCURRENCY_LIMIT = 3

interface CacheEntry {
  key: string
  hits: ReferenceSearchHit[]
}

const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): ReferenceSearchHit[] | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  // LRU touch：删除后重插
  cache.delete(key)
  cache.set(key, entry)
  return entry.hits
}

function cacheSet(key: string, hits: ReferenceSearchHit[]): void {
  cache.delete(key)
  cache.set(key, { key, hits })
  while (cache.size > REFERENCE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 测试辅助：清空检索缓存 */
export function clearReferenceCache(): void {
  cache.clear()
}

/**
 * 单引用检索（novelMixedSearch 薄封装）。
 * 三路融合默认全开（keyword+vector+graph）；章节引用才开 recent_chapter；canon 恒关。
 */
async function searchOneReference(
  ref: ResolvedReference,
  projectPath: string,
  chapterNumber: number | undefined,
  topK: number,
): Promise<ReferenceSearchHit[]> {
  const key = `${projectPath}|${ref.name}|${topK}`
  const cached = cacheGet(key)
  if (cached) return cached

  const results = await novelMixedSearch({
    projectPath,
    query: ref.name,
    chapterNumber,
    topK,
    authoritativeOnly: true,
    includeKeyword: true,
    includeVector: true,
    includeGraph: true,
    includeRecentChapters: ref.kind === "chapter",
    includeCanon: false,
  })

  const hits: ReferenceSearchHit[] = results.map((r) => ({
    refId: ref.id,
    kind: ref.kind,
    name: ref.name,
    type: r.type,
    path: r.path,
    title: r.title,
    snippet: r.snippet,
    relevance: r.relevance,
  }))
  cacheSet(key, hits)
  return hits
}

/** 信号量：并发上限 REFERENCE_CONCURRENCY_LIMIT */
async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]!()
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 多引用并行检索（并发 ≤3，失败单条降级空数组不阻断整体）。
 */
export async function searchReferences(
  projectPath: string,
  refs: ResolvedReference[],
  options: { chapterNumber?: number; topK?: number } = {},
): Promise<ReferenceSearchHit[]> {
  if (refs.length === 0) return []
  const topK = options.topK ?? REFERENCE_TOP_K
  const nested = await runWithConcurrencyLimit(
    refs.map((ref) => () =>
      searchOneReference(ref, projectPath, options.chapterNumber, topK).catch(
        () => [] as ReferenceSearchHit[],
      ),
    ),
    REFERENCE_CONCURRENCY_LIMIT,
  )
  return nested.flat()
}

/** 格式化单条引用段（用户记忆偏好 + 检索 snippet + 歧义标注） */
export function formatReferenceSection(
  ref: ResolvedReference,
  hits: ReferenceSearchHit[],
  userMemoryText: string,
  snippetCap: number,
): string {
  const lines: string[] = []
  lines.push(`【@${ref.name}】`)
  if (userMemoryText) {
    lines.push(`- 用户记忆：${userMemoryText}`)
  }
  if (hits.length > 0) {
    lines.push("- 检索：")
    for (const hit of hits.slice(0, REFERENCE_TOP_K)) {
      lines.push(`  - ${hit.title}（${hit.path}）：${clipText(hit.snippet, snippetCap)}`)
    }
  }
  if (ref.ambiguity) {
    lines.push("（歧义，默认取第一候选）")
  }
  return lines.join("\n")
}

/**
 * 全链路：从任务文本解析 @ 引用 → 候选装载 → 检索 → 格式化引用段。
 * 失败降级返回空字符串（不阻断 pack 装配）。
 */
export async function buildReferenceContext(
  projectPath: string,
  task: string,
  options: ReferenceContextOptions = {},
): Promise<string> {
  const tokens = parseReferences(task)
  if (tokens.length === 0) return ""

  const candidates = await loadAllReferenceCandidates(projectPath).catch(() => [])
  const refs = resolveReferences(tokens, candidates)
  if (refs.length === 0) return ""

  const hits = await searchReferences(projectPath, refs, {
    chapterNumber: options.chapterNumber,
    topK: options.topK ?? REFERENCE_TOP_K,
  })

  // Wave 1 联动（PR6 通道）：注入全局用户记忆偏好原文
  let userMemoryText = ""
  if (options.includeUserMemory !== false) {
    try {
      const store = await loadUserMemoryForProject(projectPath)
      userMemoryText = getUserPreferenceText(store)
    } catch {
      userMemoryText = ""
    }
  }

  const sectionCap = options.sectionCap ?? REFERENCE_SECTION_CAP
  const snippetCap = options.snippetCap ?? REFERENCE_SNIPPET_CAP
  const sections = refs.map((ref) =>
    formatReferenceSection(
      ref,
      hits.filter((h) => h.refId === ref.id),
      userMemoryText,
      snippetCap,
    ),
  )
  const joined = sections.join("\n\n")
  return clipText(joined, sectionCap)
}
