/**
 * context-engine-technique-sources.ts — canon 事实 / 技法块 / 快照装载源（纯搬迁，零逻辑变更）
 *
 * 从 context-engine.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 */
import {
  queryCanonEdges,
} from "./canon-graph-client"
import type {
} from "./chapter-ingest"
import {
  resolveChapterPovCharacter,
} from "./character-cognition"
import {
  TechniquePromptBlock,
  compileFromCommittedSnapshot,
} from "./craft/technique-compiler"
import {
  loadNovelSessionStatus,
} from "./novel-session-status"
import type {
  CanonMigrationMode,
} from "./novel-session-status"
import {
  chooseTechniqueIndex,
  preferenceStore,
  scorePreference,
} from "./technique-preference"
import type {
  PreferenceMap,
  ScoredTechnique,
} from "./technique-preference"
import {
  fromCanonGraph,
} from "./temporal-memory"
import type {
  TemporalFact,
} from "./temporal-memory"
import {
} from "@/lib/path-utils"
import { logDegradation } from "./context-engine-gaps"
import { loadTemporalFactsCached } from "./context-engine-temporal"

/** loadCanonSourceFacts 双输出：当前有效时序事实 + 已失效（曾成立）时序事实。 */
export interface CanonSourceFacts {
  /** 当前章有效时序事实（= 原 loadCanonSourceFacts 返回值，注入 pack.temporalFacts）。 */
  current: TemporalFact[] | null
  /** 已失效但曾成立的时序事实（former:true 标记），供独立分块注入 pack.formerFacts。 */
  former: TemporalFact[]
}

export async function loadCanonSourceFacts(
  pp: string,
  targetChapter: number,
): Promise<CanonSourceFacts> {
  if (targetChapter <= 0) return { current: null, former: [] }
  const migrationMode: CanonMigrationMode | undefined =
    (await loadNovelSessionStatus(pp))?.canon_migration
  if (migrationMode === "dual" || migrationMode === "shadow") {
    // canon 路径：T14 投影读出口结构化查询（POV 句柄 known_by/digest 已在投影层剥离）。
    try {
      // 第一查询：当前章有效边（旧行为 is_valid_at 严格半开区间 → 保护一致性）。
      const edges = await queryCanonEdges(pp, {
        valid_at_chapter: targetChapter,
        archived: false,
      })
      const current = fromCanonGraph(edges)
      // 第二查询：include_invalidated=true 召回已失效窗口边（"曾以为"）。
      const povId = await resolveChapterPovCharacter(pp, targetChapter)
      const formerEdges = await queryCanonEdges(pp, {
        valid_at_chapter: targetChapter,
        archived: false,
        include_invalidated: true,
        ...(povId ? { known_by: povId } : {}),
      })
      const former = fromCanonGraph(
        formerEdges,
        undefined,
        { chapter: targetChapter, includeInvalidated: true },
      ).filter((f) => f.former === true)
      return { current, former }
    } catch (error) {
      // P1-IMP-13: 分级记录（DEGRADED — canon 检索失败降级回退，不终止写作）
      logDegradation("canon-graph load failed, falling back to raw canonRules", error, { retrievalFailed: true })
      return { current: null, former: [] }
    }
  }
  // 默认折叠路径（TASK-004 原行为）：无 canon 图，former 恒为空。
  try {
    return { current: await loadTemporalFactsCached(pp), former: [] }
  } catch (error) {
    // P1-IMP-13: 分级记录（DEGRADED — 时序记忆检索失败降级回退，不终止写作）
    logDegradation("temporal-memory load failed, falling back to raw canonRules", error, { retrievalFailed: true })
    return { current: null, former: [] }
  }
}

/**
 * T25 (F-19/W12 注入范围含技法块) 源3 技法：T27b 离线编译产物 → 技法提示块文本。
 *
 * runtime 唯一合法入口 compileFromCommittedSnapshot（蓝图 §8 P3「runtime 永不直连
 * nmem」；纯同步、零 IO、零时钟）。渲染 injectionPoint="chapter_task_brief" 的块
 * （章节任务书技法注入面），每行 `【标题】正文`。纯同步计算包一层 async 以统一
 * 三源 Promise.all 计时口径；编译失败降级空文本不阻断装配（与 relatedChapters
 * 同款优雅降级）。
 */
export async function loadTechniqueBlocks(projectPath?: string): Promise<string> {
  try {
    const registry = compileFromCommittedSnapshot()
    const blocks = registry.packs
      .flatMap((pack) => pack.promptBlocks)
      .filter((block) => block.injectionPoint === "chapter_task_brief")
    if (blocks.length === 0) return ""
    // B1 偏好重排（零风险 additive）：读 PreferenceStore + chooseTechniqueIndex 仅重排 blocks 顺序，
    // 不增删块；读失败/空偏好/全部分数 <= 0 降级原序（默认行为不变）。
    const ordered = await reorderTechniqueBlocksByPreference(blocks, projectPath)
    return ordered.map((b) => `【${b.title}】${b.body}`).join("\n")
  } catch (error) {
    // P1-IMP-13: 分级记录（RECOVERABLE — 采源失败重试/隔离）
    logDegradation("technique compile failed, skipping injection", error, { sourceFailed: true })
    return ""
  }
}

/**
 * B1 偏好重排纯核（可测）：仅重排顺序，不增删块。
 *
 * id 映射：block.blockId（缺失条目 scorePreference 按 undefined → 0）。
 * 全零/全负分 → 原序（与 chooseTechniqueIndex 回退 cursor 语义一致，默认行为不变）。
 * 存在正分 → 迭代 chooseTechniqueIndex 选头（剩余队列按当前顺序组装 prefs，cursor 取 0），
 * 等价于按 score 稳定降序（并列保原序）。不抛：输入非法时回退原序。
 */
export function orderTechniqueBlocksByPreference(
  blocks: readonly TechniquePromptBlock[],
  prefs: PreferenceMap,
): readonly TechniquePromptBlock[] {
  try {
    if (blocks.length === 0) return blocks
    const scoredFor = (block: TechniquePromptBlock): ScoredTechnique => ({
      id: block.blockId,
      score: scorePreference(prefs[block.blockId]),
    })
    if (blocks.every((b) => scoredFor(b).score <= 0)) return blocks
    const remaining: TechniquePromptBlock[] = [...blocks]
    const ordered: TechniquePromptBlock[] = []
    while (remaining.length > 0) {
      const prefsAligned: ScoredTechnique[] = remaining.map((b) => scoredFor(b))
      const pick = chooseTechniqueIndex(remaining.length, 0, prefsAligned)
      const idx = Number.isInteger(pick) && pick >= 0 && pick < remaining.length ? pick : 0
      const next: TechniquePromptBlock | undefined = remaining[idx]
      if (next === undefined) return blocks
      remaining.splice(idx, 1)
      ordered.push(next)
    }
    return ordered
  } catch {
    return blocks
  }
}

/**
 * B1 偏好重排 IO 壳：读 PreferenceStore 后委托纯核；无 projectPath/读失败降级原序。
 * 不抛：任何异常回退原序，不阻断装配（与 relatedChapters 同款优雅降级）。
 */
export async function reorderTechniqueBlocksByPreference(
  blocks: readonly TechniquePromptBlock[],
  projectPath?: string,
): Promise<readonly TechniquePromptBlock[]> {
  try {
    if (!projectPath || projectPath.trim().length === 0) return blocks
    const prefs: PreferenceMap = await preferenceStore.load(projectPath)
    return orderTechniqueBlocksByPreference(blocks, prefs)
  } catch {
    return blocks
  }
}

