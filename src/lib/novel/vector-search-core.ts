import { readFile } from "@/commands/fs"
import type { PageSearchResult } from "@/lib/embedding"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"
import { sanitizeEntitySlug } from "./graph-adapter"

/**
 * P1-IMP-14 (PAT-G2 孪生归一): 向量检索共享核心。
 *
 * search-adapter.runVectorSearch 与 context-engine.runVectorSearchForContext 是同形
 * 孪生（PERF-NEW-06 并行 probe / SEC-001 sanitize / 300 字 snippet 折叠 / dirs 优先
 * 序），此前双份实现各自演化 —— 任一侧改 sanitize 或 probe 顺序，另一侧静默漂移。
 * 本模块把公共流程收一，只参数化两侧真实存在的差异：
 *   1. selectCandidates（候选分组/筛选）：adapter = slice(0, limit)（无门控）；
 *      context = IC-02 相关性门控 + ContextGap 记账（回调在调用侧完成，
 *      保持 vector-relevance / contextGaps 不下沉到检索适配层）。
 *   2. perItemGuard（逐条异常守卫）：adapter 单条 throw → 跳过该条；
 *      context 无内层 try → 冒泡外层 catch → 整批 []。默认 false（context 语义）。
 *   3. sanitize / dirs 可注入（默认共用 sanitizeEntitySlug + 6 目录序）—— 两侧当前
 *      完全一致，参数化只为后续单侧调整时有显式接缝。
 * 命中投影（NovelSearchResult vs {title,snippet,path}）留在各自薄包装里，
 * 投影是纯函数（不抛错），后置映射与原先循环内 push 逐元素等价（顺序守恒）。
 *
 * 独立成模块（而非留在 search-adapter.ts）的原因：context-engine.spec /
 * context-pack-freeze.spec 以 `vi.mock("./search-adapter")` 整体替换该模块，
 * 若核心挂在 search-adapter 导出面上，两处既有 spec 会拿到 undefined。
 * 本模块无既有 mock 覆盖，两侧孪生共用同一份真实实现。
 */

/** probe 候选目录（声明序即优先级）—— 两孪生历史一致，收一为单一常量。 */
export const VECTOR_WIKI_DIRS: readonly string[] = [
  "entities",
  "concepts",
  "sources",
  "synthesis",
  "comparison",
  "queries",
]

/** 标题三级回退：Markdown H1 → frontmatter title → 兜底 slug。 */
export function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)/m)
  if (match) return match[1].trim()
  const fmMatch = content.match(/^---\ntitle:\s*(.+)/m)
  if (fmMatch) return fmMatch[1].trim()
  return fallback
}

export interface VectorSearchProbeHit {
  /** 原始向量结果（LanceDB page_id + score）；relevance 由调用方自取。 */
  vr: PageSearchResult
  /** sanitize 后的 slug（同时是标题回退值）。 */
  safeId: string
  /** 首个命中的 wiki 路径（dirs 声明序优先，再回退 wiki 根）。 */
  path: string
  /** H1 → frontmatter title → safeId。 */
  title: string
  /** 正文前 300 字，换行折叠为空格。 */
  snippet: string
}

export interface VectorSearchSharedOptions {
  pp: string
  query: string
  /** 结果上限（同时决定 fetch 宽度 Math.max(limit * 2, 10)）。 */
  limit: number
  /** 显式 embedding 配置（缺省回退 useWikiStore，两侧原语义一致）。 */
  embCfg?: EmbeddingConfig
  /** 候选 wiki 子目录（声明序 = probe 优先级）。 */
  dirs?: readonly string[]
  /** id → 安全 slug（SEC-001, CWE-22 唯一路径穿越边界）。 */
  sanitize?: (id: string) => string
  /** 候选筛选（差异点 1）；缺省 slice(0, limit)。 */
  selectCandidates?: (results: PageSearchResult[], limit: number) => PageSearchResult[]
  /** 逐条异常守卫（差异点 2）；缺省 false = 冒泡外层 catch。 */
  perItemGuard?: boolean
}

export async function runVectorSearchShared(
  options: VectorSearchSharedOptions,
): Promise<VectorSearchProbeHit[]> {
  const {
    pp,
    query,
    limit,
    embCfg,
    dirs = VECTOR_WIKI_DIRS,
    sanitize = sanitizeEntitySlug,
    selectCandidates = (results, n) => results.slice(0, n),
    perItemGuard = false,
  } = options

  const embCfgResolved = embCfg ?? useWikiStore.getState().embeddingConfig
  if (!embCfgResolved.enabled || !embCfgResolved.model) return []

  try {
    const { searchByEmbedding } = await import("@/lib/embedding")
    const vectorResults = await searchByEmbedding(pp, query, embCfgResolved, Math.max(limit * 2, 10))
    if (vectorResults.length === 0) return []

    const candidates = selectCandidates(vectorResults, limit)

    // PERF-NEW-06/PAT-G2 (odyssey-improve): parallelize the per-vr path probe.
    // 两孪生此前均为串行 `for (dir of dirs) await readFile(...)`（每 vr 最多 7 次
    // 串行 IPC，N×7 最坏）；现每个 vr 并发 probe 全部 7 个候选路径（6 目录 + 根），
    // 按 settled 声明序取首个成功项，保留 dirs 优先于根的回退语义。
    const probePath = async (
      tryPath: string,
    ): Promise<{ path: string; content: string } | null> => {
      try {
        const content = await readFile(tryPath)
        return { path: tryPath, content }
      } catch {
        return null
      }
    }

    const hits: VectorSearchProbeHit[] = []
    for (const vr of candidates) {
      // SEC-001 (odyssey-review, CWE-22): sanitize vr.id (LanceDB page_id) before
      // path construction. vr.id 是 LanceDB 外部存储态（手工改库 / 非实体写入路径 /
      // 未来 embedPage 调用方均可污染）；Rust readFile 无项目根约束，本 TS path join
      // 是唯一的穿越边界（写入侧 chapter-ingest 已 sanitize，读侧必须自洽）。
      // F-002 (odyssey-review): 标题回退值取 safeId（等价于改前 context 侧 probePath
      // 显式接收的 vrId 参数），不依赖循环变量闭包。
      try {
        const safeId = sanitize(vr.id)
        const candidatePaths = [
          ...dirs.map((dir) => `${pp}/wiki/${dir}/${safeId}.md`),
          `${pp}/wiki/${safeId}.md`,
        ]
        const settled = await Promise.allSettled(candidatePaths.map((p) => probePath(p)))
        // Priority order: dirs first (in declared order), then root fallback.
        const hit = settled
          .map((r) => (r.status === "fulfilled" ? r.value : null)) /* v8 ignore start */ /* v8 ignore stop */
          .find((v): v is { path: string; content: string } => v !== null)
        if (hit) {
          hits.push({
            vr,
            safeId,
            path: hit.path,
            title: extractTitle(hit.content, safeId),
            snippet: hit.content.slice(0, 300).replace(/\n/g, " "),
          })
        }
      } catch (err) {
        // 差异点 2：adapter 单条失败只丢该条；context 语义（perItemGuard=false）原样
        // 冒泡到外层 catch → 整批 []（与改前逐字一致，不包新 Error）。
        if (!perItemGuard) throw err
      }
    }
    return hits
  } catch {
    return []
  }
}
