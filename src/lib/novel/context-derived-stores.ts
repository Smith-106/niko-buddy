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
import { loadEmotionalArcs, emotionalArcsToContextText, type EmotionalArcStore } from "./emotional-arcs"
import { logger } from "@/lib/utils"
import { loadSubplotBoard, subplotBoardToContextText } from "./subplot-board"
import { loadResourceLedger, resourceLedgerToContextText, type ResourceEntry, type ResourceLedgerStore } from "./resource-ledger"
import { loadEmotionLedger, emotionLedgerToContextText } from "./emotion-ledger"
import { loadAuraEvolution, auraEvolutionToContextText } from "./aura-evolution"
import { loadCognitionState, cognitionToContextText, type CognitionState } from "./character-cognition"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ContextLoadContext } from "./context-data-source"

export interface ContextProjectionReadOptions {
  beforeChapter?: number
  recordGap?: ContextLoadContext["recordGap"]
}

function isBeforeChapter(chapter: number, beforeChapter: number): boolean {
  return Number.isInteger(chapter) && chapter > 0 && chapter < beforeChapter
}

function recordUnavailable(options: ContextProjectionReadOptions | undefined, ref: string): void {
  options?.recordGap?.(ref, "temporal_history_unavailable")
}

function invalidBeforeChapter(options: ContextProjectionReadOptions | undefined, ref: string): boolean {
  const chapter = options?.beforeChapter
  if (chapter === undefined || (Number.isInteger(chapter) && chapter > 0)) return false
  recordUnavailable(options, ref)
  return true
}

/** 仅初始化既有注册表并读取当前快照；不调用 load/save/rebuild/self-heal hook。 */
async function foldBeforeChapter(
  projectPath: string,
  projection: "emotional_arc" | "resource_ledger" | "cognition",
  beforeChapter: number,
): Promise<{ snapshots: ChapterSnapshot[]; view: unknown }> {
  // 动态初始化避免 history → context-engine 的反向 import 在模块求值时成环。
  await import("./chapter-ingest")
  const { loadValidMemorySnapshots } = await import("./chapter-ingest-history")
  const { PROJECTION_REGISTRY } = await import("./projection-status-ledger")
  const snapshots = (await loadValidMemorySnapshots(projectPath))
    .filter((snapshot) => isBeforeChapter(snapshot.chapterNumber, beforeChapter)
      && (projection !== "cognition" || (snapshot.sourceType !== "outline" && snapshot.isHistorical !== true)))
  const fold = PROJECTION_REGISTRY[projection]?.foldFromSnapshot
  return { snapshots, view: fold?.(snapshots, { now: "" }) }
}

function isCognitionState(value: unknown): value is CognitionState {
  return value !== null && typeof value === "object"
    && "characters" in value && Array.isArray(value.characters)
    && value.characters.every((character: unknown) => character !== null && typeof character === "object"
      && "character" in character && typeof character.character === "string"
      && "knows" in character && Array.isArray(character.knows)
      && character.knows.every((fact: unknown) => typeof fact === "string")
      && "doesNotKnow" in character && Array.isArray(character.doesNotKnow)
      && character.doesNotKnow.every((fact: unknown) => typeof fact === "string"))
    && "readerKnows" in value && Array.isArray(value.readerKnows)
    && value.readerKnows.every((fact: unknown) => typeof fact === "string")
    && "lastUpdatedChapter" in value && typeof value.lastUpdatedChapter === "number"
    && Number.isInteger(value.lastUpdatedChapter) && value.lastUpdatedChapter >= 0
}

function hasCognitionFacts(state: CognitionState): boolean {
  return state.readerKnows.length > 0
    || state.characters.some((character) => character.knows.length > 0 || character.doesNotKnow.length > 0)
}

