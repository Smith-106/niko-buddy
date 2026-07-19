/**
 * ISS-20260712-ARCH-1 (Wave 1) SRP 拆分: 从 context-engine.ts 抽出派生 store
 * 文本读取群。5 个同形函数 (read*Text) 各 load 一个派生 store + toContextText
 * 渲染为 protected-tier context text, 失败降级空字符串 (向后兼容)。纯派生读取,
 * 零装配逻辑 — 装配仍归 context-engine.ts buildLoadContext / buildContextPackFromRawData。
 *
 * 抽出动机: context-engine.ts 1880 行承载 9 职责群 (装配/snapshot 加载/temporal
 * 缓存/章节大纲/派生 store 读取/实体选择/检索/字段构建/ContextGap), 派生 store
 * 读取是单一职责 (派生投影 → 文本) 宜独立文件。详见
 * .workflow/scratch/20260719-plan-arch1-context-engine-split/plan.md Wave 1。
 *
 * 守恒: 函数行为零变更 (纯物理移动 module-private → export, context-engine
 * 从本文件 import 调用)。load* + *ToContextText 依赖随移。PAT-G2: wiring.spec.ts
 * (a) Source-level 正则匹配目标同步改读本文件 (测实现位置非行为的反模式, 拆分
 * 时同步更新, 不引入新反模式)。
 */
import { loadEmotionalArcs, emotionalArcsToContextText } from "./emotional-arcs"
import { loadSubplotBoard, subplotBoardToContextText } from "./subplot-board"
import { loadResourceLedger, resourceLedgerToContextText } from "./resource-ledger"
import { loadEmotionLedger, emotionLedgerToContextText } from "./emotion-ledger"
import { loadAuraEvolution, auraEvolutionToContextText } from "./aura-evolution"

/**
 * R4 (S4 / ANL-013): load the emotional-arcs projection store and render its
 * protected-tier context text. Returns "" when the store is empty or absent
 * (backward compatible — no arcs recorded = no injection). Failures are
 * swallowed (non-fatal) to match the readCognitionStates contract; the
 * projection's own commit/fail status is tracked by the
 * ProjectionStatusLedger, not here.
 */
export async function readEmotionalArcsText(pp: string): Promise<string> {
  try {
    const store = await loadEmotionalArcs(pp)
    return emotionalArcsToContextText(store)
  } catch {}
  return ""
}

/**
 * MAINT-002 (TASK-008): read subplot-board store and render as protected-tier
 * context text. Returns "" when the store is empty/absent (backward
 * compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
export async function readSubplotBoardText(pp: string): Promise<string> {
  try {
    const store = await loadSubplotBoard(pp)
    return subplotBoardToContextText(store)
  } catch {}
  return ""
}

/**
 * MAINT-002 (TASK-008): read resource-ledger store and render as
 * protected-tier context text. Returns "" when the store is empty/absent
 * (backward compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
export async function readResourceLedgerText(pp: string): Promise<string> {
  try {
    const store = await loadResourceLedger(pp)
    return resourceLedgerToContextText(store)
  } catch {}
  return ""
}

/**
 * A19 emotion-ledger pilot: read emotion-ledger store and render as
 * protected-tier context text (top-N emotional-debt characters). Returns ""
 * when the store is empty/absent (backward compatible). Failures swallowed
 * (non-fatal) — same contract as readEmotionalArcsText. 机械层零 LLM: netValue
 * 与 history delta 由确定性算术产出，LLM 只读文本化结果作生成约束不参与推断。
 */
export async function readEmotionLedgerText(pp: string): Promise<string> {
  try {
    const store = await loadEmotionLedger(pp)
    return emotionLedgerToContextText(store)
  } catch {}
  return ""
}

/**
 * A19 借鉴点 #3 (PLN-20260716-p14-aura-evolution): P14 画像漂移历史注入为
 * protected-tier canon — 机械层零 LLM 字段 diff 产出的画像变化记录文本化结果，
 * LLM 只读不推断 (语义风格漂移交 LLM 审查, 非本层)。与 emotional-arcs/emotion-ledger
 * 互补 (弧线 beat / 情绪债务 / 画像字段变化 三者不重叠)。空 store 渲染 '' (向后兼容 —
 * 写入端未接入时不注入, 与 emotion-ledger pilot 同款先读端后写入端)。
 * currentChapter 未知时传 0 (time-decay 退化为全保留权重 1, 仍输出历史)。
 */
export async function readAuraEvolutionText(pp: string): Promise<string> {
  try {
    const store = await loadAuraEvolution(pp)
    const names = Object.keys(store.entries)
    if (names.length === 0) return ""
    return names
      .map((n) => auraEvolutionToContextText(store, n, 0))
      .filter((t) => t.length > 0)
      .join("\n")
  } catch {}
  return ""
}
