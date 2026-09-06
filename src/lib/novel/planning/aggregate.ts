/**
 * Wave 3 计划模式 — 数据聚合层。
 *
 * buildChapterPlanView：同步纯函数（组合既有引擎，零 IO，可穷举单测）。
 * buildChapterPlan：IO 编排（并行装载 + 逐维降级，绝不整体失败）。
 *
 * PAT-G2 纪律：全部复用既有纯函数（analyzeForeshadowingDebt /
 * findOverdueForeshadowing / buildAppearancesFromSnapshots /
 * deriveAllThreadArcStates / countOpenThreadArcs / extractOutlineKeywords），
 * 零平行实现。
 *
 * P2-IMP-11（三模型共识 2026-09-06，P2-M1，mid 最大项 +0.5）扩源 4 新维：
 *   - cognition        ← computeVisibility().doesNotKnow（POV 认知盲区）
 *   - recentStateDeltas ← chapter-summaries.stateChanges（键控 before→after 子表）
 *   - encounter        ← computeVisibility().metBefore（'past' 口径，P2-IMP-05）
 *   - particles        ← computeVisibility().particles（POV 金钱/伤势/功法持有）
 * 三维走 `computeVisibility` 单一可见性契约（E-03 C-7），零平行实现；
 * 装载侧逐维 `loadDim`（等价 `.catch(() => null)` 语义，但以判别联合区分
 * 「合法空数据」与「装载失败」，IC-02 可见而非静默）→ 单维失败只降该维。
 * 渲染侧逐维 topN + 逐维字符预算封顶（TencentDB L0-L3 分层预算模式）。
 * 门面 `loadForPlanning` 不动（P2-Q8 三选一产品裁决 pending）。
 */

import type {
  ChapterPlanOptions,
  ChapterPlanView,
  CharacterPlanItem,
  ParticlePlanItem,
  PlanDimensionSlice,
  StateDeltaPlanItem,
} from "./types"
import { analyzeForeshadowingDebt } from "../foreshadowing-debt"
import type { ForeshadowingStore } from "../foreshadowing-tracker"
import {
  findOverdueForeshadowing,
  buildAppearancesFromSnapshots,
  extractOutlineKeywords,
} from "../related-chapters"
import type { CharacterStateStore } from "../character-state"
import { deriveAllThreadArcStates, countOpenThreadArcs } from "../story-thread-arcs"
import type { Subplot } from "../subplot-board"
import { loadForeshadowingTracker } from "../foreshadowing-tracker"
import { loadCharacterStates } from "../character-state"
import { loadSubplotBoard } from "../subplot-board"
import { listSnapshots, loadSnapshot } from "../chapter-ingest"
// P2-IMP-11：四新维源 —— 全部只读复用既有投影 loader 与单一可见性契约。
import { assembleProcessView } from "../process-library"
import { loadCognitionState, resolveChapterPovCharacter, type CognitionState } from "../character-cognition"
import {
  createEmptyEncounterMatrixStore,
  loadEncounterMatrix,
  type EncounterMatrixStore,
} from "../encounter-matrix"
import { loadResourceLedger, type ResourceLedgerStore } from "../resource-ledger"
import {
  createEmptyParticleLedgerStore,
  loadParticleLedger,
  type ParticleLedgerStore,
} from "../particle-ledger"
import {
  loadChapterSummaries,
  recentChapterSummaries,
  type ChapterSummariesStore,
} from "../chapter-summaries"

/**
 * 逐维源装载结果（判别联合）。
 *
 * 采判别联合而非裸 `.catch(() => null)` 的理由：`loadCognitionState` 的
 * `null` 是合法语义（文件缺失 = 无认知数据，ISS-20260712-010 三段语义），
 * 与「装载抛错」必须区分——否则 POV 认知盲区会被伪报成「无盲区」（假阴性，
 * 恰是该维最不该出错的方向）。二者对整体编排都是 fail-open。
 */
