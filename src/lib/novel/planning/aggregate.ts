/**
 * Wave 3 计划模式 — 数据聚合层。
 *
 * buildChapterPlanView：同步纯函数（组合既有引擎，零 IO，可穷举单测）。
 * buildChapterPlan：IO 编排（并行装载 4 源 + 逐维降级，绝不整体失败）。
 *
 * PAT-G2 纪律：全部复用既有纯函数（analyzeForeshadowingDebt /
 * findOverdueForeshadowing / buildAppearancesFromSnapshots /
 * deriveAllThreadArcStates / countOpenThreadArcs / extractOutlineKeywords），
 * 零平行实现。
 */

import type { ChapterPlanOptions, ChapterPlanView, CharacterPlanItem } from "./types"
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

/** 纯组合入参（fixture 直喂，单测友好） */
export interface ChapterPlanInput {
  currentChapter: number
  chapterOutline?: string
  foreshadowing: ForeshadowingStore
  characterStates: CharacterStateStore
  /** 由 buildAppearancesFromSnapshots 产出 */
  appearances: Array<{ character: string; chapters: number[] }>
  subplots: Subplot[]
}

/**
 * 组合三类确定性数据为本章计划视图（同步纯函数）。
 * 排序：伏笔 critical→warning→normal 且同级别按 chaptersSincePlanted 降序；
 * 角色按 lastSeenChapter 升序（最久未出场在前）；支线活跃未终结在前、Falling 置顶。
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
  }
}

/** 装载全部快照（计划层自建 6 行 fold；失败降级 []） */
async function loadAllSnapshotsForPlan(projectPath: string): Promise<Array<{ character: string; chapters: number[] }>> {
  const numbers = await listSnapshots(projectPath)
  const snaps = await Promise.all(numbers.map((n) => loadSnapshot(projectPath, n)))
  return buildAppearancesFromSnapshots(snaps.filter((s): s is NonNullable<typeof s> => s !== null))
}

/**
 * IO 编排：并行装载 4 源 + 逐维降级（绝不整体失败）。
 * 面板必须能区分「空数据」（ok）与「数据源不可用」（degraded）。
 */
export async function buildChapterPlan(
  projectPath: string,
  chapterNumber: number,
  options: ChapterPlanOptions = {},
): Promise<ChapterPlanView> {
  const [foreshadowing, characterStates, subplots, appearances] = await Promise.all([
    loadForeshadowingTracker(projectPath),
    loadCharacterStates(projectPath).catch(() => null),
    loadSubplotBoard(projectPath),
    loadAllSnapshotsForPlan(projectPath),
  ])

  const view = buildChapterPlanView(
    {
      currentChapter: chapterNumber,
      foreshadowing,
      characterStates: characterStates ?? { characters: [], lastUpdated: "" },
      appearances,
      subplots: subplots.items,
    },
    options,
  )

  // 逐维降级标记（IC-02 展示层等价物：可见而非静默）
  if (characterStates === null) view.characters.status = "degraded"

  return view
}