function isEmotionalArcStore(value: unknown): value is EmotionalArcStore {
  return value !== null && typeof value === "object"
    && "lastUpdated" in value && typeof value.lastUpdated === "string"
    && "beats" in value && Array.isArray(value.beats)
    && value.beats.every((beat: unknown) => beat !== null && typeof beat === "object"
      && "character" in beat && typeof beat.character === "string"
      && "chapterNumber" in beat && typeof beat.chapterNumber === "number"
      && "emotion" in beat && typeof beat.emotion === "string"
      && "intensity" in beat && typeof beat.intensity === "number"
      && "trigger" in beat && typeof beat.trigger === "string"
      && "notes" in beat && typeof beat.notes === "string")
}

function isResourceLedgerStore(value: unknown): value is ResourceLedgerStore {
  return value !== null && typeof value === "object"
    && "lastUpdated" in value && typeof value.lastUpdated === "string"
    && "entries" in value && Array.isArray(value.entries)
    && value.entries.every((entry: unknown) => entry !== null && typeof entry === "object"
      && "item" in entry && typeof entry.item === "string"
      && "currentHolder" in entry && typeof entry.currentHolder === "string"
      && "acquiredChapter" in entry && typeof entry.acquiredChapter === "number"
      && "transferHistory" in entry && Array.isArray(entry.transferHistory)
      && entry.transferHistory.every((transfer: unknown) => transfer !== null && typeof transfer === "object"
        && "fromChapter" in transfer && typeof transfer.fromChapter === "number"
        && "fromHolder" in transfer && typeof transfer.fromHolder === "string"
        && "toHolder" in transfer && typeof transfer.toHolder === "string"))
}

/** 无快照时仅使用带获得章号、连续且与尾部持有者一致的既有转手链。 */
function resourceEntryBeforeChapter(entry: ResourceEntry, beforeChapter: number): ResourceEntry | null {
  const history = entry.transferHistory
  if (history.length === 0) return null
  for (let index = 0; index < history.length; index += 1) {
    const transfer = history[index]
    if (!Number.isInteger(transfer.fromChapter) || transfer.fromChapter < entry.acquiredChapter) return null
    if (index > 0) {
      const previous = history[index - 1]
      if (transfer.fromChapter < previous.fromChapter || transfer.fromHolder !== previous.toHolder) return null
    }
  }
  if (history[history.length - 1].toHolder !== entry.currentHolder) return null
  const retained = history.filter((transfer) => isBeforeChapter(transfer.fromChapter, beforeChapter))
  // 首次获得也在未来时，空 fromHolder 不构成章前无主的证据。
  if (retained.length === 0 && !history[0].fromHolder) return null
  return {
    ...entry,
    currentHolder: retained.length > 0 ? retained[retained.length - 1].toHolder : history[0].fromHolder,
    transferHistory: retained,
  }
}

/** 按章前快照纯重放认知；最新聚合与无时点 seed 不作为历史回填。 */
export async function readCognitionStatesText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "cognitionText")) return ""
  try {
    const state = await loadCognitionState(pp)
    const beforeChapter = options?.beforeChapter
    if (beforeChapter === undefined) return state ? cognitionToContextText(state) : ""
    // live 的更新章可以晚于目标章；仅校验核心形状，不把正常晚章聚合判坏。
    if (state !== null && !isCognitionState(state)) throw new Error("Invalid cognition live state")
    const { snapshots, view } = await foldBeforeChapter(pp, "cognition", beforeChapter)
    if (view === undefined) {
      recordUnavailable(options, "cognitionText")
      return ""
    }
    if (!isCognitionState(view) || view.lastUpdatedChapter >= beforeChapter) throw new Error("Invalid cognition fold result")
    if (snapshots.length < beforeChapter - 1 || (!hasCognitionFacts(view) && state !== null && hasCognitionFacts(state))) {
      recordUnavailable(options, "cognitionText")
    }
    return cognitionToContextText(view)
  } catch {
    options?.recordGap?.("cognitionText", "datasource_error")
  }
  return ""
}

/**
 * R4 (S4 / ANL-013): load the emotional-arcs projection store and render its
 * protected-tier context text. Returns "" when the store is empty or absent
 * (backward compatible — no arcs recorded = no injection). Failures are
 * swallowed (non-fatal) to match the readCognitionStates contract; the
 * projection's own commit/fail status is tracked by the
 * ProjectionStatusLedger, not here.
 */