export type PlanSource<TData> =
  | { status: "ok"; data: TData }
  | { status: "degraded"; data: null }

/** 纯组合入参（fixture 直喂，单测友好） */
export interface ChapterPlanInput {
  currentChapter: number
  chapterOutline?: string
  foreshadowing: ForeshadowingStore
  characterStates: CharacterStateStore
  /** 由 buildAppearancesFromSnapshots 产出 */
  appearances: Array<{ character: string; chapters: number[] }>
  subplots: Subplot[]
  // ---- P2-IMP-11 四新维源（additive optional：缺省 = 未装载 → 该维 degraded） ----
  /** 本章 POV 角色（cognition/encounter/particles 三维 join key；'' → 三维 degraded） */
  povCharacter?: string
  /** 认知状态（`data: null` = 文件缺失 → 合法空；degraded = 装载抛错） */
  cognition?: PlanSource<CognitionState | null>
  /** 见面矩阵（encounter 维源） */
  encounterMatrix?: PlanSource<EncounterMatrixStore>
  /** 资源账本（仅 computeVisibility 必需入参；heldItems 不进计划四维渲染） */
  resources?: PlanSource<ResourceLedgerStore>
  /** 粒子账本（particles 维源） */
  particles?: PlanSource<ParticleLedgerStore>
  /** 章节摘要投影（recentStateDeltas 维源） */
  chapterSummaries?: PlanSource<ChapterSummariesStore>
}

/** 逐维默认 topN（面板/prefill 共用；options 可覆盖） */
export const PLAN_DIMENSION_TOP_N = {
  cognition: 6,
  stateDelta: 8,
  encounter: 10,
  particles: 6,
} as const

/** 近章状态变更默认取近 N 章（Grok 调用规则 1「近 3 章」口径） */
export const PLAN_STATE_DELTA_CHAPTERS = 3

/** 单维渲染字符预算默认值（逐维独立封顶 — TencentDB L0-L3 分层预算模式） */
export const PLAN_DIMENSION_CHAR_BUDGET = 320

/**
 * heldItems 不进计划四维渲染，但 computeVisibility 签名要求 resources 非空 —
 * 此处给中性空 store（不取 createEmptyResourceLedgerStore，避免把隐式时钟
 * `new Date()` 带进本可穷举的同步纯函数；KB-IDEMPOTENCY §4 稳定序列化纪律）。
 */
const EMPTY_RESOURCE_LEDGER: ResourceLedgerStore = { entries: [], lastUpdated: "" }

/** 降级维度（可见原因 + 空条目 + 空文本；绝不抛） */
function degradedDimension<TItem>(reason: string): PlanDimensionSlice<TItem> {
  return { status: "degraded", items: [], text: "", truncated: false, reason }
}

/**
 * 逐维封顶：先 topN，再按字符预算逐行累加，超预算即整行丢弃（不切半行）。
 * 返回的 items 与 text 行一一对应 → 面板与 prefill 共用同一份截断结果。
 */
function capDimension<TItem>(
  items: readonly TItem[],
  topN: number,
  charBudget: number,
  render: (item: TItem) => string,
): { items: TItem[]; text: string; truncated: boolean } {
  const head = items.slice(0, Math.max(0, topN))
  const kept: TItem[] = []
  const lines: string[] = []
  let used = 0
  let truncated = items.length > head.length
  for (const item of head) {
    const line = render(item)
    const cost = line.length + (lines.length > 0 ? 1 : 0)
    if (used + cost > charBudget) {
      truncated = true
      break
    }
    kept.push(item)
    lines.push(line)
    used += cost
  }
  return { items: kept, text: lines.join("\n"), truncated }
}

/** 源是否可用（未提供 = 未装载 = 不可用） */
function sourceOk<TData>(source: PlanSource<TData> | undefined): source is { status: "ok"; data: TData } {
  return source?.status === "ok"
}

