import {createDirectory, fileExists, listDirectory, readFile, writeFilesAtomic} from "@/commands/fs"
import { buildWikiGraph, type GraphNode, type CommunityInfo } from "@/lib/wiki-graph"
import { streamChat, combineAbortSignals, DEFAULT_LLM_REQUEST_TIMEOUT_MS, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import { resolveNovelModel } from "@/lib/novel/model-resolver"
import { indexCommunitySummary, searchByEmbedding } from "@/lib/embedding"
import { useWikiStore, type NovelConfig, type LlmConfig, type EmbeddingConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"

/** 社区摘要持久化结构 */
export interface CommunitySummaryRecord {
  communityId: number
  summary: string
  nodeCount: number
  topNodes: string[]
  generatedAt: string
}

interface CommunitySummarySet {
  schemaVersion: 1
  vectorSlot: 0 | 1 | null
  records: CommunitySummaryRecord[]
}

const CURRENT_SET_NAME = "current-set.json"

class InvalidCommunitySummarySetError extends Error {
  constructor() {
    super("Invalid published community summary set.")
  }
}

function summaryPageId(slot: 0 | 1, communityId: number): string {
  return `community-summary-${slot}.${communityId}`
}

function isCommunitySummaryRecord(value: unknown): value is CommunitySummaryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<CommunitySummaryRecord>
  return typeof record.communityId === "number" && Number.isSafeInteger(record.communityId) && record.communityId >= 0
    && typeof record.summary === "string" && record.summary.trim().length > 0
    && typeof record.nodeCount === "number" && Number.isSafeInteger(record.nodeCount) && record.nodeCount >= 0
    && Array.isArray(record.topNodes) && record.topNodes.every(node => typeof node === "string")
    && typeof record.generatedAt === "string" && Number.isFinite(Date.parse(record.generatedAt))
}

function areCommunitySummaryRecords(records: unknown): records is CommunitySummaryRecord[] {
  return Array.isArray(records) && records.every(isCommunitySummaryRecord)
    && new Set(records.map(record => record.communityId)).size === records.length
}

/** 只有文件缺失才走旧版读取路径；损坏从不视为缺失。 */
async function readCurrentSet(manifestPath: string): Promise<{ set: CommunitySummarySet; raw: string } | null> {
  if (!(await fileExists(manifestPath))) return null
  const raw = await readFile(manifestPath)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidCommunitySummarySetError()
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { schemaVersion, vectorSlot, records } = parsed as Partial<CommunitySummarySet>
    if (schemaVersion === 1 && (vectorSlot === null || vectorSlot === 0 || vectorSlot === 1)
      && areCommunitySummaryRecords(records)) {
      return { set: { schemaVersion, vectorSlot, records }, raw }
    }
  }
  throw new InvalidCommunitySummarySetError()
}

/**
 * TASK-402: 自写信号量（Promise 队列，不引新依赖）。
 * 限制同时执行的任务数，防止社区摘要并行 LLM 调用打爆配额。
 * 用法：`await semaphore.acquire()` … `semaphore.release()`（务必在 finally 中释放）。
 */
export interface Semaphore {
  acquire(): Promise<void>
  release(): void
}

export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit))
  let active = 0
  const waiters: Array<() => void> = []
  return {
    acquire(): Promise<void> {
      if (active < max) {
        active++
        return Promise.resolve()
      }
      // 满员：排队等待，release 时把槽位直接转移给下一个等待者
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          active++
          resolve()
        })
      })
    },
    release(): void {
      const next = waiters.shift()
      if (next) {
        next() // 槽位转移：active 在 next 内自增，不减少
      } else {
        active--
      }
    },
  }
}

/** 社区摘要 LLM 并行上限：防配额打爆（TASK-402）。 */
export const maxConcurrency = 3

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

