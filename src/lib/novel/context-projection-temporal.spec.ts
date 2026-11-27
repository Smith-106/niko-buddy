import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  readEmotionalArcsText,
  readSubplotBoardText,
  readResourceLedgerText,
  readEmotionLedgerText,
  readAuraEvolutionText,
} from "./context-derived-stores"
import { buildContextPack, loadProjectionTexts, resolveCharacterStates, type BuildContextOptions } from "./context-engine"
import { fallbackCharacterStatesDataSource } from "./context-data-sources"
import {
  collectContextGaps,
  getContextGapsActive,
  recordDatasourceLoadFailure,
  resetContextGaps,
} from "./context-engine-gaps"
import { PROJECTION_REGISTRY } from "./projection-status-ledger"
import * as historyModule from "./chapter-ingest-history"
import { applyEmotionDelta } from "./emotion-ledger"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import { createEmptyRevisionFeedback, DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG } from "./revision-feedback"
import type { ChapterSnapshot, ItemDetail } from "./chapter-ingest"
import type { CharacterState, EmotionLedgerEntry } from "./character-state"
import type { EmotionalArcBeat } from "./emotional-arcs"
import type { ResourceEntry, ResourceTransfer } from "./resource-ledger"
import type { ContextLoadContext } from "./context-data-source"

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  const rawData: Record<string, unknown> = {}
  const unexpectedWrite = async () => { throw new Error("Unexpected persistence during temporal read") }
  return {
    files,
    rawData,
    includeCognitionDataSource: false,
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    listDirectory: vi.fn(async (path: string) => [...files.keys()]
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => ({ name: file.slice(path.length + 1), path: file, is_dir: false }))),
    writeFile: vi.fn(unexpectedWrite),
    writeFileAtomic: vi.fn(unexpectedWrite),
    writeFilesAtomic: vi.fn(unexpectedWrite),
    createDirectory: vi.fn(unexpectedWrite),
    deleteFile: vi.fn(unexpectedWrite),
    renameFile: vi.fn(unexpectedWrite),
    searchWiki: vi.fn(async () => []),
    sampleTruthFoldDrift: vi.fn(async () => null),
    buildCharacterAuraContext: vi.fn(async () => ""),
    writingApi: vi.fn(async () => { throw new Error("Unexpected LLM request during temporal read") }),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
  fileExists: vi.fn(async () => false),
  getFileModifiedTime: vi.fn(async () => 0),
  writeFile: mocks.writeFile,
  writeFileAtomic: mocks.writeFileAtomic,
  writeFilesAtomic: mocks.writeFilesAtomic,
  createDirectory: mocks.createDirectory,
  deleteFile: mocks.deleteFile,
  renameFile: mocks.renameFile,
}))
vi.mock("@/lib/search", () => ({ searchWiki: mocks.searchWiki }))
vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.writingApi }))
vi.mock("./chapter-ingest", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chapter-ingest")>(),
  sampleTruthFoldDrift: mocks.sampleTruthFoldDrift,
}))
vi.mock("./character-aura", async (importOriginal) => ({
  ...await importOriginal<typeof import("./character-aura")>(),
  buildCharacterAuraContext: mocks.buildCharacterAuraContext,
}))
vi.mock("./context-engine-technique-sources", () => ({
  loadCanonSourceFacts: vi.fn(async () => ({ current: null, former: [] })),
  loadTechniqueBlocks: vi.fn(async () => ""),
}))
vi.mock("./community-summary", () => ({
  loadPersistedCommunitySummaries: vi.fn(async () => null),
  searchCommunitySummaries: vi.fn(async () => []),
}))
vi.mock("./context-data-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-data-sources")>()
  return {
    ...actual,
    // 原装配和人物 fallback 保持真实；其它来源只提供此测试的明确计划与摘要。
    getAllDataSources: () => [
      ...Object.keys(mocks.rawData).map((name) => ({ name, priority: 1, load: async () => mocks.rawData[name] })),
      actual.fallbackCharacterStatesDataSource,
      ...(mocks.includeCognitionDataSource ? [actual.cognitionTextDataSource] : []),
    ],
  }
})

const PROJECT = "/temporal-context"
const readers = [readEmotionalArcsText, readSubplotBoardText, readResourceLedgerText, readEmotionLedgerText, readAuraEvolutionText]

function putStore(file: string, value: unknown): void {
  mocks.files.set(`${PROJECT}/.novel/${file}.json`, JSON.stringify(value))
}

function item(holder: string): ItemDetail {
  return { holder, previousHolders: "", abilities: "", limitations: "", origin: "" }
}

function snapshot(chapterNumber: number, holder?: string): ChapterSnapshot {
  return {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    sourceType: "chapter",
    sourceSequence: chapterNumber,
    revision: 1,
    isHistorical: false,
    summary: `summary-${chapterNumber}`,
    characters: ["Lin"],
    locations: [], organizations: [], items: [], events: [],
    characterStateChanges: [], relationshipChanges: [], knowledgeChanges: [],
    foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [], conflicts: [],
    endingHook: "", graphNodes: [], graphEdges: [],
    characterDetails: { Lin: { identity: "", faction: "", goals: "", arcChange: `arc-${chapterNumber}` } },
    itemDetails: holder === undefined ? {} : { Sword: item(holder) },
  }
}