/**
 * 组合确定性数据为本章计划视图（同步纯函数）。
 * 排序：伏笔 critical→warning→normal 且同级别按 chaptersSincePlanted 降序；
 * 角色按 lastSeenChapter 升序（最久未出场在前）；支线活跃未终结在前、Falling 置顶。
 * 四新维（P2-IMP-11）逐维 topN + 逐维字符预算封顶，单维不可用只标该维。
 */
export function buildChapterPlanView(
  input: ChapterPlanInput,
  options: ChapterPlanOptions = {},
): ChapterPlanView {
  const foreshadowingTopN = options.foreshadowingTopN ?? 8
  const charactersTopN = options.charactersTopN ?? 12
  const dormantThreshold = options.dormantThreshold ?? 10
  const staleThreshold = options.foreshadowStaleThreshold ?? 5

  // 伏笔债务
  const report = analyzeForeshadowingDebt(input.foreshadowing, input.currentChapter)
  const overdueFindings = findOverdueForeshadowing(input.foreshadowing, input.currentChapter, {
    foreshadowStaleThreshold: staleThreshold,
  })
  const sortedDebt = [...report.items]
    .sort((a, b) => {
      const rank = { critical: 0, warning: 1, normal: 2 } as const
      const rankDiff = rank[a.debtLevel] - rank[b.debtLevel]
      if (rankDiff !== 0) return rankDiff
      return b.chaptersSincePlanted - a.chaptersSincePlanted
    })
    .slice(0, foreshadowingTopN)

  // 角色出场
  const outlineKeywords = input.chapterOutline ? extractOutlineKeywords(input.chapterOutline) : []
  const appearanceMap = new Map(input.appearances.map((a) => [a.character, a.chapters]))
  const characterItems: CharacterPlanItem[] = input.characterStates.characters
    .map((c) => {
      const chapters = appearanceMap.get(c.characterName) ?? []
      // 取 store 与快照出场索引的较新者（store.lastSeenChapter 可能滞后于快照）
      const lastSeen = Math.max(
        c.lastSeenChapter ?? 0,
        chapters.length > 0 ? chapters[chapters.length - 1] : 0,
      ) || undefined
      const inCurrentOutline = outlineKeywords.some((k) => c.characterName.includes(k) || k.includes(c.characterName))
      return {
        name: c.characterName,
        lastSeenChapter: lastSeen,
        status: c.status,
        location: c.currentLocation,
        isAlive: c.isAlive,
        inCurrentOutline,
        chaptersSinceSeen: lastSeen !== undefined ? input.currentChapter - lastSeen : undefined,
      }
    })
    .sort((a, b) => {
      // 大纲命中优先，其次最久未出场在前
      if (a.inCurrentOutline !== b.inCurrentOutline) return a.inCurrentOutline ? -1 : 1
      return (a.lastSeenChapter ?? Number.MAX_SAFE_INTEGER) - (b.lastSeenChapter ?? Number.MAX_SAFE_INTEGER)
    })
    .slice(0, charactersTopN)

  // 支线推进
  const threadItems = deriveAllThreadArcStates(input.subplots, input.currentChapter)
  const openCount = countOpenThreadArcs(threadItems)
  const sortedThreads = [...threadItems].sort((a, b) => {
    const rank = { Falling: 0, Climax: 1, Rising: 2, Setup: 3, Resolved: 4, Unresolved: 5 } as const
    return rank[a.arcState] - rank[b.arcState]
  })

  const charactersDue = characterItems.filter(
    (c) => !c.inCurrentOutline && c.chaptersSinceSeen !== undefined && c.chaptersSinceSeen >= dormantThreshold,
  ).length

  // ---- P2-IMP-11 四新维 ----
  const charBudget = Math.max(0, options.dimensionCharBudget ?? PLAN_DIMENSION_CHAR_BUDGET)
  const pov = (input.povCharacter ?? "").trim()
  // 单一可见性契约：缺失源以空 store 中性兜底（各维状态另按自身源可用性标注）。
  // P2-IMP-16: 规划面消费 assembleProcessView 装配核心（三面同源）。
  const summariesStore = sourceOk(input.chapterSummaries) ? input.chapterSummaries.data : null
  const visibility = pov
    ? assembleProcessView(
        pov,
        input.currentChapter,
        {
          cognition: sourceOk(input.cognition) ? input.cognition.data : null,
          matrix: sourceOk(input.encounterMatrix) ? input.encounterMatrix.data : createEmptyEncounterMatrixStore(),
          resources: sourceOk(input.resources) ? input.resources.data : EMPTY_RESOURCE_LEDGER,
          particles: sourceOk(input.particles) ? input.particles.data : createEmptyParticleLedgerStore(),
        },
        // P2-IMP-05 口径：'past' — 本章共现 ≠ 已见面（堵注入侧信息泄漏）。
        "past",
        summariesStore,
      )
    : null

  const cognitionSlice: PlanDimensionSlice<string> = !pov
    ? degradedDimension<string>("POV 未声明（per-chapter POV 真源待落地）")
    : !sourceOk(input.cognition)
      ? degradedDimension<string>("认知数据源不可用")
      : {
          status: "ok",
          ...capDimension(
            visibility?.doesNotKnow ?? [],
            options.cognitionTopN ?? PLAN_DIMENSION_TOP_N.cognition,
            charBudget,
            (fact) => fact,
          ),
        }

  const encounterSlice: PlanDimensionSlice<string> = !pov
    ? degradedDimension<string>("POV 未声明（per-chapter POV 真源待落地）")
    : !sourceOk(input.encounterMatrix)
      ? degradedDimension<string>("见面矩阵数据源不可用")
      : {
          status: "ok",
          ...capDimension(
            visibility?.metBefore ?? [],
            options.encounterTopN ?? PLAN_DIMENSION_TOP_N.encounter,
            charBudget,
            (name) => name,
          ),
        }

  const particlesSlice: PlanDimensionSlice<ParticlePlanItem> = !pov
    ? degradedDimension<ParticlePlanItem>("POV 未声明（per-chapter POV 真源待落地）")
    : !sourceOk(input.particles)
      ? degradedDimension<ParticlePlanItem>("粒子账本数据源不可用")
      : {
          status: "ok",
          ...capDimension(
            (visibility?.particles ?? []).map(
              (p): ParticlePlanItem => ({ kind: p.kind, name: p.name, state: p.state }),
            ),
            options.particlesTopN ?? PLAN_DIMENSION_TOP_N.particles,
            charBudget,
            (p) => `[${p.kind}] ${p.name} → ${p.state}`,
          ),
        }

  const stateDeltaSlice: PlanDimensionSlice<StateDeltaPlanItem> = !sourceOk(input.chapterSummaries)
    ? degradedDimension<StateDeltaPlanItem>("章节摘要数据源不可用")
    : {
        status: "ok",
        ...capDimension(
          flattenStateDeltas(input.chapterSummaries.data, options.stateDeltaChapters ?? PLAN_STATE_DELTA_CHAPTERS),
          options.stateDeltaTopN ?? PLAN_DIMENSION_TOP_N.stateDelta,
          charBudget,
          (d) => `第${d.chapter}章 [${d.kind}] ${d.entity}：${d.change}`,
        ),
      }

  return {
    chapterNumber: input.currentChapter,
    generatedAt: new Date().toISOString(),
    foreshadowing: {
      status: "ok",
      report: { ...report, items: sortedDebt },
      overdueFindings,
    },
    characters: {
      status: "ok",
      items: characterItems,
    },
    threads: {
      status: "ok",
      items: sortedThreads,
      openCount,
    },
    summary: {
      debtScore: report.debtScore,
      criticalForeshadowing: report.items.filter((i) => i.debtLevel === "critical").length,
      openThreads: openCount,
      charactersDue,
    },
    // P2-IMP-11 四新维（IO 层恒填充；POV 未声明时三维 degraded + 一维 ok）
    povCharacter: pov,
    cognition: cognitionSlice,
    recentStateDeltas: stateDeltaSlice,
    encounter: encounterSlice,
    particles: particlesSlice,
  }
}