/** 暂存全部叙事摘要；调用侧持有项目摘要锁，最后才原子发布整组。 */
export async function generateCommunitySummaries(
  projectPath: string,
  llmConfig: LlmConfig,
  novelConfig: NovelConfig,
  embCfg?: EmbeddingConfig,
  onFailure?: (error: unknown) => void,
): Promise<void> {
  try {
    const pp = normalizePath(projectPath)
    const { nodes, communities } = await buildWikiGraph(pp)
    if (communities.length === 0) return

    const summaryDir = `${pp}/.novel/community-summaries`
    const manifestPath = `${summaryDir}/${CURRENT_SET_NAME}`
    const published = await readCurrentSet(manifestPath)
    const currentSet = published?.set
    const nodesByCommunity = new Map<number, GraphNode[]>()
    for (const node of nodes) {
      const bucket = nodesByCommunity.get(node.community) ?? []
      bucket.push(node)
      nodesByCommunity.set(node.community, bucket)
    }

    const summaryLlmConfig = resolveNovelModel(llmConfig, novelConfig, "summary")
    const embCfgResolved = embCfg ?? useWikiStore.getState().embeddingConfig
    // TASK-402：并行限流、按输入序收集；任一失败都不得进入写入阶段。
    const semaphore = createSemaphore(maxConcurrency)
    let firstFailure: { cause: unknown } | undefined
    const staged = await Promise.all(
      communities.map(async (community): Promise<CommunitySummaryRecord | undefined> => {
        const members = nodesByCommunity.get(community.id)
        if (!members?.length) return
        await semaphore.acquire()
        try {
          const summary = await generateSingleCommunitySummary(community, members, summaryLlmConfig, undefined, {
            projectPath: pp,
            novelConfig,
          })
          return {
            communityId: community.id,
            summary,
            nodeCount: community.nodeCount,
            topNodes: community.topNodes,
            generatedAt: new Date().toISOString(),
          }
        } catch (err) {
          logger.warn("CommunitySummary", `生成社区 ${community.id} 摘要失败`, { error: toErrorMessage(err) })
          firstFailure ??= { cause: err }
        } finally {
          semaphore.release()
        }
      }),
    )
    if (firstFailure) throw firstFailure.cause
    const records = staged.filter((entry): entry is CommunitySummaryRecord => entry !== undefined)
    if (!records.length) return
    if (!areCommunitySummaryRecords(records)) throw new Error("Invalid generated community summary set.")

    const vectorSlot = embCfgResolved.enabled && embCfgResolved.model
      ? (currentSet?.vectorSlot === 0 ? 1 : 0)
      : null
    if (vectorSlot !== null) {
      for (const record of records) {
        const title = `社区 ${record.communityId} 摘要（${record.topNodes[0] ?? ""}）`
        await indexCommunitySummary(pp, summaryPageId(vectorSlot, record.communityId), title, record.summary, embCfgResolved)
      }
    }

    // 只切换发布入口，不把 JSON 与 LanceDB 伪装成跨存储事务。manifest 用
    // native 守卫批量（expectedContents CAS）：若发布前 manifest 被外部改动，
    // native 拒绝且不覆盖——已活动的旧发布原样保留，TS 不再二次回读。
    const nextSet: CommunitySummarySet = { schemaVersion: 1, vectorSlot, records }
    const raw = JSON.stringify(nextSet, null, 2)
    await createDirectory(summaryDir)
    await writeFilesAtomic([[manifestPath, raw]], [published?.raw ?? null])
  } catch (err) {
    if (!onFailure) throw err
    onFailure(err)
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
  /** ISS-20260724-004 (ROOT-C): optional caller signal for cascade-cancel */
  signal?: AbortSignal,
  options?: { projectPath?: string; novelConfig?: NovelConfig },
): Promise<string> {
  // 收集成员节点内容（前 500 字/节点，最多 10 个节点）
  const topMembers = members
    .sort((a, b) => b.linkCount - a.linkCount)
    .slice(0, 10)
  // ISS-20260724-004 (ROOT-D / PERF-05): independent member reads in parallel
  const memberContents = (
    await Promise.all(
      topMembers.map(async (member) => {
        try {
          const content = await readFile(member.path)
          const truncated = content.slice(0, 500).replace(/\s+/g, " ").trim()
          return `【${member.label}】（${member.type}）: ${truncated}`
        } catch {
          return null
        }
      }),
    )
  ).filter((line): line is string => Boolean(line))

  if (memberContents.length === 0) {
    return `社区 ${community.id}：包含 ${community.nodeCount} 个节点（${community.topNodes.join("、")}），但无法读取节点内容。`
  }

  let systemPrompt = `你是一位小说编辑助手，擅长分析角色阵营、关系网络和故事结构。请根据给定的图谱社区成员信息，生成一段 200-400 字的叙事摘要，描述这个社区的核心主题、阵营特征、关键关系和重要事件。

要求：
1. 用流畅的叙事语言，不要用列表
2. 突出社区的核心主题和阵营特征
3. 提及关键成员及其关系
4. 涵盖重要事件和冲突
5. 200-400 字，不要超过 400 字`

  const cfg = options?.novelConfig
  const hasSummaryExtra = Boolean(cfg?.taskPrompts?.summary?.extra?.trim())
  const hasSummarySkills = Boolean(cfg?.taskSkillNames?.summary?.length)
  if (cfg && (hasSummaryExtra || hasSummarySkills)) {
    try {
      const { resolveTaskExtraPrompt } = await import("./task-customization")
      const { appendTaskExtraSection } = await import("./deep-chapter-prompts")
      systemPrompt = appendTaskExtraSection(systemPrompt, resolveTaskExtraPrompt(cfg, "summary"))
      if (hasSummarySkills) {
        const { resolveRuntimeSkillsForStage } = await import("./runtime-skill-resolver")
        const resolved = await resolveRuntimeSkillsForStage({
          projectPath: options?.projectPath,
          stage: "summary",
          novelConfig: cfg,
          windowTokens: llmConfig.maxContextSize,
        })
        if (resolved.renderedText.trim()) {
          systemPrompt = `${systemPrompt}\n\n${resolved.renderedText.trim()}`
        }
      }
    } catch (err) {
      logger.warn("CommunitySummary", "摘要阶段自定义提示词/技能注入失败（已忽略，继续基础摘要）", {
        error: toErrorMessage(err),
      })
    }
  }

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

  // ISS-20260724-004 (ROOT-C): merge caller signal with timeout to prevent orphaned LLM requests
  const communitySignal = signal
    ? combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS))
    : AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)
  await streamChat(llmConfig, messages, callbacks, communitySignal)
  if (streamError) throw streamError

  return result.trim() || `社区 ${community.id}：包含 ${community.nodeCount} 个节点（${community.topNodes.join("、")}）。`
}

