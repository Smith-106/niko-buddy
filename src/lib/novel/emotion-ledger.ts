/**
 * emotion-ledger.ts — A19 机械层零 LLM 情绪债务账本 (NovelForge-v5 EmotionTracker 移植试点)
 *
 * 对齐 A19 一致性门控"机械层零 LLM"原则: 情绪净值/债务用确定性算术计算,
 * LLM 只读取文本化结果 (emotionLedgerToContextText) 作为生成约束, 不参与情绪推断。
 * Circuit Breaker: netValue 超阈值时 force SUSPEND, 防 fix-loop 无限重写。
 *
 * 与 emotional-arcs.ts 互补不重叠:
 *   - emotional-arcs (R4/ANL-013): 情绪弧线 beat 序列 (emotion/intensity/trigger)
 *   - emotion-ledger (A19 试点): 情绪债务账本 (valence/arousal/dominance/netValue
 *     + history delta + Circuit Breaker) — 机械层零 LLM 确定性算术。
 *
 * 参考来源: NovelForge-v5 (2572873335/novel_generator) EmotionTracker。
 * 落点锚点: src/lib/novel/character-state.ts (角色认知锚点扩展, 同域辅助文件)。
 * 持久化层复用 createAtomicJsonStore (MAINT-002 同域模式, 与 emotional-arcs/
 * resource-ledger/subplot-board 共享 boilerplate, 不新开第三套 save/load)。
 */

import { createAtomicJsonStore } from "./projection-store"
import type {
  EmotionHistoryEntry,
  EmotionLedgerEntry,
  EmotionLedgerStore,
  EmotionState,
} from "@/lib/novel/character-state"

// Re-export the schema types so same-layer siblings (specs, future callers)
// can consume them from the emotion-ledger module without reaching into
// character-state.ts directly. A19 职责边界: schema 定义在 character-state.ts
// (角色认知锚点), emotion-ledger.ts 只消费 + re-export, 不重复定义。
export type {
  EmotionHistoryEntry,
  EmotionLedgerEntry,
  EmotionLedgerStore,
  EmotionState,
}

// 权重对齐 TASK-002: valence 主导 (0.4), arousal/dominance 各 0.3。
// netValue 含 history delta sum — 长期情绪债务累积反映在净值。
const WEIGHT_VALENCE = 0.4
const WEIGHT_AROUSAL = 0.3
const WEIGHT_DOMINANCE = 0.3

function clampUnit(value: number): number {
  // 情绪轴规范 -1.0 ~ 1.0, 越界 clamp (LLM/外部输入可能给脏值)。
  if (value < -1) return -1
  if (value > 1) return 1
  return value
}

/**
 * 计算情绪净值 (机械层确定性算术, 零 LLM)。
 * netValue = (valence*0.4 + arousal*0.3 + dominance*0.3) + history delta 累积和。
 * delta 为负代表情绪债务累积 (角色持续承压), 正代表情绪回升。
 */
export function calculateEmotionNetValue(entry: EmotionLedgerEntry): number {
  const base =
    clampUnit(entry.valence) * WEIGHT_VALENCE +
    clampUnit(entry.arousal) * WEIGHT_AROUSAL +
    clampUnit(entry.dominance) * WEIGHT_DOMINANCE
  const historySum = entry.history.reduce((sum, h) => sum + h.delta, 0)
  return base + historySum
}

/**
 * 应用情绪 delta 并追加 history 记录 (纯函数, 不修改入参)。
 * 返回新 entry: 更新三轴快照 + netValue 重算 + history 追加本次 delta。
 */
export function applyEmotionDelta(
  entry: EmotionLedgerEntry,
  delta: { valence?: number; arousal?: number; dominance?: number; reason: string },
  chapter: number,
): EmotionLedgerEntry {
  const next: EmotionState = {
    valence: clampUnit(entry.valence + (delta.valence ?? 0)),
    arousal: clampUnit(entry.arousal + (delta.arousal ?? 0)),
    dominance: clampUnit(entry.dominance + (delta.dominance ?? 0)),
  }
  // delta 记录本次变化幅度 (三轴 delta 之和), 供 history 追踪情绪债务轨迹。
  const deltaMagnitude =
    (delta.valence ?? 0) + (delta.arousal ?? 0) + (delta.dominance ?? 0)
  const historyEntry: EmotionHistoryEntry = {
    chapter,
    delta: deltaMagnitude,
    reason: delta.reason,
  }
  const draft: EmotionLedgerEntry = {
    characterName: entry.characterName,
    valence: next.valence,
    arousal: next.arousal,
    dominance: next.dominance,
    netValue: 0, // 占位, 下面重算
    lastUpdatedChapter: chapter,
    history: [...entry.history, historyEntry],
  }
  draft.netValue = calculateEmotionNetValue(draft)
  return draft
}