/**
 * 近 N 章 stateChanges 展平为计划条目（纯函数，零平行实现 —
 * 复用 `recentChapterSummaries` 取窗，倒序保证「最近变更优先」进 topN）。
 */
function flattenStateDeltas(store: ChapterSummariesStore, chapters: number): StateDeltaPlanItem[] {
  const items: StateDeltaPlanItem[] = []
  for (const entry of recentChapterSummaries(store, Math.max(0, chapters)).slice().reverse()) {
    for (const change of entry.stateChanges) {
      items.push({ chapter: entry.chapter, kind: change.kind, entity: change.entity, change: change.change })
    }
  }
  return items
}

/** 装载全部快照（计划层自建 6 行 fold；失败降级 []） */
async function loadAllSnapshotsForPlan(projectPath: string): Promise<Array<{ character: string; chapters: number[] }>> {
  const numbers = await listSnapshots(projectPath)
  const snaps = await Promise.all(numbers.map((n) => loadSnapshot(projectPath, n)))
  return buildAppearancesFromSnapshots(snaps.filter((s): s is NonNullable<typeof s> => s !== null))
}

/**
 * 逐维降级装载（P2-IMP-11）：单维抛错只把该维标 degraded，
 * 绝不冒泡到 Promise.all → 计划面板绝不整体失败。
 */