function installHistory(snapshots: ChapterSnapshot[]): void {
  for (const path of mocks.files.keys()) {
    if (path.includes("/.novel/snapshots/") || path.includes("/wiki/chapters/")) mocks.files.delete(path)
  }
  for (const value of snapshots) {
    const prefix = String(value.chapterNumber).padStart(3, "0")
    mocks.files.set(`${PROJECT}/.novel/snapshots/${prefix}.snapshot.json`, JSON.stringify(value))
    mocks.files.set(`${PROJECT}/wiki/chapters/${prefix}.md`, `---\ntype: chapter\nchapter_number: ${value.chapterNumber}\n---\n正文`)
  }
}

function beat(chapterNumber: number, emotion: string): EmotionalArcBeat {
  return { character: "Lin", chapterNumber, emotion, intensity: 0.5, trigger: "", notes: "" }
}

function character(characterName: string, lastUpdatedChapter: number, currentLocation = "OldRoom"): CharacterState {
  return { characterName, currentLocation, status: "安好", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter, lastUpdatedAt: "" }
}

function emotion(characterName: string, lastUpdatedChapter: number, netValue = -0.1): EmotionLedgerEntry {
  return { characterName, lastUpdatedChapter, netValue, valence: 0, arousal: 0, dominance: 0, history: [] }
}

function resource(transferHistory: ResourceTransfer[], acquiredChapter = 2): ResourceEntry {
  return { item: "Sword", acquiredChapter, currentHolder: transferHistory[transferHistory.length - 1]?.toHolder ?? "Unproven", transferHistory }
}

function loadContext(chapterNumber?: number, recordGap: NonNullable<ContextLoadContext["recordGap"]> = vi.fn()): ContextLoadContext {
  return {
    projectPath: PROJECT, task: "继续写作", chapterNumber, recordGap,
    config: { recentSummaryWindow: 3, searchTopK: 5, snapshotLookback: 3, revisionFeedbackWindowConfig: DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG },
  }
}