/**
 * 取情绪债务最高的 N 个角色 (netValue 升序, 越负代表债务越重)。
 * 用于 context-engine 注入 — 让 LLM 知道哪些角色情绪已透支需在后续章节补偿。
 */
export function getTopEmotionalDebt(
  store: EmotionLedgerStore,
  limit: number,
): EmotionLedgerEntry[] {
  return [...store.entries]
    .sort((a, b) => a.netValue - b.netValue)
    .slice(0, limit)
}

/**
 * 将情绪账本条目文本化为 LLM 可读上下文 (LLM 只读不推断, A19 零 LLM 原则)。
 * 返回如: "角色A：情绪净值 -0.70，长期承压状态；效价 -0.50，唤醒 0.30，支配 -0.20"
 */
export function formatEmotionContext(entry: EmotionLedgerEntry): string {
  const debtLabel = entry.netValue < -0.3 ? "长期承压状态" : entry.netValue > 0.3 ? "情绪积极状态" : "情绪平稳"
  return (
    `${entry.characterName}：情绪净值 ${entry.netValue.toFixed(2)}，${debtLabel}；` +
    `效价 ${entry.valence.toFixed(2)}，唤醒 ${entry.arousal.toFixed(2)}，支配 ${entry.dominance.toFixed(2)}`
  )
}

export function createEmptyEmotionLedgerStore(): EmotionLedgerStore {
  return { entries: [], lastUpdated: new Date().toISOString() }
}

// MAINT-002 同域模式: 复用 createAtomicJsonStore (与 emotional-arcs/resource-ledger/
// subplot-board 共享 save/load boilerplate, F-002 atomic 写, fold_rebuildable)。
const emotionLedgerStore = createAtomicJsonStore<EmotionLedgerStore>(
  "emotion-ledger.json",
  createEmptyEmotionLedgerStore,
)

export async function saveEmotionLedger(
  projectPath: string,
  store: EmotionLedgerStore,
): Promise<void> {
  await emotionLedgerStore.save(projectPath, store)
}

export async function loadEmotionLedger(
  projectPath: string,
): Promise<EmotionLedgerStore> {
  return emotionLedgerStore.load(projectPath)
}

/**
 * Q4 Decision Gate Circuit Breaker (ADR-17 fix-loop max_retry=3 配套):
 * 任一角色 netValue 低于 threshold (情绪债务超阈值) → tripped=true,
 * 生成层应 force SUSPEND 避免 fix-loop 在角色情绪已崩时继续无限重写。
 * 机械层判定, 零 LLM。
 */
export function checkEmotionCircuitBreaker(
  store: EmotionLedgerStore,
  threshold: number,
): { tripped: boolean; reason: string } {
  const worst = getTopEmotionalDebt(store, 1)[0]
  if (worst && worst.netValue < threshold) {
    return {
      tripped: true,
      reason: `情绪债务熔断: ${worst.characterName} 净值 ${worst.netValue.toFixed(2)} 低于阈值 ${threshold} (长期承压, 应 SUSPEND 生成避免 fix-loop 无限重写)`,
    }
  }
  return { tripped: false, reason: "" }
}

/**
 * Render top-N emotional-debt entries as protected-tier context text (与
 * emotionalArcsToContextText 同款模式, 供 context-engine 并入 characterStates 注入)。
 * 只注入 netValue 最低 (债务最重) 的 N 个角色, 避免上下文膨胀。空 store 返回 ""。
 */
export function emotionLedgerToContextText(store: EmotionLedgerStore): string {
  if (store.entries.length === 0) return ""
  const top = getTopEmotionalDebt(store, 5)
  return top.map((e) => `- ${formatEmotionContext(e)}`).join("\n")
}