async function loadDim<TData>(load: () => Promise<TData>): Promise<PlanSource<TData>> {
  try {
    return { status: "ok", data: await load() }
  } catch {
    return { status: "degraded", data: null }
  }
}

/**
 * IO 编排：并行装载既有 4 源 + P2-IMP-11 四新维源（逐维降级，绝不整体失败）。
 * 面板必须能区分「空数据」（ok）与「数据源不可用」（degraded）——
 * 四新维的 degraded 标注在 buildChapterPlanView 内同源完成（单一判定点）。
 */
export async function buildChapterPlan(
  projectPath: string,
  chapterNumber: number,
  options: ChapterPlanOptions = {},
): Promise<ChapterPlanView> {
  const [
    foreshadowing,
    characterStates,
    subplots,
    appearances,
    cognition,
    encounterMatrix,
    resources,
    particles,
    chapterSummaries,
    povResolved,
  ] = await Promise.all([
    loadForeshadowingTracker(projectPath),
    loadCharacterStates(projectPath).catch(() => null),
    loadSubplotBoard(projectPath),
    loadAllSnapshotsForPlan(projectPath),
    // P2-IMP-11 扩载（逐维 catch → 判别联合；Promise.all 永不整体 reject）
    loadDim(() => loadCognitionState(projectPath)),
    loadDim(() => loadEncounterMatrix(projectPath)),
    loadDim(() => loadResourceLedger(projectPath)),
    loadDim(() => loadParticleLedger(projectPath)),
    loadDim(() => loadChapterSummaries(projectPath)),
    // POV：显式穿参优先，缺省回退既有解析器（真源未落地 → null → 三维 degraded）
    resolveChapterPovCharacter(projectPath, chapterNumber).catch(() => null),
  ])

  const povCharacter = (options.povCharacter ?? "").trim() || (povResolved ?? "")

  const view = buildChapterPlanView(
    {
      currentChapter: chapterNumber,
      foreshadowing,
      characterStates: characterStates ?? { characters: [], lastUpdated: "" },
      appearances,
      subplots: subplots.items,
      povCharacter,
      cognition,
      encounterMatrix,
      resources,
      particles,
      chapterSummaries,
    },
    options,
  )

  // 逐维降级标记（IC-02 展示层等价物：可见而非静默）
  // 四新维的 degraded 标注由 buildChapterPlanView 按同源判定完成，此处不重复。
  if (characterStates === null) view.characters.status = "degraded"

  return view
}
