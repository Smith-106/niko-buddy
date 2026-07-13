import { readFile, writeFile, createDirectory } from "@/commands/fs"
import { buildWikiGraph, type GraphNode, type CommunityInfo } from "@/lib/wiki-graph"
import { streamChat, DEFAULT_LLM_REQUEST_TIMEOUT_MS, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import { resolveNovelModel } from "@/lib/novel/model-resolver"
import { embedPage, searchByEmbedding } from "@/lib/embedding"
import { useWikiStore, type NovelConfig, type LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

/** 社区摘要持久化结构 */
export interface CommunitySummaryRecord {
  communityId: number
  summary: string
  nodeCount: number
  topNodes: string[]
  generatedAt: string
}

/** 判断当前章节是否应该触发社区摘要重建 */
export function shouldRebuildCommunitySummaries(
  chapterNumber: number,
  novelConfig: NovelConfig,
): boolean {
  if (!novelConfig.communitySummaryEnabled) return false
  if (chapterNumber <= 0) return false
  const interval = Math.max(1, novelConfig.communitySummaryInterval || 5)
  return chapterNumber % interval === 0
}

/** 生成所有社区的叙事摘要并持久化 + 向量化 */
export async function generateCommunitySummaries(
  projectPath: string,
  llmConfig: LlmConfig,
  novelConfig: NovelConfig,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const { nodes, communities } = await buildWikiGraph(pp)
  if (communities.length === 0) return

  // 按社区 ID 分组节点
  const nodesByCommunity = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const bucket = nodesByCommunity.get(node.community) ?? []
    bucket.push(node)
    nodesByCommunity.set(node.community, bucket)
  }

  // 准备持久化目录
  const summaryDir = `${pp}/.novel/community-summaries`
  await createDirectory(summaryDir)

  // 解析摘要模型
  const summaryLlmConfig = resolveNovelModel(llmConfig, novelConfig, "summary")
  const embCfg = useWikiStore.getState().embeddingConfig

  // 逐个社区生成摘要
  for (const community of communities) {
    const members = nodesByCommunity.get(community.id) ?? []
    if (members.length === 0) continue

    try {
      const summary = await generateSingleCommunitySummary(community, members, summaryLlmConfig)
      const record: CommunitySummaryRecord = {
        communityId: community.id,
        summary,
        nodeCount: community.nodeCount,
        topNodes: community.topNodes,
        generatedAt: new Date().toISOString(),
      }

      // 持久化到 JSON
      const summaryPath = `${summaryDir}/${community.id}.json`
      await writeFile(summaryPath, JSON.stringify(record, null, 2))

      // 向量化写入 LanceDB（page_id = community:xxx）
      if (embCfg.enabled && embCfg.model) {
        try {
          const pageId = `community:${community.id}`
          const title = `社区 ${community.id} 摘要（${community.topNodes[0] ?? ""}）`
          await embedPage(pp, pageId, title, summary, embCfg)
        } catch (err) {
          console.warn(
            `[CommunitySummary] 向量化社区 ${community.id} 失败:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    } catch (err) {
      console.warn(
        `[CommunitySummary] 生成社区 ${community.id} 摘要失败:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

/**
 * 为单个社区生成叙事摘要（200-400 字）。
 *
 * TASK-003 (ANL-013 S4): exported so deep-chapter-generation can generate a
 * community summary for the communities most relevant to the current
 * chapter (pre-generation stage, after context assembly) and inject it
 * into the compressible context tier. Previously only the retrieval side
 * (`searchCommunitySummaries`) was wired into context-engine; the generate
 * side was orphaned.
 */
export async function generateSingleCommunitySummary(
  community: CommunityInfo,
  members: GraphNode[],
  llmConfig: LlmConfig,
): Promise<string> {
  // 收集成员节点内容（前 500 字/节点，最多 10 个节点）
  const topMembers = members
    .sort((a, b) => b.linkCount - a.linkCount)
    .slice(0, 10)
  const memberContents: string[] = []
  for (const member of topMembers) {
    try {
      const content = await readFile(member.path)
      const truncated = content.slice(0, 500).replace(/\s+/g, " ").trim()
      memberContents.push(`【${member.label}】（${member.type}）: ${truncated}`)
    } catch {
      // 跳过读取失败的节点
    }
  }

  if (memberContents.length === 0) {
    return `社区 ${community.id}：包含 ${community.nodeCount} 个节点（${community.topNodes.join("、")}），但无法读取节点内容。`
  }

  const systemPrompt = `你是一位小说编辑助手，擅长分析角色阵营、关系网络和故事结构。请根据给定的图谱社区成员信息，生成一段 200-400 字的叙事摘要，描述这个社区的核心主题、阵营特征、关键关系和重要事件。

要求：
1. 用流畅的叙事语言，不要用列表
2. 突出社区的核心主题和阵营特征
3. 提及关键成员及其关系
4. 涵盖重要事件和冲突
5. 200-400 字，不要超过 400 字`

  const userPrompt = `社区 ID: ${community.id}
社区规模: ${community.nodeCount} 个节点
核心成员: ${community.topNodes.join("、")}

成员详情：
${memberContents.join("\n\n")}

请为这个社区生成叙事摘要。`

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]

  let result = ""
  let streamError: Error | null = null
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => {
      result += token
    },
    onDone: () => {},
    onError: (error: Error) => {
      streamError = error
    },
  }

  await streamChat(llmConfig, messages, callbacks, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS))
  if (streamError) throw streamError

  return result.trim() || `社区 ${community.id}：包含 ${community.nodeCount} 个节点（${community.topNodes.join("、")}）。`
}

/** 检索与查询相关的社区摘要（用于注入上下文） */
export async function searchCommunitySummaries(
  projectPath: string,
  query: string,
  topK: number = 3,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return ""

  try {
    const results = await searchByEmbedding(pp, query, embCfg, topK * 3)
    // 只保留 community: 前缀的结果
    const communityResults = results.filter(r => r.id.startsWith("community:"))
    if (communityResults.length === 0) return ""

    // 取 Top-K
    const top = communityResults.slice(0, topK)
    return top.map(r => {
      const communityId = r.id.replace("community:", "")
      const snippet = r.matchedChunks?.[0]?.text?.slice(0, 400) ?? ""
      return `- 【社区摘要·社区${communityId}】: ${snippet}`
    }).join("\n")
  } catch {
    return ""
  }
}

/**
 * TASK-003 (ANL-013 S4): per-chapter lazy-cached community summary generation
 * for the compressible context tier.
 *
 * Called from deep-chapter-generation's pre-generation stage (after context
 * assembly, before prose generation). For each community whose top nodes
 * overlap the current task's entity tokens, generate (or reuse the cached)
 * narrative summary via `generateSingleCommunitySummary` and return the
 * concatenation for injection into the compressible tier of the prompt.
 *
 * Lazy per-chapter caching: summaries are keyed by `${projectPath}:${communityId}`
 * in a process-level Map, so the same community is not re-summarized on every
 * chapter — only communities not yet seen get a fresh LLM call. This is a
 * best-effort enrichment: any failure (graph build, LLM call, etc.) returns
 * an empty string and does not block the main generation flow.
 *
 * Note: this is the GENERATE side (previously orphaned — only the retrieval
 * side `searchCommunitySummaries` was wired into context-engine). Together
 * with the retrieval side it closes the generate-then-inject loop.
 */
const communitySummaryCache = new Map<string, string>()
// ARCH-003 fix: track freshness per-project so a project switch (or another
// project's bucket advance) does NOT clear a different project's in-flight /
// cached community summaries. The prior single `lastProjectFreshnessKey`
// value meant project B's freshness change cleared ALL entries (including
// project A's), and project A's still-running async rebuildCommunitySummary
// (chapter-ingest.ts:684 `void ...`) would then repopulate into a cache that
// project B's freshness would sweep again — cross-project cache pollution.
// Per-project tracking scopes each clear to that project's cacheKey prefix.
const lastProjectFreshnessKeyByProject = new Map<string, string>()

export async function generateCommunitySummariesForChapter(
  projectPath: string,
  task: string,
  chapterNumber: number | undefined,
  llmConfig: LlmConfig,
  topK: number = 3,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const novelConfig = useWikiStore.getState().novelConfig
  // Respect the user's community-summary toggle. Disabled → no generate side.
  if (!novelConfig?.communitySummaryEnabled) return ""

  try {
    const { nodes, communities } = await buildWikiGraph(pp)
    if (communities.length === 0) return ""

    // Tokenize task the same way search does — 2+ char CJK / word tokens.
    const taskTokens = tokenizeTask(task)
    if (taskTokens.length === 0) return ""

    // chapterNumber drives per-chapter cache freshness: when the chapter
    // advances past the communitySummaryInterval, stale cache entries for
    // this project are dropped so the next relevant community regenerates
    // with up-to-date wiki content. Within the interval, cached summaries
    // are reused (lazy per-chapter caching — no per-chapter recompute).
    const interval = Math.max(1, novelConfig.communitySummaryInterval || 5)
    const chapterBucket = chapterNumber !== undefined && chapterNumber > 0
      ? Math.floor(chapterNumber / interval)
      : 0
    const projectFreshnessKey = `${pp}:bucket:${chapterBucket}`
    if (lastProjectFreshnessKeyByProject.get(pp) !== projectFreshnessKey) {
      // ARCH-003: clear ONLY this project's cache entries (cacheKey prefix
      // `${pp}:`), never another project's, so cross-project sessions don't
      // pollute each other's freshness.
      const prefix = `${pp}:`
      for (const key of communitySummaryCache.keys()) {
        if (key.startsWith(prefix)) {
          communitySummaryCache.delete(key)
        }
      }
      lastProjectFreshnessKeyByProject.set(pp, projectFreshnessKey)
    }

    const nodesByCommunity = new Map<number, GraphNode[]>()
    for (const node of nodes) {
      const bucket = nodesByCommunity.get(node.community) ?? []
      bucket.push(node)
      nodesByCommunity.set(node.community, bucket)
    }

    // Rank communities by how many of their top-node labels match a task token.
    const scored = communities.map(community => {
      const topLabels = community.topNodes
      const hitCount = topLabels.reduce(
        (count, label) => count + (taskTokens.some(token => label.includes(token)) ? 1 : 0),
        0,
      )
      return { community, hitCount }
    })
    const relevant = scored
      .filter(item => item.hitCount > 0)
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, topK)

    if (relevant.length === 0) return ""

    const summaryLlmConfig = resolveNovelModel(llmConfig, novelConfig, "summary")
    const lines: string[] = []
    for (const { community } of relevant) {
      const cacheKey = `${pp}:${community.id}`
      let summary = communitySummaryCache.get(cacheKey)
      if (summary === undefined) {
        const members = nodesByCommunity.get(community.id) ?? []
        if (members.length === 0) continue
        try {
          summary = await generateSingleCommunitySummary(community, members, summaryLlmConfig)
          communitySummaryCache.set(cacheKey, summary)
        } catch (err) {
          // Non-blocking: skip this community, keep others.
          console.warn(
            `[CommunitySummary] 生成社区 ${community.id} 摘要失败:`,
            err instanceof Error ? err.message : String(err),
          )
          continue
        }
      }
      if (summary) {
        lines.push(`- 【社区摘要·社区${community.id}】: ${summary.slice(0, 400)}`)
      }
    }
    return lines.join("\n")
  } catch {
    return ""
  }
}

/** Minimal task tokenizer matching search-adapter's CJK/word splitting intent. */
function tokenizeTask(task: string): string[] {
  const trimmed = task.trim()
  if (!trimmed) return []
  // CJK 2+ char runs and latin 2+ char words.
  const cjk = trimmed.match(/[㐀-鿿]{2,}/g) ?? []
  const latin = trimmed.match(/[A-Za-z]{2,}/g) ?? []
  const all = [...cjk, ...latin]
  // De-dup, drop generic filler.
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of all) {
    if (seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }
  return result
}