export async function readEmotionalArcsText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "emotionalArcs")) return ""
  try {
    const store = await loadEmotionalArcs(pp)
    const beforeChapter = options?.beforeChapter
    if (beforeChapter !== undefined) {
      const { snapshots, view } = await foldBeforeChapter(pp, "emotional_arc", beforeChapter)
      if (view !== undefined && !isEmotionalArcStore(view)) throw new Error("Invalid emotional_arc fold result")
      const beats = store.beats.filter((beat) => isBeforeChapter(beat.chapterNumber, beforeChapter))
      const temporalStore = isEmotionalArcStore(view) && view.beats.length > 0
        ? view
        : { ...store, beats }
      const names = new Set(temporalStore.beats.map((beat) => beat.character))
      if (view === undefined || snapshots.length < beforeChapter - 1 || temporalStore.beats.length === 0
        || (isEmotionalArcStore(view) && view.beats.length === 0 && beats.length > 0)
        || store.beats.some((beat) => !Number.isInteger(beat.chapterNumber) || beat.chapterNumber <= 0 || !names.has(beat.character))) {
        recordUnavailable(options, "emotionalArcs")
      }
      return emotionalArcsToContextText(temporalStore)
    }
    return emotionalArcsToContextText(store)
  } catch {
    if (options?.beforeChapter !== undefined) options.recordGap?.("emotionalArcs", "datasource_error")
    logger.warn("context-derived-stores", "silent-degrade: 降级返回空值（吞错已标记）", { line: 35 })
  }
  return ""
}

/**
 * MAINT-002 (TASK-008): read subplot-board store and render as protected-tier
 * context text. Returns "" when the store is empty/absent (backward
 * compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
export async function readSubplotBoardText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "subplotBoard")) return ""
  try {
    const store = await loadSubplotBoard(pp)
    if (options?.beforeChapter !== undefined) {
      // 当前聚合没有字段前态；startChapter 与字符串 progress 均不能认证历史版本。
      recordUnavailable(options, "subplotBoard")
      return ""
    }
    return subplotBoardToContextText(store)
  } catch {
    if (options?.beforeChapter !== undefined) options.recordGap?.("subplotBoard", "datasource_error")
    logger.warn("context-derived-stores", "silent-degrade: 降级返回空值（吞错已标记）", { line: 49 })
  }
  return ""
}

/**
 * MAINT-002 (TASK-008): read resource-ledger store and render as
 * protected-tier context text. Returns "" when the store is empty/absent
 * (backward compatible). Failures swallowed (non-fatal) — same contract as
 * readEmotionalArcsText.
 */
export async function readResourceLedgerText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "resourceLedger")) return ""
  try {
    const store = await loadResourceLedger(pp)
    const beforeChapter = options?.beforeChapter
    if (beforeChapter !== undefined) {
      const { snapshots, view } = await foldBeforeChapter(pp, "resource_ledger", beforeChapter)
      if (view !== undefined && !isResourceLedgerStore(view)) throw new Error("Invalid resource_ledger fold result")
      let unavailable = view === undefined || snapshots.length < beforeChapter - 1
        || store.entries.some((entry) => !Number.isInteger(entry.acquiredChapter) || entry.acquiredChapter <= 0)
      let temporalStore: ResourceLedgerStore
      if (isResourceLedgerStore(view) && view.entries.length > 0) {
        const latestHolders = new Map<string, string>()
        for (const snapshot of snapshots) {
          for (const [item, detail] of Object.entries(snapshot.itemDetails ?? {})) {
            if (typeof detail?.holder === "string") latestHolders.set(item, detail.holder.trim())
          }
        }
        const entries = view.entries.filter((entry) => {
          // 既有 fold 不处理空 holder 清除；不能继续把旧持有者或猜出的无主态注入。
          if (!entry.currentHolder || latestHolders.get(entry.item) === "") {
            unavailable = true
            return false
          }
          return true
        })
        const items = new Set(entries.map((entry) => entry.item))
        if (store.entries.some((entry) => isBeforeChapter(entry.acquiredChapter, beforeChapter) && !items.has(entry.item))) {
          unavailable = true
        }
        temporalStore = { ...view, entries }
      } else {
        // 不能仅过滤 history 后沿用 currentHolder；先认证链再恢复章前持有者。
        const entries: ResourceEntry[] = []
        for (const entry of store.entries) {
          if (!isBeforeChapter(entry.acquiredChapter, beforeChapter)) continue
          const temporalEntry = resourceEntryBeforeChapter(entry, beforeChapter)
          if (temporalEntry) entries.push(temporalEntry)
          else unavailable = true
        }
        temporalStore = { ...store, entries }
        unavailable = true
      }
      if (unavailable || temporalStore.entries.length === 0) recordUnavailable(options, "resourceLedger")
      return resourceLedgerToContextText(temporalStore)
    }
    return resourceLedgerToContextText(store)
  } catch {
    if (options?.beforeChapter !== undefined) options.recordGap?.("resourceLedger", "datasource_error")
    logger.warn("context-derived-stores", "silent-degrade: 降级返回空值（吞错已标记）", { line: 63 })
  }
  return ""
}

