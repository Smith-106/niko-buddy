/**
 * aura-evolution.ts — P14 仿写画像进化层 (A19 借鉴点 #3, 零 LLM 字段 diff + time-decay)
 *
 * 借鉴点 #3 (ANL-20260715-16proj-selrev F-007): QMAI character-aura.ts P14 schema
 * 已完整 (expressionDna/mentalModel/decisionHeuristics/valueAntiPatterns/honestyBoundaries),
 * 但缺 per-character 风格追踪历史 (进化层) — 当前 aura 是静态快照, 不追踪角色风格
 * 随章节的漂移。本模块补派生观测层: 字段 diff (=== 比对) + time-decay eviction。
 *
 * 诚实标注机械层价值局限 (plan DD-3): 风格漂移检测本质需语义比对 (表达风格变化
 * 不只是字段值变化), 纯字段 diff 只能抓字段值是否改变, 不能抓语义漂移 (如
 * expressionDna 文本换了但风格其实没变, 或没换但语义变了)。本模块只做机械字段
 * diff + time-decay (派生观测), 语义风格漂移检测交 LLM 审查 (deferred, 非 A19)。
 * 这是 A19 边界 — 机械层不替代语义层。
 *
 * 与 emotional-arcs/emotion-ledger 互补不重叠:
 *   - emotional-arcs: 情绪弧线 beat 序列
 *   - emotion-ledger: 情绪债务账本 (valence/arousal/dominance)
 *   - aura-evolution (本模块): 画像字段变化历史 (风格 schema 漂移, 非情绪)
 *
 * 参考 (只读, 不改上游):
 *   - StoryForge StyleDNA 六维 (架构参考)
 *   - niko-studio per-scene CharacterState (时间点层参考)
 *   - novel-writer 15 作者模板 (F-005, 成本高只参考)
 *   - ANL-004-A3 角色认知融合四层 (认知/画像/时间点/进化 — 本模块是进化层)
 *
 * 持久化层复用 createAtomicJsonStore (MAINT-002 同域, 与 emotion-ledger/
 * emotional-arcs/resource-ledger/subplot-board 共享 save/load boilerplate)。
 */

import { createAtomicJsonStore } from "./projection-store"
import type { CharacterAura } from "./character-aura"

/**
 * P14 画像核心字段 (diff 比对这些字段值是否变化)。
 * 不含 id/name/corpus 等元数据字段 (这些不是风格画像本身)。
 */
const AURA_STYLE_FIELDS: Array<keyof CharacterAura> = [
  "styleDescription",
  "behaviorRules",
  "expressionDna",
  "mentalModel",
  "decisionHeuristics",
  "valueAntiPatterns",
  "honestyBoundaries",
]

/** 单次画像快照 (只存 P14 风格字段, 不存元数据, 控制 store 体积) */
export interface AuraStyleSnapshot {
  styleDescription?: string
  behaviorRules?: string
  expressionDna?: string
  mentalModel?: string
  decisionHeuristics?: string
  valueAntiPatterns?: string
  honestyBoundaries?: string
}

export interface AuraHistoryEntry {
  chapter: number
  /** 本章画像快照 (P14 字段) */
  snapshot: AuraStyleSnapshot
  /** 与前版相比变化的字段名列表 (机械 === diff, 非语义) */
  fieldDeltas: string[]
  /** time-decay 权重 (近期高, 老章节衰减, applyTimeDecay 填充) */
  weight: number
}

export interface AuraEvolutionStore {
  /** key=characterName, value=该角色的画像变化历史 (按 chapter 升序) */
  entries: Record<string, AuraHistoryEntry[]>
  lastUpdated: string
}

/** time-decay 衰减系数: weight = exp(-DECAY_RATE * 章节差) */
const DECAY_RATE = 0.1
/** 滑动窗口: 只保留近 N 章的历史 (控制 store 膨胀, DD-2) */
const SLIDING_WINDOW_SIZE = 10

/**
 * 字段 diff (零 LLM 机械 === 比对): 比较 prev/curr 的 P14 风格字段值,
 * 返回变化的字段名列表。纯值比较, 不做语义分析 (DD-3 诚实收窄)。
 * 字段从 undefined→有值 也算变化 (首次设定)。
 */
export function diffAuraFields(prev: CharacterAura, curr: CharacterAura): string[] {
  const deltas: string[] = []
  for (const field of AURA_STYLE_FIELDS) {
    const prevVal = prev[field]
    const currVal = curr[field]
    // === 比对: undefined/空串 视为无值, 有值变化才算 delta
    if ((prevVal ?? "") !== (currVal ?? "")) {
      deltas.push(String(field))
    }
  }
  return deltas
}

