/**
 * story-thread-arcs.ts — S2c absorb: Quillica Story Threads 6 状态机
 * (roadmap S2 P0 连续性深化 · R08 Story Threads 状态机)
 *
 * 参考 (reference/ 只读): quillica-design/quillica-full-design.md §6.5
 *   线索状态机 (实测确认 6 状态): Setup → Rising → Climax → Falling →
 *   Resolved / Unresolved (Sequel)
 *   - Unresolved (Sequel) 是跨书续写状态 — 未解决线索显式标记留待续卷
 *   - 13 种线索类型 + End State Analysis (弧与线索结局分析)
 *
 * 合并策略 (roadmap: 合并非双轨): 本模块是 deterministic-continuity-engine
 * 的**新增检测维度** — 基于 Subplot 已有字段 (status/progress/startChapter/
 * resolvedChapter/lastSeenChapter) 派生 Quillica 6 态, 产出 continuity finding,
 * 不新建平行引擎、不重复 dormant/absent/overdue 判定 (那些仍由现有 4 检测器负责)。
 *
 * 状态映射 (派生, 不改变 Subplot.status 存储语义):
 *   proposed  → Setup
 *   active + progress 空/少 → Rising
 *   active + progress 多 (≥5) 且近期推进 → Climax
 *   resolved → Resolved
 *   活跃但长期未推进 (dormant) → Falling (弧线回落)
 *   被 abandoned 或跨卷未结 → Unresolved (Sequel)
 */

import type { Subplot } from "./subplot-board"

// ============================================================================
// Quillica 6 状态机
// ============================================================================

export type ThreadArcState =
  | "Setup"        // 铺设 (线索引入)
  | "Rising"       // 上升 (发展)
  | "Climax"       // 高潮
  | "Falling"      // 回落
  | "Resolved"     // 已解决
  | "Unresolved"   // 未解决 (Sequel — 跨卷续写)

export const THREAD_ARC_STATES: readonly ThreadArcState[] = [
  "Setup", "Rising", "Climax", "Falling", "Resolved", "Unresolved",
] as const

/** Quillica 13 种线索类型 (中文适配) */
export type ThreadArcKind =
  | "Romance" | "Mystery" | "CharacterArc" | "Political" | "Thematic"
  | "Adventure" | "Rivalry" | "Betrayal" | "Redemption" | "Foreshadowing"
  | "Clue" | "Motif" | "Other"

export const THREAD_ARC_KINDS: readonly ThreadArcKind[] = [
  "Romance", "Mystery", "CharacterArc", "Political", "Thematic",
  "Adventure", "Rivalry", "Betrayal", "Redemption", "Foreshadowing",
  "Clue", "Motif", "Other",
] as const

/** 6 状态转移合法性 (Setup→Rising→Climax→Falling→Resolved/Unresolved; 允许回退到 Falling 后 Rising) */
export const THREAD_ARC_TRANSITIONS: Readonly<Record<ThreadArcState, readonly ThreadArcState[]>> = {
  Setup: ["Rising"],
  Rising: ["Climax", "Falling"],
  Climax: ["Falling", "Resolved"],
  Falling: ["Rising", "Resolved", "Unresolved"],
  Resolved: [],
  Unresolved: [],
}

// ============================================================================
// 状态派生 (基于 Subplot 已有字段, 纯函数)
// ============================================================================

export interface ThreadArcDeriveOptions {
  /** Climax 判定: progress 条目数达到该值视为高潮段 (默认 5) */
  climaxProgressCount?: number
  /** Falling 判定: lastSeenChapter 距今超过该章数视为回落 (默认复用 dormant 语义 10) */
  fallingGapChapters?: number
}

export interface ThreadArcDerived {
  subplotId: string
  title: string
  arcState: ThreadArcState
  /** 派生依据 (进 finding evidence) */
  basis: string
  /** 是否 Arc 断裂 (状态机合法性违反, 如 Resolved 后仍有 progress) */
  transitionViolation?: string
}

const DEFAULT_CLIMAX_PROGRESS_COUNT = 5
const DEFAULT_FALLING_GAP = 10

/**
 * 把 Subplot 派生为 Quillica 6 态。不改变 Subplot.status 存储语义 —
 * 纯派生视图 (与 temporal-memory 的 VIEW 角色一致, 不建第二真源)。
 */
