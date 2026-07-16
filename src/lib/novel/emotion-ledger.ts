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
import { loadCharacterStates } from "./character-state"
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

// ============================================================================
// A19 写入端 (B 方案双层机械层, TASK-001) — 零 LLM: 正则词典 + 共现匹配
//
// 死电路修复: 前序 pilot (读端+熔断) 让 emotion-ledger store 有读无写, store 永远空
// → 读端恒返回 '' → Circuit Breaker 永不触发。本节接入写入端, 在 formal-writeback
// (Draft-first accept 回填点) 扫正文提取情绪基调 + 共现匹配出场角色, 写入 store。
//
// 双层 (DD-1/DD-2):
//   - 全书基调层: extractChapterEmotionTone 正则扫正文关键词词典产出单一三轴 delta
//   - per-character 分配层: resolveSceneCharacterNames 读 character-states.json 角色全集
//     + 正文共现匹配判定本章出场角色, 基调 delta 均分给每个出场角色 (applyEmotionDelta)
//
// 词典来源: NovelForge-v5/core/emotion_tracker.py (PAYOFF/PRESSURE/NEUTRAL, 只读参考)。
// 去掉大纲专有标记 (情绪净值(+)/(+) 等, QMAI 大纲无此 schema), 保留叙事关键词。
// ============================================================================

/**
 * 情绪关键词词典 (NovelForge-v5 移植, 只读参考不改上游)。
 * 三类: payoff (爽点/正向) / pressure (压抑/负向) / neutral (过渡/平稳)。
 * 权重对齐 NovelForge-v5: 章节级标记 8-10, 核心 2.5-3, 次级 1.5, 日常 0.5-1。
 * 去掉大纲专有标记 ((+)/(0)/情绪净值(+), QMAI 大纲无此 schema, 正文也不会有)。
 */
const EMOTION_KEYWORD_LEXICON = {
  payoff: [
    { kw: "爽点", w: 8 }, { kw: "高潮", w: 8 }, { kw: "大高潮", w: 10 },
    { kw: "打脸", w: 3 }, { kw: "逆袭", w: 3 }, { kw: "突破", w: 2.5 }, { kw: "复仇", w: 2.5 },
    { kw: "反转", w: 2 }, { kw: "秒杀", w: 2.5 }, { kw: "碾压", w: 2 }, { kw: "爆发", w: 2 },
    { kw: "顿悟", w: 2 }, { kw: "觉醒", w: 2 }, { kw: "揭露", w: 2 },
    { kw: "胜利", w: 1.5 }, { kw: "收获", w: 1.5 }, { kw: "成长", w: 1.5 }, { kw: "认可", w: 1.5 },
    { kw: "惊喜", w: 1 }, { kw: "奇遇", w: 1.5 }, { kw: "宝物", w: 1 }, { kw: "传承", w: 1.5 },
    { kw: "有趣", w: 0.5 }, { kw: "搞笑", w: 0.5 }, { kw: "甜蜜", w: 0.5 }, { kw: "温暖", w: 0.5 },
  ],
  pressure: [
    { kw: "压抑", w: 8 }, { kw: "低谷", w: 6 },
    { kw: "死亡", w: 3 }, { kw: "失败", w: 2.5 }, { kw: "失去", w: 2.5 }, { kw: "背叛", w: 3 },
    { kw: "危机", w: 2 }, { kw: "困境", w: 2 }, { kw: "强敌", w: 2 }, { kw: "压迫", w: 2 },
    { kw: "焦虑", w: 1.5 }, { kw: "担忧", w: 1.5 }, { kw: "恐惧", w: 1.5 }, { kw: "悲伤", w: 2 },
    { kw: "痛苦", w: 2 }, { kw: "绝望", w: 2.5 }, { kw: "无奈", w: 1.5 }, { kw: "纠结", w: 1 },
  ],
  neutral: [
    { kw: "过渡", w: 3 }, { kw: "铺垫", w: 2 }, { kw: "日常", w: 1 },
  ],
} as const

/** 词典三轴 delta 归一化基数: 单类最大可能权重和 (用于映射到 -1~1)。 */
const TONE_NORMALIZE_BASE = 10

/**
 * 统计正文中三类关键词的命中权重和。纯机械零 LLM, 简单 indexOf 累加
 * (中文无词界, indexOf 足够; 同一关键词多次出现只计一次权重, 避免长文堆叠失真)。
 */
function countLexiconHits(content: string, list: readonly { kw: string; w: number }[]): number {
  let total = 0
  for (const { kw, w } of list) {
    if (content.includes(kw)) total += w
  }
  return total
}

/**
 * B 方案全书基调层: 正则扫正文关键词词典产出三轴情绪 delta (机械层零 LLM)。
 *
 * 三轴映射 (对齐 EmotionState 语义 valence 效价/arousal 唤醒/dominance 支配):
 *   - valence = (payoffW - pressureW) / base  (正向-负向, 爽点拉正压抑拉负)
 *   - arousal = (payoffW + pressureW) / base  (情绪激烈度, 爽点+压抑都激增唤醒)
 *   - dominance = (payoffW - pressureW) / base (掌控感, 爽点增掌控压抑减)
 * 三轴 clamp 到 [-1,1] (复用 clampUnit)。neutral 不影响三轴 (过渡/铺垫是节奏非情绪)。
 * 空正文或零命中 (无 payoff/pressure 关键词, 仅 neutral 或全空) 返回 {0,0,0, 无情绪标记}。
 *
 * reason 记录三类命中数, 供 applyEmotionDelta history 追溯 (e.g. "payoff:12/pressure:3/neutral:0")。
 */