/** 从 CharacterAura 提取 P14 风格快照 (只存风格字段, 不存元数据) */
export function snapshotAura(aura: CharacterAura): AuraStyleSnapshot {
  return {
    styleDescription: aura.styleDescription,
    behaviorRules: aura.behaviorRules,
    expressionDna: aura.expressionDna,
    mentalModel: aura.mentalModel,
    decisionHeuristics: aura.decisionHeuristics,
    valueAntiPatterns: aura.valueAntiPatterns,
    honestyBoundaries: aura.honestyBoundaries,
  }
}

/**
 * time-decay eviction (零 LLM 算术): 滑动窗口保留近 SLIDING_WINDOW_SIZE 章 +
 * 指数衰减权重 weight = exp(-DECAY_RATE * (currentChapter - entry.chapter))。
 * 近期画像权重高, 老章节权重低 (DD-2)。返回新数组, 不修改入参。
 */
export function applyTimeDecay(
  entries: AuraHistoryEntry[],
  currentChapter: number,
  windowSize: number = SLIDING_WINDOW_SIZE,
): AuraHistoryEntry[] {
  // 按章节升序取近 windowSize 章
  const sorted = [...entries].sort((a, b) => a.chapter - b.chapter)
  const recent = sorted.slice(-windowSize)
  return recent.map((entry) => ({
    ...entry,
    weight: Math.exp(-DECAY_RATE * (currentChapter - entry.chapter)),
  }))
}

/**
 * 追加一章画像快照到角色历史 (纯函数, 不修改入参 store)。
 * 若与最近一版无字段变化 (fieldDeltas 空), 不追加 (避免无意义历史膨胀)。
 */
export function appendAuraSnapshot(
  store: AuraEvolutionStore,
  characterName: string,
  chapter: number,
  snapshot: AuraStyleSnapshot,
  fieldDeltas: string[],
): AuraEvolutionStore {
  // 无变化不追加 (减少 store 膨胀)
  if (fieldDeltas.length === 0) return store
  const entry: AuraHistoryEntry = {
    chapter,
    snapshot,
    fieldDeltas,
    weight: 1, // applyTimeDecay 会重算
  }
  const prevHistory = store.entries[characterName] ?? []
  return {
    entries: { ...store.entries, [characterName]: [...prevHistory, entry] },
    lastUpdated: new Date().toISOString(),
  }
}

export function createEmptyAuraEvolutionStore(): AuraEvolutionStore {
  return { entries: {}, lastUpdated: new Date().toISOString() }
}

// MAINT-002 同域模式: 复用 createAtomicJsonStore (与 emotion-ledger/emotional-arcs/
// resource-ledger/subplot-board 共享 save/load boilerplate, F-002 atomic 写)。
const auraEvolutionStore = createAtomicJsonStore<AuraEvolutionStore>(
  "aura-evolution.json",
  createEmptyAuraEvolutionStore,
)

export async function saveAuraEvolution(
  projectPath: string,
  store: AuraEvolutionStore,
): Promise<void> {
  await auraEvolutionStore.save(projectPath, store)
}

export async function loadAuraEvolution(
  projectPath: string,
): Promise<AuraEvolutionStore> {
  return auraEvolutionStore.load(projectPath)
}

/**
 * 文本化角色画像漂移历史供 LLM 参考 (与 emotionLedgerToContextText 同款 bullet 模式)。
 * A19 零 LLM: 漂移由机械字段 diff 判定, LLM 只读本报告作生成/审查参考不参与 diff。
 * 应用 time-decay 后输出近 windowSize 章的变化记录。空历史返回 ""。
 */
export function auraEvolutionToContextText(
  store: AuraEvolutionStore,
  characterName: string,
  currentChapter: number = 0,
): string {
  const history = store.entries[characterName]
  if (!history || history.length === 0) return ""
  const decayed = applyTimeDecay(history, currentChapter)
  /* v8 ignore next */
  if (decayed.length === 0) return ""
  const lines = decayed.map((e) => {
    const wPct = (e.weight * 100).toFixed(0)
    return `- 第${e.chapter}章画像变化 (权重${wPct}%): ${e.fieldDeltas.join("、")}`
  })
  return `${characterName} 画像漂移历史:\n${lines.join("\n")}`
}