/**
 * Wave B: load persisted community summary JSON from disk (no LLM, no embedding).
 * Caps total characters for ContextPack compressible tier.
 */
export async function loadPersistedCommunitySummaries(
  projectPath: string,
  options?: { maxRecords?: number; maxChars?: number },
): Promise<{ text: string; records: CommunitySummaryRecord[] }> {
  const pp = normalizePath(projectPath)
  const maxRecords = Math.max(1, options?.maxRecords ?? 8)
  const maxChars = Math.max(200, options?.maxChars ?? 2400)
  const summaryDir = `${pp}/.novel/community-summaries`
  let records: CommunitySummaryRecord[] = []

  try {
    const currentSet = (await readCurrentSet(`${summaryDir}/${CURRENT_SET_NAME}`))?.set
    if (currentSet) {
      records = currentSet.records
    } else {
      const nodes = await listDirectory(summaryDir)
      const files = nodes
        .filter((n) => n.name !== CURRENT_SET_NAME && n.name.endsWith(".json") && !n.is_dir)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, maxRecords * 2)

      for (const file of files) {
        if (records.length >= maxRecords) break
        try {
          const raw = await readFile(file.path)
          const parsed = JSON.parse(raw) as CommunitySummaryRecord
          if (parsed && typeof parsed.summary === "string" && parsed.summary.trim()) {
            records.push(parsed)
          }
        } catch {
          // 保持旧版文件逐个跳过的行为。
        }
      }
    }
  } catch (err) {
    if (err instanceof InvalidCommunitySummarySetError) logger.warn("CommunitySummary", toErrorMessage(err))
    return { text: "", records: [] }
  }

  // 优先较大社区；旧版读取仍先按文件名截断。
  records.sort((a, b) => (b.nodeCount ?? 0) - (a.nodeCount ?? 0))
  const top = records.slice(0, maxRecords)

  const lines: string[] = []
  let used = 0
  for (const r of top) {
    const head = `【社区${r.communityId}·${r.nodeCount}节点·${(r.topNodes ?? []).slice(0, 3).join("、")}】`
    const body = r.summary.replace(/\s+/g, " ").trim()
    const line = `${head} ${body}`
    if (used + line.length + 1 > maxChars) {
      const room = maxChars - used - 20
      if (room > 80) lines.push(line.slice(0, room) + "…")
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  return { text: lines.join("\n"), records: top }
}

/** 检索与查询相关的社区摘要（用于注入上下文） */
export async function searchCommunitySummaries(
  projectPath: string,
  query: string,
  topK: number = 3,
  embCfg?: EmbeddingConfig,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const embCfgResolved = embCfg ?? useWikiStore.getState().embeddingConfig
  if (!embCfgResolved.enabled || !embCfgResolved.model) return ""

  try {
    const results = await searchByEmbedding(pp, query, embCfgResolved, topK * 3)
    // 先取向量再读取当前发布入口，避免向量查询期间切槽后注入旧内容。
    const currentSet = (await readCurrentSet(`${pp}/.novel/community-summaries/${CURRENT_SET_NAME}`))?.set
    if (currentSet) {
      const { vectorSlot, records } = currentSet
      if (vectorSlot === null) return ""
      const byId = new Map(records.map(record => [summaryPageId(vectorSlot, record.communityId), record]))
      return results.flatMap(r => {
        const record = byId.get(r.id)
        if (!record || !r.matchedChunks?.some(chunk => chunk.text === record.summary)) return []
        return [`- 【社区摘要·社区${record.communityId}】: ${record.summary.slice(0, 400)}`]
      }).slice(0, topK).join("\n")
    }

    // 仅尚未发布整组摘要的旧项目可读取旧版向量命中。
    const communityResults = results.filter(r => r.id.startsWith("community:"))
    if (communityResults.length === 0) return ""

    // 取 Top-K
    const top = communityResults.slice(0, topK)
    return top.map(r => {
      const communityId = r.id.replace("community:", "")
      const snippet = r.matchedChunks?.[0]?.text?.slice(0, 400) ?? ""
      return `- 【社区摘要·社区${communityId}】: ${snippet}`
    }).join("\n")
  } catch (err) {
    if (err instanceof InvalidCommunitySummarySetError) logger.warn("CommunitySummary", toErrorMessage(err))
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
  novelConfig?: NovelConfig,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const novelConfigResolved = novelConfig ?? useWikiStore.getState().novelConfig
  // Respect the user's community-summary toggle. Disabled → no generate side.
  if (!novelConfigResolved?.communitySummaryEnabled) return ""

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
    const interval = Math.max(1, novelConfigResolved.communitySummaryInterval || 5)
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

    const summaryLlmConfig = resolveNovelModel(llmConfig, novelConfigResolved, "summary")
    const lines: string[] = []
    for (const { community } of relevant) {
      const cacheKey = `${pp}:${community.id}`
      let summary = communitySummaryCache.get(cacheKey)
      if (summary === undefined) {
        const members = nodesByCommunity.get(community.id) ?? []
        if (members.length === 0) continue
        try {
          summary = await generateSingleCommunitySummary(community, members, summaryLlmConfig, undefined, {
            projectPath: pp,
            novelConfig: novelConfigResolved,
          })
          communitySummaryCache.set(cacheKey, summary)
        } catch (err) {
          // Non-blocking: skip this community, keep others.
          logger.warn("CommunitySummary", `生成社区 ${community.id} 摘要失败`, { error: toErrorMessage(err) })
          continue
        }
      }
      /* v8 ignore next */
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
