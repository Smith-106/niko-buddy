/**
 * Wave 3 计划模式 — 纯类型定义（零 IO、零依赖）。
 *
 * P2-IMP-11（三模型共识 2026-09-06，P2-M1）：ChapterPlanView 扩 4 新维
 * cognition / recentStateDeltas / encounter / particles。四维共用
 * `PlanDimensionSlice` 外壳 — 逐维 topN + 逐维字符预算封顶（TencentDB
 * L0-L3 分层预算模式：每维独立封顶互不挤占）。additive 可选字段：
 * 既有手写 plan 字面量（外部 spec fixture）零改动。
 */

import type { ForeshadowingDebtReport } from "../foreshadowing-debt"
import type { ForeshadowFinding } from "../related-chapters"
import type { ThreadArcDerived } from "../story-thread-arcs"
import type { ParticleKind } from "../particle-ledger"

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

/** 近章状态变更条目（P2-IMP-11 recentStateDeltas 维；源 = chapter-summaries.stateChanges） */
export interface StateDeltaPlanItem {
  /** 变更发生章号 */
  chapter: number
  /** 实体类别（character | relationship | knowledge | foreshadowing | item） */
  kind: string
  /** 实体名（canonical） */
  entity: string
  /** 变更描述（快照 delta 行 verbatim） */
  change: string
}

/** POV 粒子持有条目（P2-IMP-11 particles 维；形态与 computeVisibility().particles 同构） */
export interface ParticlePlanItem {
  kind: ParticleKind
  name: string
  state: string
}

/**
 * 单维计划切片（P2-IMP-11 四新维共用外壳）。
 *
 * `items` 与 `text` 同源同截断点：text 是 items 逐维 topN + 字符预算封顶后
 * 的渲染结果（多行、无尾换行），面板与预填共用同一份封顶口径，杜绝分叉。
 */
export interface PlanDimensionSlice<TItem> {
  status: PlanDimensionStatus
  /** 结构化条目（已按逐维 topN + 字符预算截断，与 text 行一一对应） */
  items: TItem[]
  /** 逐维封顶后的渲染文本（'' = 无内容） */
  text: string
  /** 是否因 topN 或字符预算被截断（IC-02：可见而非静默） */
  truncated: boolean
  /** 降级归因（status === "degraded" 时给出可见原因） */
  reason?: string
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
  // ---- P2-IMP-11 四新维（additive optional：IO 层恒填充；手写旧字面量可缺省） ----
  /** 本章 POV 角色（cognition/encounter/particles 三维的 join key；未解析 → ''） */
  povCharacter?: string
  /** 认知边界：POV 不知道的事实（doesNotKnow，复用 computeVisibility 单一契约） */
  cognition?: PlanDimensionSlice<string>
  /** 近章状态变更：谁/什么字段 before→after（chapter-summaries 键控子表） */
  recentStateDeltas?: PlanDimensionSlice<StateDeltaPlanItem>
  /** 见面边界：POV 截至本章已见过的角色（metBefore 'past' — 本章共现不计，堵泄漏） */
  encounter?: PlanDimensionSlice<string>
  /** 粒子持有：POV 的金钱/伤势/功法当前态（复用 computeVisibility 单一契约） */
  particles?: PlanDimensionSlice<ParticlePlanItem>
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
  /**
   * P2-IMP-11：本章 POV 角色（IO 层解析入口）。
   * 缺省回退 `resolveChapterPovCharacter`（POV 真源未落地 → null → 三维 degraded）。
   */
  povCharacter?: string
  /** 认知盲区 top-N（默认 6） */
  cognitionTopN?: number
  /** 近章状态变更 top-N（默认 8） */
  stateDeltaTopN?: number
  /** 见面边界 top-N（默认 10） */
  encounterTopN?: number
  /** 粒子持有 top-N（默认 6） */
  particlesTopN?: number
  /** 近章状态变更取近 N 章（默认 3，与 Grok 调用规则 1「近 3 章」一致） */
  stateDeltaChapters?: number
  /** 单维渲染字符预算（默认 320；逐维独立封顶 — TencentDB L0-L3 分层预算模式） */
  dimensionCharBudget?: number
}
