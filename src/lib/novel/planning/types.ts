/**
 * Wave 3 计划模式 — 纯类型定义（零 IO、零依赖）。
 */

import type { ForeshadowingDebtReport } from "../foreshadowing-debt"
import type { ForeshadowFinding } from "../related-chapters"
import type { ThreadArcDerived } from "../story-thread-arcs"

/** 单维数据状态：ok = 正常（含合法空数据）；degraded = 数据源不可用（可见标记） */
export type PlanDimensionStatus = "ok" | "degraded"

/** 角色计划条目（出场状态合并视图） */
export interface CharacterPlanItem {
  name: string
  /** 上次出场章节（store.lastSeenChapter ?? 出场索引末位；无则 undefined） */
  lastSeenChapter?: number
  status?: string
  location?: string
  isAlive?: boolean
  /** 是否命中本章大纲关键词（extractOutlineKeywords 复用） */
  inCurrentOutline: boolean
  /** 距当前章节未出场章数（无出场记录则 undefined） */
  chaptersSinceSeen?: number
}

/** 本章确定性范围视图（纯展示模型） */
export interface ChapterPlanView {
  chapterNumber: number
  generatedAt: string
  foreshadowing: {
    status: PlanDimensionStatus
    report: ForeshadowingDebtReport | null
    overdueFindings: ForeshadowFinding[]
  }
  characters: {
    status: PlanDimensionStatus
    items: CharacterPlanItem[]
  }
  threads: {
    status: PlanDimensionStatus
    items: ThreadArcDerived[]
    openCount: number
  }
  summary: {
    debtScore: number
    criticalForeshadowing: number
    openThreads: number
    charactersDue: number
  }
}

/** buildChapterPlanView / buildChapterPlan 选项 */
export interface ChapterPlanOptions {
  /** 伏笔 top-N（默认 8） */
  foreshadowingTopN?: number
  /** 角色 top-N（默认 12） */
  charactersTopN?: number
  /** 长期未出场阈值（默认 10，与引擎 dormant 语义一致） */
  dormantThreshold?: number
  /** 伏笔逾期阈值（默认 5，与 findOverdueForeshadowing 一致） */
  foreshadowStaleThreshold?: number
}