export function extractChapterEmotionTone(chapterContent: string): {
  valence: number
  arousal: number
  dominance: number
  reason: string
} {
  if (!chapterContent || chapterContent.trim().length === 0) {
    return { valence: 0, arousal: 0, dominance: 0, reason: "无情绪标记" }
  }
  const payoffW = countLexiconHits(chapterContent, EMOTION_KEYWORD_LEXICON.payoff)
  const pressureW = countLexiconHits(chapterContent, EMOTION_KEYWORD_LEXICON.pressure)
  const neutralW = countLexiconHits(chapterContent, EMOTION_KEYWORD_LEXICON.neutral)
  if (payoffW === 0 && pressureW === 0) {
    // 无爽点/压抑关键词 (纯 neutral 或无任何情绪词) → 不产生 delta (backward compat,
    // 中性章节不污染情绪账本)。
    return { valence: 0, arousal: 0, dominance: 0, reason: `无情绪标记(neutral:${neutralW})` }
  }
  const valence = clampUnit((payoffW - pressureW) / TONE_NORMALIZE_BASE)
  const arousal = clampUnit((payoffW + pressureW) / TONE_NORMALIZE_BASE)
  const dominance = clampUnit((payoffW - pressureW) / TONE_NORMALIZE_BASE)
  return {
    valence,
    arousal,
    dominance,
    reason: `payoff:${payoffW}/pressure:${pressureW}/neutral:${neutralW}`,
  }
}

/**
 * B 方案 per-character 分配层: 读 character-states.json 角色全集 + 在正文共现匹配,
 * 判定本章出场角色名集合 (机械层零 LLM)。
 *
 * 共现匹配: 遍历 allCharacterNames, 精确 indexOf 包含判定 (中文无词界)。
 * 长名优先 (避免 '白' 抢先匹配 '白月' 的子串场景) — 调用方传入前应按名长度降序,
 * 但本函数只做判定不排序, 子串命中由精确名决定 (见测试子串用例)。
 *
 * 空全集或正文无任何已知角色 → 返回 [] (本章无出场角色, 不写账本, backward compat)。
 */
export function resolveSceneCharacterNames(
  chapterContent: string,
  allCharacterNames: string[],
): string[] {
  if (!chapterContent || allCharacterNames.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of allCharacterNames) {
    if (name && name.length > 0 && chapterContent.includes(name) && !seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

/**
 * 初始化空 EmotionLedgerEntry (三轴 0, netValue 0, history 空)。用于角色首次出现于
 * 情绪账本时 upsert。
 */
function createEmptyEmotionLedgerEntry(characterName: string): EmotionLedgerEntry {
  return {
    characterName,
    valence: 0,
    arousal: 0,
    dominance: 0,
    netValue: 0,
    lastUpdatedChapter: 0,
    history: [],
  }
}

/**
 * B 方案写入编排 (TASK-002): 从章节正文提取情绪基调 + 共现匹配出场角色 +
 * 基调 delta 均分给每个出场角色 (applyEmotionDelta) + 落盘。机械层零 LLM。
 *
 * 均分语义 (DD-1): 每个出场角色获得完整 tone delta (不除以人数) — 一场戏所有在场
 * 角色共同经历该情绪。零出场角色或 tone 全 0 → 不写账本 (backward compat, 中性/
 * 无角色章节不污染账本)。tone 来自 extractChapterEmotionTone, 角色全集来自
 * loadCharacterStates (.novel/character-states.json), 落盘走 saveEmotionLedger
 * (createAtomicJsonStore, F-002 atomic)。
 *
 * failure 由调用方 (formal-writeback) try/catch 降级非致命 — 本函数抛错让上层决定
 * 降级策略, 不在此吞错 (保持纯编排语义, 便于测试)。
 */
export async function updateEmotionLedgerFromChapter(
  projectPath: string,
  chapterNumber: number,
  chapterContent: string,
): Promise<void> {
  const tone = extractChapterEmotionTone(chapterContent)
  // tone 全 0 (无情绪标记/中性章节) → 不写账本, backward compat。
  if (tone.valence === 0 && tone.arousal === 0 && tone.dominance === 0) return

  const charStore = await loadCharacterStates(projectPath)
  const allNames = charStore.characters.map((c) => c.characterName)
  const sceneNames = resolveSceneCharacterNames(chapterContent, allNames)
  // 零出场角色 (正文无已知角色, 如新角色首章未入 character-states.json) → 不写账本,
  // backward compat。该角色下章入 store 后才计情绪 (可接受, 首章情绪缺失非阻塞)。
  if (sceneNames.length === 0) return

  const ledger = await loadEmotionLedger(projectPath)
  for (const name of sceneNames) {
    const existing = ledger.entries.find((e) => e.characterName === name)
    const entry = existing ?? createEmptyEmotionLedgerEntry(name)
    // 均分: 每个出场角色得完整 tone delta (DD-1, 不除以人数)。
    const updated = applyEmotionDelta(
      entry,
      {
        valence: tone.valence,
        arousal: tone.arousal,
        dominance: tone.dominance,
        reason: tone.reason,
      },
      chapterNumber,
    )
    if (existing) {
      // upsert: 替换现有 entry。
      const idx = ledger.entries.indexOf(existing)
      ledger.entries[idx] = updated
    } else {
      ledger.entries.push(updated)
    }
  }
  ledger.lastUpdated = new Date().toISOString()
  await saveEmotionLedger(projectPath, ledger)
}