function buildOptions(): BuildContextOptions {
  return {
    novelConfig: {
      ...DEFAULT_NOVEL_CONFIG,
      exemplarEnabled: false, conditionalRoutingEnabled: false, relatedChaptersEnabled: false,
      referenceEnabled: false, hardInjectEnabled: false, temporalFactsEnabled: false,
    },
    llmConfig: { provider: "openai", apiKey: "", model: "test-only", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 },
    revisionFeedbackWindowConfig: DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
    telemetrySink: vi.fn(async () => undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetContextGaps()
  collectContextGaps()
  mocks.files.clear()
  mocks.includeCognitionDataSource = false
  for (const key of Object.keys(mocks.rawData)) delete mocks.rawData[key]
  mocks.rawData.outline = "明确静态设定：Lin 是医师；明确未来计划：第20章回收支线。"
  mocks.rawData.chapterOutline = "第1章：进入旧屋\n第10章：核对账本"
  mocks.rawData.snapshots = { recentSummaries: ["已发生摘要"], previousChapterEnding: "他推开门。", characterStates: "" }
  mocks.rawData.revisionFeedback = createEmptyRevisionFeedback()
  putStore("emotional-arcs", { beats: [beat(162, "future-arc")], lastUpdated: "" })
  putStore("resource-ledger", { entries: [resource([
    { fromChapter: 2, fromHolder: "", toHolder: "A" },
    { fromChapter: 5, fromHolder: "A", toHolder: "B" },
    { fromChapter: 10, fromHolder: "B", toHolder: "C" },
    { fromChapter: 160, fromHolder: "C", toHolder: "D" },
    { fromChapter: 162, fromHolder: "D", toHolder: "FutureHolder" },
  ])], lastUpdated: "" })
  putStore("subplot-board", { items: [{
    id: "s", title: "SeededThread", status: "resolved", startChapter: 2, resolvedChapter: 20,
    targetResolutionChapter: 20, relatedCharacters: ["Lin"], summary: "未来完成态",
    progress: ["第2章开始", "第20章回收"], notes: "未来笔记",
  }], lastUpdated: "" })
  putStore("emotion-ledger", { entries: [emotion("PastDebt", 1), emotion("FutureDebt", 162, -9), emotion("UnknownDebt", 0, -10)], lastUpdated: "" })
  putStore("aura-evolution", { entries: { Lin: [1, 10, 162].map((chapter) => ({ chapter, snapshot: {}, fieldDeltas: [`change-${chapter}`], weight: 1 })) }, lastUpdated: "" })
  putStore("character-states", { characters: [character("PastCharacter", 1), character("FutureCharacter", 162, "FutureRoom")], lastUpdated: "" })
  installHistory([])
})

afterEach(() => {
  for (const writer of [mocks.writeFile, mocks.writeFileAtomic, mocks.writeFilesAtomic, mocks.createDirectory, mocks.deleteFile, mocks.renameFile]) {
    expect(writer).not.toHaveBeenCalled()
  }
  expect(mocks.writingApi).not.toHaveBeenCalled()
  collectContextGaps()
  vi.restoreAllMocks()
})

describe("严格章前边界与真实纯 fold", () => {
  it.each([1, 2, 80, 162])("N=%i：先选 chapter<N，再调用既有 fold 与 renderer", async (beforeChapter) => {
    const snapshots = Array.from({ length: 163 }, (_, index) => {
      const n = index + 1
      return snapshot(n, n < 2 ? undefined : n < 5 ? "A" : n < 10 ? "B" : n < 160 ? "C" : n < 162 ? "D" : "FutureHolder")
    })
    installHistory(snapshots)
    putStore("aura-evolution", { entries: { Lin: [beforeChapter - 1, beforeChapter, beforeChapter + 1].map((chapter) => ({ chapter, snapshot: {}, fieldDeltas: [`boundary-${chapter}`], weight: 1 })) }, lastUpdated: "" })
    const fold = vi.spyOn(PROJECTION_REGISTRY.emotional_arc, "foldFromSnapshot")
    const filesBefore = [...mocks.files]
    const gaps = vi.fn()
    const texts = await loadProjectionTexts(PROJECT, { beforeChapter, recordGap: gaps })
    expect(texts.emotionalText).not.toContain(`：arc-${beforeChapter}（`)
    expect(texts.emotionalText).not.toContain(`：arc-${beforeChapter + 1}（`)
    expect(texts.resourceText).not.toContain("FutureHolder")
    expect(texts.auraEvolutionText).not.toContain(`第${beforeChapter}章画像变化`)
    expect(texts.auraEvolutionText).not.toContain(`boundary-${beforeChapter + 1}`)
    if (beforeChapter === 1) {
      expect(texts.emotionalText).toBe("")
      expect(texts.resourceText).toBe("")
      expect(gaps).toHaveBeenCalledWith("emotionalArcs", "temporal_history_unavailable")
    } else {
      expect(texts.emotionalText).toContain(`：arc-${beforeChapter - 1}（`)
      expect(texts.auraEvolutionText).toContain(`boundary-${beforeChapter - 1}`)
    }
    expect(fold).toHaveBeenCalledWith(expect.any(Array), { now: "" })
    expect(fold.mock.calls[0][0].every((value) => value.chapterNumber > 0 && value.chapterNumber < beforeChapter)).toBe(true)
    expect([...mocks.files]).toEqual(filesBefore)
  })

  it("fold 使用新 accumulator，不改快照、不调用注册表 load/save hook", async () => {
    const values = [snapshot(1), snapshot(2, "A"), snapshot(5, "B"), snapshot(10, "C")]
    const original = structuredClone(values)
    for (const value of values) Object.freeze(value)
    vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue(values)
    const hooks = ["character", "emotional_arc", "resource_ledger", "subplot_board"].flatMap((id) => [
      vi.spyOn(PROJECTION_REGISTRY[id], "load"), vi.spyOn(PROJECTION_REGISTRY[id], "save"),
    ])
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 10 })).toContain("持有者 B")
    expect(await readEmotionalArcsText(PROJECT, { beforeChapter: 10 })).toContain("arc-5")
    expect(values).toEqual(original)
    for (const hook of hooks) expect(hook).not.toHaveBeenCalled()
  })

  it("未知或 0 章号的 snapshot 不进入 fold，也不成为静态基线", async () => {
    vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue([snapshot(0), snapshot(2)])
    const fold = vi.spyOn(PROJECTION_REGISTRY.emotional_arc, "foldFromSnapshot")
    const gap = vi.fn()
    expect(await readEmotionalArcsText(PROJECT, { beforeChapter: 2, recordGap: gap })).toBe("")
    expect(fold).toHaveBeenCalledWith([], { now: "" })
    expect(gap).toHaveBeenCalledWith("emotionalArcs", "temporal_history_unavailable")
  })

  it("与已核验结构相同的非冒号变化不能播种角色，支线空 fold 不能代表没有支线", async () => {
    const value = snapshot(1, "A")
    value.characterStateChanges = ["Lin 进入旧屋", "Lin 换上外衣", "Lin 平复情绪"]
    const original = structuredClone(value)
    const characterView = PROJECTION_REGISTRY.character.foldFromSnapshot?.([value], { now: "" })
    const subplotView = PROJECTION_REGISTRY.subplot_board.foldFromSnapshot?.([value], { now: "" })
    expect(characterView).toMatchObject({ characters: [] })
    expect(subplotView).toMatchObject({ items: [] })
    const gap = vi.fn()
    expect(await readSubplotBoardText(PROJECT, { beforeChapter: 2, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("subplotBoard", "temporal_history_unavailable")
    expect(value).toEqual(original)
  })
})

describe("保留历史不足时的事件视图", () => {
  it("emotional：乱序与同章最后一条选择保持原 renderer，未来及未知章号排除", async () => {
    putStore("emotional-arcs", { beats: [beat(10, "future"), beat(1, "first"), beat(0, "unknown"), beat(1, "last")], lastUpdated: "" })
    const gap = vi.fn()
    expect(await readEmotionalArcsText(PROJECT, { beforeChapter: 2, recordGap: gap })).toBe("- Lin：last（强度0.50）")
    expect(gap).toHaveBeenCalledWith("emotionalArcs", "temporal_history_unavailable")
  })

  it("emotional：仅有后章或缺失 chapter 的 beats 不能回填章前情绪", async () => {
    putStore("emotional-arcs", { beats: [beat(20, "truncated-history"), { character: "Unknown", emotion: "unknown", intensity: 0, trigger: "", notes: "" }], lastUpdated: "" })
    const gap = vi.fn()
    expect(await readEmotionalArcsText(PROJECT, { beforeChapter: 10, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("emotionalArcs", "temporal_history_unavailable")
  })

  it.each([[2, ""], [5, "- Sword：持有者 A（第2章获得）"], [10, "- Sword：持有者 B（第5章转手）"], [11, "- Sword：持有者 C（第10章转手）"]])("resource：N=%i 恢复章前持有者", async (beforeChapter, expected) => {
    putStore("resource-ledger", { entries: [resource([
      { fromChapter: 5, fromHolder: "A", toHolder: "B" },
      { fromChapter: 10, fromHolder: "B", toHolder: "C" },
    ])], lastUpdated: "" })
    const gap = vi.fn()
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: Number(beforeChapter), recordGap: gap })).toBe(expected)
    expect(gap).toHaveBeenCalledWith("resourceLedger", "temporal_history_unavailable")
  })

  it("resource：显式转无主事件可以读取，不能把被裁剪的未来空 holder 当作无主", async () => {
    putStore("resource-ledger", { entries: [resource([
      { fromChapter: 5, fromHolder: "A", toHolder: "B" },
      { fromChapter: 10, fromHolder: "B", toHolder: "" },
    ])], lastUpdated: "" })
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 10 })).toBe("- Sword：持有者 B（第5章转手）")
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 11 })).toBe("- Sword：无主")
  })

  it.each([
    resource([{ fromChapter: 5, fromHolder: "A", toHolder: "B" }, { fromChapter: 10, fromHolder: "X", toHolder: "C" }]),
    resource([]),
    resource([{ fromChapter: 5, fromHolder: "", toHolder: "B" }]),
    resource([{ fromChapter: 0, fromHolder: "A", toHolder: "B" }]),
    resource([{ fromChapter: 5, fromHolder: "A", toHolder: "B" }], 0),
    resource([{ fromChapter: 10, fromHolder: "A", toHolder: "B" }, { fromChapter: 5, fromHolder: "B", toHolder: "C" }]),
  ])("resource：断链、缺 baseline 或未知章号返回空并报告不足 %#", async (entry) => {
    putStore("resource-ledger", { entries: [entry], lastUpdated: "" })
    const gap = vi.fn()
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 5, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("resourceLedger", "temporal_history_unavailable")
  })

  it("resource：既有 fold 无法清除空 holder 时，不继续注入先前持有者", async () => {
    installHistory([snapshot(2, "A"), snapshot(5, "")])
    const gap = vi.fn()
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 6, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("resourceLedger", "temporal_history_unavailable")
  })

  it("aura：先过滤章前记录，再使用既有 10 条窗口和以 N 计算的衰减", async () => {
    putStore("aura-evolution", { entries: { Lin: Array.from({ length: 25 }, (_, index) => ({ chapter: index + 1, snapshot: {}, fieldDeltas: [`delta-${index + 1}`], weight: 1 })) }, lastUpdated: "" })
    const text = await readAuraEvolutionText(PROJECT, { beforeChapter: 13 })
    expect(text.match(/画像变化/g)).toHaveLength(10)
    expect(text).toContain("第3章画像变化 (权重37%)")
    expect(text).toContain("第12章画像变化 (权重90%)")
    expect(text).not.toContain("第2章画像变化")
    expect(text).not.toContain("第13章画像变化")
    expect([...text.matchAll(/权重(\d+)%/g)].every((match) => Number(match[1]) <= 100)).toBe(true)
  })

  it("aura：未知与 0 章号不会被视为静态基线", async () => {
    putStore("aura-evolution", { entries: { Lin: [
      { chapter: 0, snapshot: {}, fieldDeltas: ["zero"], weight: 1 },
      { snapshot: {}, fieldDeltas: ["unknown"], weight: 1 },
      { chapter: 10, snapshot: {}, fieldDeltas: ["future"], weight: 1 },
    ] }, lastUpdated: "" })
    const gap = vi.fn()
    expect(await readAuraEvolutionText(PROJECT, { beforeChapter: 10, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("auraEvolution", "temporal_history_unavailable")
  })
})

describe("不可逆聚合与人物 fallback", () => {
  it("emotion：相同 scalar delta 可以来自不同三轴序列，不能从未来三轴逆算", async () => {
    const start = emotion("Ambiguous", 1)
    const first = applyEmotionDelta(start, { valence: 1, reason: "same" }, 10)
    const second = applyEmotionDelta(start, { arousal: 1, reason: "same" }, 10)
    expect(first.history).toEqual(second.history)
    expect(first.valence).not.toBe(second.valence)
    expect(first.netValue).not.toBe(second.netValue)
    for (const entry of [first, second]) {
      putStore("emotion-ledger", { entries: [entry], lastUpdated: "" })
      const gap = vi.fn()
      expect(await readEmotionLedgerText(PROJECT, { beforeChapter: 10, recordGap: gap })).toBe("")
      expect(gap).toHaveBeenCalledWith("emotionLedger", "temporal_history_unavailable")
    }
  })

  it("emotion：先过滤完整可信 entry，再选 top5；未来 history 不借旧 updatedChapter 绕过", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => emotion(`Old-${index}`, 1, -index))
    const inconsistent = { ...emotion("Inconsistent", 1, -20), history: [{ chapter: 10, delta: -20, reason: "future" }] }
    putStore("emotion-ledger", { entries: [emotion("Future", 10, -99), emotion("Zero", 0, -99), inconsistent, ...entries], lastUpdated: "" })
    const gap = vi.fn()
    const text = await readEmotionLedgerText(PROJECT, { beforeChapter: 10, recordGap: gap })
    expect(text.split("\n")).toHaveLength(5)
    expect(text).toContain("Old-5")
    expect(text).not.toContain("Old-0")
    expect(text).not.toMatch(/Future|Zero|Inconsistent/)
    expect(gap).toHaveBeenCalledWith("emotionLedger", "temporal_history_unavailable")
  })

  it.each([2, 10, 21])("subplot：N=%i 不从 startChapter 或 progress 字符串猜旧状态", async (beforeChapter) => {
    const gap = vi.fn()
    expect(await readSubplotBoardText(PROJECT, { beforeChapter, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("subplotBoard", "temporal_history_unavailable")
  })

  it("人物：先过滤再格式化/3000 截断，未来长正文不会挤掉可信历史", async () => {
    const known = character("Known", 9)
    putStore("character-states", { characters: [character("Future", 10, "F".repeat(4000)), character("Zero", 0), { ...known, characterName: "Unknown", lastUpdatedChapter: undefined }, known], lastUpdated: "" })
    const gap = vi.fn()
    const text = await fallbackCharacterStatesDataSource.load(loadContext(10, gap))
    expect(text).toBe("- Known：位于OldRoom，状态：安好，装备：无，能力：无")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(gap).toHaveBeenCalledWith("fallbackCharacterStates", "temporal_history_unavailable")
  })

  it("人物：过滤为空时不回落未来 wiki；明确静态设定和未来计划保留在原计划来源", async () => {
    putStore("character-states", { characters: [character("Future", 20)], lastUpdated: "" })
    const gap = vi.fn()
    expect(await fallbackCharacterStatesDataSource.load(loadContext(10, gap))).toBe("")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    const pack = await buildContextPack(PROJECT, "写第10章", 10, buildOptions())
    expect(pack.outline).toContain("明确静态设定")
    expect(pack.outline).toContain("明确未来计划")
    expect(pack.characterStates).not.toContain("Future")
    expect(pack.gaps).toContainEqual({ type: "unavailable", ref: "fallbackCharacterStates", reason: "temporal_history_unavailable", originalLength: 0, retainedLength: 0 })
  })
})

describe("无章号 golden 与 gap 生命周期", () => {
  it("五个 reader 的无章号字节输出和原合并顺序不变", async () => {
    putStore("emotional-arcs", { beats: [beat(10, "最新情绪")], lastUpdated: "" })
    putStore("resource-ledger", { entries: [resource([{ fromChapter: 10, fromHolder: "B", toHolder: "C" }])], lastUpdated: "" })
    putStore("subplot-board", { items: [{ id: "s", title: "支线", status: "active", startChapter: 2, relatedCharacters: ["Lin"], summary: "最新摘要", progress: ["最新进展"], notes: "" }], lastUpdated: "" })
    putStore("emotion-ledger", { entries: [{ ...emotion("Debt", 10, -0.7), valence: -0.5, arousal: 0.3, dominance: -0.2 }], lastUpdated: "" })
    putStore("aura-evolution", { entries: { Lin: [1, 2].map((chapter) => ({ chapter, snapshot: {}, fieldDeltas: [`field-${chapter}`], weight: 1 })) }, lastUpdated: "" })
    const texts = await loadProjectionTexts(PROJECT)
    expect(texts).toEqual({
      emotionalText: "- Lin：最新情绪（强度0.50）",
      resourceText: "- Sword：持有者 C（第10章转手）",
      subplotText: "- [进行中] 支线（关联：Lin）：最新摘要；进度：最新进展",
      emotionLedgerText: "- Debt：情绪净值 -0.70，长期承压状态；效价 -0.50，唤醒 0.30，支配 -0.20",
      auraEvolutionText: "Lin 画像漂移历史:\n- 第1章画像变化 (权重111%): field-1\n- 第2章画像变化 (权重122%): field-2",
    })
    expect(resolveCharacterStates({ fallbackCharacterStates: "fallback" }, { characterStates: "snapshot" }, texts))
      .toBe(["snapshot", "fallback", texts.emotionalText, texts.emotionLedgerText, texts.auraEvolutionText, texts.subplotText, texts.resourceText].join("\n\n"))
  })

  it("无章号人物保持 structured → wiki 与 3000 截断", async () => {
    const row = character("Latest", 162, "X".repeat(4000))
    putStore("character-states", { characters: [row], lastUpdated: "" })
    expect(await fallbackCharacterStatesDataSource.load(loadContext())).toBe(`- Latest：位于${row.currentLocation}，状态：安好，装备：无，能力：无`.slice(0, 3000))
    putStore("character-states", { characters: [], lastUpdated: "" })
    mocks.files.set(`${PROJECT}/wiki/entities/Mixed.md`, "混合最新 wiki 正文")
    const search = vi.spyOn(await import("@/lib/search"), "searchWiki")
      .mockResolvedValue([{ path: `${PROJECT}/wiki/entities/Mixed.md`, title: "Mixed", snippet: "", titleMatch: false, score: 1, images: [] }])
    expect(await fallbackCharacterStatesDataSource.load(loadContext())).toBe("混合最新 wiki 正文")
    expect(search).toHaveBeenCalledWith(PROJECT, "type:entity character")
  })

  it("无章号缺失/空 store 保持空值语义，有章号空视图均明确 unavailable", async () => {
    mocks.files.clear()
    const gap = vi.fn()
    for (const reader of readers) {
      expect(await reader(PROJECT, { recordGap: gap })).toBe("")
    }
    expect(gap).not.toHaveBeenCalled()
    for (const reader of readers) expect(await reader(PROJECT, { beforeChapter: 2, recordGap: gap })).toBe("")
    expect(gap.mock.calls.every(([, reason]) => reason === "temporal_history_unavailable")).toBe(true)
    expect(gap).toHaveBeenCalledTimes(5)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("非法目标章 %s 不退回最新状态", async (beforeChapter) => {
    const gap = vi.fn()
    for (const reader of readers) expect(await reader(PROJECT, { beforeChapter, recordGap: gap })).toBe("")
    expect(await fallbackCharacterStatesDataSource.load(loadContext(beforeChapter, gap))).toBe("")
    expect(gap).toHaveBeenCalledTimes(6)
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("真实 store 加载异常保持 datasource_error，不伪装成历史不足", async () => {
    for (const file of ["emotional-arcs", "subplot-board", "resource-ledger", "emotion-ledger", "aura-evolution", "character-states"]) putStore(file, { fileVersion: 2 })
    resetContextGaps()
    for (const reader of readers) expect(await reader(PROJECT, { beforeChapter: 10, recordGap: recordDatasourceLoadFailure })).toBe("")
    expect(await fallbackCharacterStatesDataSource.load(loadContext(10, recordDatasourceLoadFailure))).toBe("")
    const gaps = collectContextGaps()
    expect(gaps).toHaveLength(6)
    expect(gaps.every((gap) => gap.type === "load_failed" && gap.reason === "datasource_error")).toBe(true)
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })

  it("无章号加载异常保持旧诊断与 wiki 回退，不新增时序 gap", async () => {
    for (const file of ["emotional-arcs", "subplot-board", "resource-ledger", "emotion-ledger", "aura-evolution", "character-states"]) putStore(file, { fileVersion: 2 })
    const gap = vi.fn()
    for (const reader of readers) expect(await reader(PROJECT, { recordGap: gap })).toBe("")
    expect(await fallbackCharacterStatesDataSource.load(loadContext(undefined, gap))).toBe("")
    expect(gap).not.toHaveBeenCalled()
    expect(mocks.searchWiki).toHaveBeenCalledWith(PROJECT, "type:entity character")
  })

  it("snapshot loader 真正抛错保持 datasource_error", async () => {
    vi.spyOn(historyModule, "loadValidMemorySnapshots").mockRejectedValue(new Error("history IO failed"))
    const gap = vi.fn()
    expect(await readResourceLedgerText(PROJECT, { beforeChapter: 10, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("resourceLedger", "datasource_error")
  })

  it("gap sink 只在 build 激活，新增 type 不改变其它 reason 或长度字段", () => {
    recordDatasourceLoadFailure("outside", "temporal_history_unavailable")
    expect(collectContextGaps()).toEqual([])
    resetContextGaps()
    recordDatasourceLoadFailure("history", "temporal_history_unavailable")
    recordDatasourceLoadFailure("error")
    recordDatasourceLoadFailure("existing", "budget_exceeded")
    const recorded = collectContextGaps()
    expect(recorded).toEqual([
      { type: "unavailable", ref: "history", reason: "temporal_history_unavailable", originalLength: 0, retainedLength: 0 },
      { type: "load_failed", ref: "error", reason: "datasource_error", originalLength: 0, retainedLength: 0 },
      { type: "load_failed", ref: "existing", reason: "budget_exceeded", originalLength: 0, retainedLength: 0 },
    ])
    expect(getContextGapsActive()).toBe(false)
    recordDatasourceLoadFailure("after", "temporal_history_unavailable")
    expect(collectContextGaps()).toEqual(recorded)
  })

  it.each([1, 10])("真实 buildContextPackFromRawData 装配 ch%i：无后章状态、pack 非空且缺口诚实", async (chapterNumber) => {
    installHistory(Array.from({ length: 11 }, (_, index) => snapshot(index + 1, index + 1 < 2 ? undefined : index + 1 < 5 ? "A" : index + 1 < 10 ? "B" : "FutureHolder")))
    const pack = await buildContextPack(PROJECT, `写第${chapterNumber}章`, chapterNumber, buildOptions())
    expect(pack.characterStates).not.toMatch(/FutureHolder|FutureRoom|FutureCharacter|FutureDebt|未来完成态|第162章画像变化/)
    expect(pack.outline).not.toBe("")
    expect(pack.chapterGoal).not.toBe("")
    expect(pack.gaps).toContainEqual({ type: "unavailable", ref: "subplotBoard", reason: "temporal_history_unavailable", originalLength: 0, retainedLength: 0 })
    if (chapterNumber === 10) {
      expect(pack.characterStates).toContain("持有者 B（第5章转手）")
      expect(pack.characterStates).toContain("arc-9")
      expect(pack.characterStates).toContain("PastCharacter")
    }
    expect(getContextGapsActive()).toBe(false)
    recordDatasourceLoadFailure("after-build", "temporal_history_unavailable")
    expect(collectContextGaps()).toEqual([])
  })
})

describe("TASK-006: readSubplotBoardText 放行章前安全支线与 1x 快照重放去重", () => {
  it("readSubplotBoardText 放行章前安全 active/paused/proposed 支线，并严格过滤已解决/废弃/未来开启/未来进度支线", async () => {
    putStore("subplot-board", {
      items: [
        {
          id: "safe-active",
          title: "商会走私暗线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 6,
          relatedCharacters: ["Lin"],
          summary: "调查码头走私账本",
          progress: ["第2章发现账本异常", "第6章潜入货栈"],
          notes: "",
        },
        {
          id: "safe-paused",
          title: "古剑来历",
          status: "paused",
          startChapter: 3,
          lastSeenChapter: 5,
          relatedCharacters: ["Lin"],
          summary: "追查剑柄铭文",
          progress: ["Ch3 拓印铭文"],
          notes: "",
        },
        {
          id: "future-start",
          title: "未来开启支线",
          status: "active",
          startChapter: 10,
          lastSeenChapter: 10,
          relatedCharacters: ["Lin"],
          summary: "不应在 ch10 前泄露",
          progress: [],
          notes: "",
        },
        {
          id: "resolved-thread",
          title: "已解决支线",
          status: "resolved",
          startChapter: 1,
          resolvedChapter: 12,
          lastSeenChapter: 8,
          relatedCharacters: ["Lin"],
          summary: "未来已结案",
          progress: ["第1章开启"],
          notes: "",
        },
        {
          id: "abandoned-thread",
          title: "已废弃支线",
          status: "active",
          startChapter: 1,
          abandoned: true,
          lastSeenChapter: 4,
          relatedCharacters: ["Lin"],
          summary: "已废弃",
          progress: ["第1章开启"],
          notes: "",
        },
        {
          id: "future-progress",
          title: "未来进度支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 6,
          relatedCharacters: ["Lin"],
          summary: "包含第10章剧透进度",
          progress: ["第2章开端", "第10章真凶伏法"],
          notes: "",
        },
        {
          id: "future-last-seen",
          title: "未来最后出现支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 11,
          relatedCharacters: ["Lin"],
          summary: "晚章已更新状态",
          progress: ["第2章开端"],
          notes: "",
        },
      ],
      lastUpdated: "",
    })

    const gap = vi.fn()
    const text = await readSubplotBoardText(PROJECT, { beforeChapter: 10, recordGap: gap })
    expect(text).toContain("商会走私暗线")
    expect(text).toContain("古剑来历")
    expect(text).not.toMatch(/未来开启支线|已解决支线|已废弃支线|未来进度支线|未来最后出现支线/)
    // 因存在被过滤条目，仍诚实记录 temporal_history_unavailable
    expect(gap).toHaveBeenCalledWith("subplotBoard", "temporal_history_unavailable")
  })

  it("readSubplotBoardText 对全部安全且具备 lastSeenChapter < N 的支线零 unavailable 缺口；缺失 lastSeenChapter 或摘要/进度含未来章号（含中文数字）时 fail-closed 拦截并记缺口", async () => {
    putStore("subplot-board", {
      items: [
        {
          id: "complete",
          title: "完整时点支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 5,
          relatedCharacters: ["Lin"],
          summary: "第三章起核对账册",
          progress: ["第五章取得证据"],
          notes: "",
        },
      ],
      lastUpdated: "",
    })
    const cleanGap = vi.fn()
    const cleanText = await readSubplotBoardText(PROJECT, { beforeChapter: 8, recordGap: cleanGap })
    expect(cleanText).toContain("完整时点支线")
    expect(cleanGap).not.toHaveBeenCalled()

    // 缺失 lastSeenChapter → fail-closed 过滤为空并记录 temporal_history_unavailable
    putStore("subplot-board", {
      items: [
        {
          id: "no-last-seen",
          title: "缺lastSeen支线",
          status: "proposed",
          startChapter: 2,
          relatedCharacters: ["Lin"],
          summary: "旧数据无 lastSeenChapter",
          progress: ["第2章伏笔"],
          notes: "",
        },
      ],
      lastUpdated: "",
    })
    const missingLastSeenGap = vi.fn()
    const missingLastSeenText = await readSubplotBoardText(PROJECT, { beforeChapter: 8, recordGap: missingLastSeenGap })
    expect(missingLastSeenText).toBe("")
    expect(missingLastSeenGap).toHaveBeenCalledWith("subplotBoard", "temporal_history_unavailable")

    // summary 含未来阿拉伯章号（第20章）或中文数字章号（第二十章）→ fail-closed 拦截并记缺口
    putStore("subplot-board", {
      items: [
        {
          id: "future-summary-arabic",
          title: "摘要阿拉伯剧透支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 5,
          relatedCharacters: ["Lin"],
          summary: "将在第20章揭露真实幕后主使",
          progress: ["第5章拿到线索"],
          notes: "",
        },
        {
          id: "future-summary-chinese",
          title: "摘要中文剧透支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 5,
          relatedCharacters: ["Lin"],
          summary: "第二十章双方在古塔决战",
          progress: ["第五章密谈"],
          notes: "",
        },
        {
          id: "future-progress-chinese",
          title: "进度中文剧透支线",
          status: "active",
          startChapter: 2,
          lastSeenChapter: 5,
          relatedCharacters: ["Lin"],
          summary: "正常摘要",
          progress: ["第二章起意", "第一百零二回真相大白"],
          notes: "",
        },
      ],
      lastUpdated: "",
    })
    const futureSummaryGap = vi.fn()
    const futureSummaryText = await readSubplotBoardText(PROJECT, { beforeChapter: 10, recordGap: futureSummaryGap })
    expect(futureSummaryText).toBe("")
    expect(futureSummaryGap).toHaveBeenCalledWith("subplotBoard", "temporal_history_unavailable")
  })

  it("readSubplotBoardText 遇到损坏的非数组 items 仍报 datasource_error", async () => {
    putStore("subplot-board", { items: "corrupt", lastUpdated: "" })
    const gap = vi.fn()
    expect(await readSubplotBoardText(PROJECT, { beforeChapter: 5, recordGap: gap })).toBe("")
    expect(gap).toHaveBeenCalledWith("subplotBoard", "datasource_error")
  })

  it("loadProjectionTexts 单次调用仅触发 1 次 loadValidMemorySnapshots（emotional + resource 共享）", async () => {
    const snapshots = [snapshot(1), snapshot(2, "A"), snapshot(5, "B")]
    const loadSpy = vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue(snapshots)
    const texts = await loadProjectionTexts(PROJECT, { beforeChapter: 6 })
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(texts.emotionalText).toContain("arc-5")
    expect(texts.resourceText).toContain("持有者 B")
  })

  it("buildContextPack 有合法 chapterNumber 时跨 cognition + emotional + resource 仅调用 1 次 loadValidMemorySnapshots（消除 3x 重放）", async () => {
    mocks.includeCognitionDataSource = true
    const s1 = { ...snapshot(1), knowledgeChanges: ["Lin知道密室入口"] }
    const s2 = { ...snapshot(2, "A"), knowledgeChanges: ["Lin知道幕后主使"] }
    const s3 = snapshot(3, "B")
    const loadSpy = vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue([s1, s2, s3])

    const pack = await buildContextPack(PROJECT, "写第3章", 3, buildOptions())
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(pack.cognitionStates).toContain("密室入口")
    expect(pack.characterStates).toContain("arc-2")
    expect(pack.characterStates).toContain("持有者 A")
  })

  it("buildContextPack 无 chapterNumber 时惰性不调用 loadValidMemorySnapshots（0 IO）", async () => {
    mocks.includeCognitionDataSource = true
    const loadSpy = vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue([snapshot(1, "A")])
    await buildContextPack(PROJECT, "整理设定", undefined, buildOptions())
    expect(loadSpy).not.toHaveBeenCalled()
  })
})