export function deriveThreadArcState(
  subplot: Subplot,
  currentChapter: number,
  options: ThreadArcDeriveOptions = {},
): ThreadArcDerived {
  const climaxProgress = options.climaxProgressCount ?? DEFAULT_CLIMAX_PROGRESS_COUNT
  const fallingGap = options.fallingGapChapters ?? DEFAULT_FALLING_GAP

  // Resolved / Unresolved (终态)
  if (subplot.status === "resolved" || subplot.resolvedChapter !== undefined) {
    return { subplotId: subplot.id, title: subplot.title, arcState: "Resolved", basis: "已解决" }
  }
  if (subplot.abandoned === true) {
    return { subplotId: subplot.id, title: subplot.title, arcState: "Unresolved", basis: "废弃/跨卷未结" }
  }

  // 活跃状态: 用 progress + lastSeenChapter 推弧位
  const progressCount = subplot.progress?.length ?? 0
  const lastSeen = subplot.lastSeenChapter
  const stale = lastSeen !== undefined && currentChapter - lastSeen >= fallingGap

  if (subplot.status === "proposed") {
    return { subplotId: subplot.id, title: subplot.title, arcState: "Setup", basis: "提议/铺设" }
  }

  if (stale) {
    // 长期未推进 → 弧线回落 (Falling); 若曾到高潮段则是高潮后回落
    const wasClimax = progressCount >= climaxProgress
    return {
      subplotId: subplot.id,
      title: subplot.title,
      arcState: "Falling",
      basis: wasClimax ? `高潮段后 ${currentChapter - lastSeen!} 章未推进` : `铺设后 ${currentChapter - lastSeen!} 章未推进`,
    }
  }

  if (progressCount >= climaxProgress) {
    return { subplotId: subplot.id, title: subplot.title, arcState: "Climax", basis: `进度条目 ${progressCount} 条` }
  }

  if (progressCount >= 1) {
    return { subplotId: subplot.id, title: subplot.title, arcState: "Rising", basis: "发展中" }
  }

  return { subplotId: subplot.id, title: subplot.title, arcState: "Setup", basis: "引入未推进" }
}

/**
 * 检查 Arc 转移合法性: 若历史 progress 显示曾进入某阶段, 现状态回退非法则标记。
 * 简化实现: Resolved 后仍新增 progress → transitionViolation。
 */
export function detectArcTransitionViolations(
  subplot: Subplot,
  derived: ThreadArcDerived,
): ThreadArcDerived {
  if (derived.arcState === "Resolved" && (subplot.progress?.length ?? 0) > 0) {
    // resolved 后仍有 progress 条目 → 状态机违反 (终态后不可再有推进)
    const lastProgress = subplot.progress[subplot.progress.length - 1]!
    if (!/解决|完成|回收|闭环/.test(lastProgress)) {
      return { ...derived, transitionViolation: "Resolved 后仍有新增进度条目" }
    }
  }
  return derived
}

// ============================================================================
// Continuity finding 集成 (合并进 deterministic-continuity-engine)
// ============================================================================

/**
 * 派生全部活跃 subplot 的 6 态, 返回 Quillica 视角的状态快照。
 * 供 continuity engine 作为新检测维度消费 (不重复 dormant/absent 判定)。
 */
export function deriveAllThreadArcStates(
  subplots: readonly Subplot[],
  currentChapter: number,
  options: ThreadArcDeriveOptions = {},
): ThreadArcDerived[] {
  return subplots.map((s) => detectArcTransitionViolations(s, deriveThreadArcState(s, currentChapter, options)))
}

/** 渲染 6 态快照文本 (注入上下文用) */
export function threadArcStatesToContextText(derived: readonly ThreadArcDerived[]): string {
  if (derived.length === 0) return ""
  const lines = derived.map((d) => {
    const violation = d.transitionViolation ? ` ⚠ ${d.transitionViolation}` : ""
    return `- [${d.arcState}] ${d.title} (${d.basis})${violation}`
  })
  return `Story Threads 弧位:\n${lines.join("\n")}`
}

/** 未终结弧计数 (Setup+Rising+Climax+Falling = 未终结; Resolved/Unresolved = 终态) */
export function countOpenThreadArcs(derived: readonly ThreadArcDerived[]): number {
  return derived.filter((d) => d.arcState !== "Resolved" && d.arcState !== "Unresolved").length
}