/**
 * A19 emotion-ledger pilot: read emotion-ledger store and render as
 * protected-tier context text (top-N emotional-debt characters). Returns ""
 * when the store is empty/absent (backward compatible). Failures swallowed
 * (non-fatal) — same contract as readEmotionalArcsText. 机械层零 LLM: netValue
 * 与 history delta 由确定性算术产出，LLM 只读文本化结果作生成约束不参与推断。
 */
export async function readEmotionLedgerText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "emotionLedger")) return ""
  try {
    const store = await loadEmotionLedger(pp)
    const beforeChapter = options?.beforeChapter
    if (beforeChapter !== undefined) {
      // 标量 delta 丢失轴分量与 clamp 前值，只能使用时点可信的完整 entry。
      const entries = store.entries.filter((entry) =>
        isBeforeChapter(entry.lastUpdatedChapter, beforeChapter)
        && entry.history.every((event) => isBeforeChapter(event.chapter, beforeChapter) && event.chapter <= entry.lastUpdatedChapter),
      )
      if (entries.length === 0 || entries.length < store.entries.length) recordUnavailable(options, "emotionLedger")
      return emotionLedgerToContextText({ ...store, entries })
    }
    return emotionLedgerToContextText(store)
  } catch {
    if (options?.beforeChapter !== undefined) options.recordGap?.("emotionLedger", "datasource_error")
    logger.warn("context-derived-stores", "silent-degrade: 降级返回空值（吞错已标记）", { line: 78 })
  }
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
export async function readAuraEvolutionText(pp: string, options?: ContextProjectionReadOptions): Promise<string> {
  if (invalidBeforeChapter(options, "auraEvolution")) return ""
  try {
    const store = await loadAuraEvolution(pp)
    const beforeChapter = options?.beforeChapter
    const temporalStore = beforeChapter === undefined ? store : {
      ...store,
      entries: Object.fromEntries(Object.entries(store.entries)
        .map(([name, history]) => [name, history.filter((entry) => isBeforeChapter(entry.chapter, beforeChapter))] as const)),
    }
    const names = Object.keys(temporalStore.entries)
    if (beforeChapter !== undefined && (names.length === 0 || names.some((name) =>
      temporalStore.entries[name].length === 0
      || store.entries[name].some((entry) => !Number.isInteger(entry.chapter) || entry.chapter <= 0),
    ))) recordUnavailable(options, "auraEvolution")
    if (names.length === 0) return ""
    return names
      .map((n) => auraEvolutionToContextText(temporalStore, n, beforeChapter ?? 0))
      .filter((t) => t.length > 0)
      .join("\n")
  } catch {
    if (options?.beforeChapter !== undefined) options.recordGap?.("auraEvolution", "datasource_error")
    logger.warn("context-derived-stores", "silent-degrade: 降级返回空值（吞错已标记）", { line: 99 })
  }
  return ""
}
