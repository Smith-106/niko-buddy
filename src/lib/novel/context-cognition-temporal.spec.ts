import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cognitionTextDataSource } from "./context-data-sources"
import { PROJECTION_REGISTRY } from "./projection-status-ledger"
import * as historyModule from "./chapter-ingest-history"
import * as cognitionModule from "./character-cognition"
import type { CognitionState } from "./character-cognition"
import { collectContextGaps, recordDatasourceLoadFailure, resetContextGaps } from "./context-engine-gaps"
import { DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG } from "./revision-feedback"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { ContextLoadContext } from "./context-data-source"

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  const unexpectedEffect = async () => { throw new Error("Unexpected side effect during cognition temporal read") }
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    listDirectory: vi.fn(async (path: string) => [...files.keys()]
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => ({ name: file.slice(path.length + 1), path: file, is_dir: false }))),
    fileExists: vi.fn(async () => false),
    getFileModifiedTime: vi.fn(async () => 0),
    writeFile: vi.fn(unexpectedEffect),
    writeFileAtomic: vi.fn(unexpectedEffect),
    writeFilesAtomic: vi.fn(unexpectedEffect),
    createDirectory: vi.fn(unexpectedEffect),
    deleteFile: vi.fn(unexpectedEffect),
    renameFile: vi.fn(unexpectedEffect),
    searchWiki: vi.fn(async () => []),
    writingApi: vi.fn(unexpectedEffect),
    sampleTruthFoldDrift: vi.fn(unexpectedEffect),
    rebuildRegistryProjections: vi.fn(unexpectedEffect),
    selfHealFailedProjections: vi.fn(unexpectedEffect),
    syncSnapshotToMemory: vi.fn(unexpectedEffect),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  listDirectory: mocks.listDirectory,
  fileExists: mocks.fileExists,
  getFileModifiedTime: mocks.getFileModifiedTime,
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
  rebuildRegistryProjections: mocks.rebuildRegistryProjections,
  selfHealFailedProjections: mocks.selfHealFailedProjections,
  syncSnapshotToMemory: mocks.syncSnapshotToMemory,
}))

const PROJECT = "/cognition-temporal-context"

function snapshot(chapterNumber: number, knowledgeChanges: string[] = []): ChapterSnapshot {
  return {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    sourceType: "chapter",
    sourceSequence: chapterNumber,
    revision: 1,
    isHistorical: false,
    summary: `summary-${chapterNumber}`,
    characters: ["林砚"],
    locations: [], organizations: [], items: [], events: [],
    characterStateChanges: [], relationshipChanges: [], knowledgeChanges,
    foreshadowingChanges: [], newCanonFacts: [], timelineEvents: [], conflicts: [],
    endingHook: "", graphNodes: [], graphEdges: [],
    characterDetails: {}, itemDetails: {},
  }
}

function putLive(value: unknown): void {
  mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, JSON.stringify(value))
}

function installHistory(snapshots: ChapterSnapshot[]): void {
  for (const value of snapshots) {
    const prefix = String(value.chapterNumber).padStart(3, "0")
    mocks.files.set(`${PROJECT}/.novel/snapshots/${prefix}.snapshot.json`, JSON.stringify(value))
    mocks.files.set(`${PROJECT}/wiki/chapters/${prefix}.md`, `---\ntype: chapter\nchapter_number: ${value.chapterNumber}\n---\n测试正文`)
  }
}

function loadContext(chapterNumber?: number, recordGap: NonNullable<ContextLoadContext["recordGap"]> = vi.fn()): ContextLoadContext {
  return {
    projectPath: PROJECT, task: "继续写作", chapterNumber, recordGap,
    config: { recentSummaryWindow: 3, searchTopK: 5, snapshotLookback: 3, revisionFeedbackWindowConfig: DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(PROJECTION_REGISTRY.cognition, "load")
  vi.spyOn(PROJECTION_REGISTRY.cognition, "save")
  vi.spyOn(PROJECTION_REGISTRY.cognition, "applyToStore")
  mocks.files.clear()
  resetContextGaps()
  collectContextGaps()
})

afterEach(() => {
  for (const effect of [
    mocks.writeFile, mocks.writeFileAtomic, mocks.writeFilesAtomic,
    mocks.createDirectory, mocks.deleteFile, mocks.renameFile,
    mocks.writingApi, mocks.sampleTruthFoldDrift, mocks.rebuildRegistryProjections,
    mocks.selfHealFailedProjections, mocks.syncSnapshotToMemory,
  ]) expect(effect).not.toHaveBeenCalled()
  expect(PROJECTION_REGISTRY.cognition.load).not.toHaveBeenCalled()
  expect(PROJECTION_REGISTRY.cognition.save).not.toHaveBeenCalled()
  expect(PROJECTION_REGISTRY.cognition.applyToStore).not.toHaveBeenCalled()
  expect(mocks.searchWiki).not.toHaveBeenCalled()
  collectContextGaps()
  vi.restoreAllMocks()
})

describe("cognition 章前读取的真实行为", () => {
  it("C1：晚章 live 已知不能泄入第 2 章，第 1 章不知道必须保留", async () => {
    const early = snapshot(1, ["林砚不知道门锁密码", "读者知道门锁密码"])
    const later = snapshot(3, ["林砚知道门锁密码"])
    const live = PROJECTION_REGISTRY.cognition.foldFromSnapshot?.([early, later], { now: "" })
    expect(live).toEqual({
      characters: [{ character: "林砚", knows: ["门锁密码"], doesNotKnow: [] }],
      readerKnows: ["门锁密码"], lastUpdatedChapter: 3,
    })
    putLive(live)
    installHistory([later, early])
    const filesBefore = [...mocks.files]
    const gap = vi.fn()
    const text = await cognitionTextDataSource.load(loadContext(2, gap))
    expect(text).not.toContain("林砚知道：门锁密码")
    expect(text).toContain("林砚不知道：门锁密码")
    expect(text).toContain("读者知道：门锁密码")
    expect(gap).not.toHaveBeenCalled()
    expect([...mocks.files]).toEqual(filesBefore)
  })
})

function liveState(lastUpdatedChapter = 162): CognitionState {
  return {
    characters: [{ character: "林砚", knows: ["liveOnly"], doesNotKnow: [] }],
    readerKnows: [], lastUpdatedChapter,
  }
}

async function readText(chapterNumber?: number, recordGap: NonNullable<ContextLoadContext["recordGap"]> = vi.fn()): Promise<string> {
  const filesBefore = [...mocks.files]
  const text = await cognitionTextDataSource.load(loadContext(chapterNumber, recordGap))
  expect([...mocks.files]).toEqual(filesBefore)
  return text
}

describe("cognition 章前隔离与 alias", () => {
  it.each([1, 2, 3, 4, 5])("N=%i：不知道到知道只在已发生的章后生效", async (target) => {
    const snapshots = [
      snapshot(1, ["林砚不知道门锁密码", "读者知道门锁密码"]),
      snapshot(2),
      snapshot(3, ["林砚知道门锁密码"]),
      snapshot(4),
      snapshot(5, ["林砚知道目标章信息"]),
    ]
    putLive(liveState())
    installHistory([...snapshots].reverse())
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    const text = await readText(target, gap)
    expect(fold).toHaveBeenCalledTimes(1)
    const [retained, ctx] = fold.mock.calls[0]
    expect(retained.map((value) => value.chapterNumber)).toEqual(snapshots.filter((value) => value.chapterNumber < target).map((value) => value.chapterNumber))
    expect(ctx).toEqual({ now: "" })
    expect(text).not.toContain("liveOnly")
    expect(text).not.toContain("目标章信息")
    if (target === 1) {
      expect(text).toBe("")
      expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
    } else {
      expect(text).toContain("读者知道：门锁密码")
      if (target <= 3) {
        expect(text).toContain("林砚不知道：门锁密码")
        expect(text).not.toContain("林砚知道：门锁密码")
      } else {
        expect(text).toContain("林砚知道：门锁密码")
        expect(text).not.toContain("林砚不知道：门锁密码")
      }
      expect(gap).not.toHaveBeenCalled()
    }
  })

  it("读者知道不会提升角色认知，角色之间也不互相共享", async () => {
    installHistory([snapshot(1, ["林砚不知道暗门位置", "读者知道暗门位置", "苏禾知道撤离路线"])])
    putLive(liveState())
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("林砚不知道：暗门位置\n苏禾知道：撤离路线\n读者知道：暗门位置")
    expect(gap).not.toHaveBeenCalled()
  })

  it("同 snapshot alias 合并，每个 snapshot 自建自己的 alias map", async () => {
    const first = {
      ...snapshot(1, ["小林不知道机关位置", "阿砚知道前门位置", "读者知道机关位置"]),
      characters: ["林砚"], characterAliases: { 林砚: ["小林", "阿砚"] },
    }
    const second = {
      ...snapshot(2, ["小林知道另一条线索"]),
      characters: ["苏禾"], characterAliases: { 苏禾: ["小林"] },
    }
    installHistory([second, first])
    putLive(liveState())
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    expect(await readText(2)).toBe("林砚知道：前门位置\n林砚不知道：机关位置\n读者知道：机关位置")
    expect(await readText(3)).toBe("林砚知道：前门位置\n林砚不知道：机关位置\n苏禾知道：另一条线索\n读者知道：机关位置")
    expect(fold.mock.calls.every(([, ctx]) => ctx.aliasMaps === undefined && ctx.now === "")).toBe(true)
  })

  it("真实 loader 保持去重升序，outline 与历史快照不会进入 fold", async () => {
    const first = snapshot(1, ["林砚知道第一条线索"])
    const valid = snapshot(4, ["林砚知道第四条线索"])
    installHistory([
      valid,
      { ...snapshot(2, ["林砚知道outline泄露"]), sourceType: "outline" },
      snapshot(5, ["林砚知道target泄露"]),
      snapshot(6, ["林砚知道future泄露"]),
      first,
    ])
    // 历史归档属于 history/ 目录（strict listSnapshots 只扫当前 dir）——写入当前 dir
    // 的历史快照是损坏而非泄露源，strict reader 会拒绝。
    mocks.files.set(`${PROJECT}/.novel/snapshots/history/003/extraction.snapshot.json`, JSON.stringify({ ...snapshot(3, ["林砚知道historical泄露"]), isHistorical: true }))
    // 同章额外目录项仍由现有 loader 读取当前文件并去重。
    mocks.files.set(`${PROJECT}/.novel/snapshots/001-copy.snapshot.json`, JSON.stringify(first))
    putLive(liveState())
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    const text = await readText(5, gap)
    expect(fold.mock.calls[0][0].map((value) => value.chapterNumber)).toEqual([1, 4])
    expect(text).toBe("林砚知道：第一条线索、第四条线索")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it("fold 前排除 target/future/非法章/outline/historical，兼容 missing legacy sourceType", async () => {
    const legacy = { ...snapshot(1, ["林砚知道legacy线索"]), sourceType: undefined, isHistorical: undefined }
    const valid = snapshot(4, ["林砚知道正常线索"])
    const candidates = [
      snapshot(0, ["林砚知道zero泄露"]),
      legacy,
      { ...snapshot(2, ["林砚知道outline泄露"]), sourceType: "outline" as const },
      { ...snapshot(3, ["林砚知道historical泄露"]), isHistorical: true },
      snapshot(-1, ["林砚知道negative泄露"]),
      snapshot(1.5, ["林砚知道fraction泄露"]),
      snapshot(Number.NaN, ["林砚知道nan泄露"]),
      snapshot(Number.POSITIVE_INFINITY, ["林砚知道infinity泄露"]),
      snapshot(Number.NEGATIVE_INFINITY, ["林砚知道negativeInfinity泄露"]),
      valid,
      snapshot(5, ["林砚知道target泄露"]),
      snapshot(6, ["林砚知道future泄露"]),
    ]
    vi.spyOn(historyModule, "loadValidMemorySnapshots").mockResolvedValue(candidates)
    putLive(liveState())
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    expect(await readText(5, gap)).toBe("林砚知道：legacy线索、正常线索")
    expect(fold).toHaveBeenCalledExactlyOnceWith([legacy, valid], { now: "" })
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })
})

describe("cognition 无章号兼容与非法目标", () => {
  it("undefined 章号保持真实 live renderer，且不读历史或 fold", async () => {
    putLive({
      characters: [{ character: "Legacy", knows: ["legacy事实"], doesNotKnow: ["另一事实"] }],
      readerKnows: ["观众事实"],
      // 旧 renderer 不消费该字段，本路径不新增时序 core 校验。
    })
    installHistory([snapshot(1, ["林砚知道历史事实"])])
    const history = vi.spyOn(historyModule, "loadValidMemorySnapshots")
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    expect(await readText(undefined, gap)).toBe("Legacy知道：legacy事实\nLegacy不知道：另一事实\n读者知道：观众事实")
    expect(gap).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    expect(fold).not.toHaveBeenCalled()
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it.each(["missing", "blank", "null", "empty"])("undefined + %s live 保持空值而非 error", async (kind) => {
    if (kind === "blank") mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, "")
    if (kind === "null") vi.spyOn(cognitionModule, "loadCognitionState").mockResolvedValue(null)
    if (kind === "empty") putLive(cognitionModule.emptyCognitionState())
    const gap = vi.fn()
    expect(await readText(undefined, gap)).toBe("")
    expect(gap).not.toHaveBeenCalled()
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("undefined + corrupt JSON 仍是 datasource_error，记录一次", async () => {
    mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, "{bad JSON")
    const gap = vi.fn()
    expect(await readText(undefined, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("undefined + loader 抛错仍是 datasource_error，记录一次", async () => {
    vi.spyOn(cognitionModule, "loadCognitionState").mockRejectedValue(new Error("live loader failed"))
    const gap = vi.fn()
    expect(await readText(undefined, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })

  it("undefined + renderer 抛错仍是 datasource_error，记录一次", async () => {
    putLive(liveState())
    vi.spyOn(cognitionModule, "cognitionToContextText").mockImplementation(() => { throw new Error("renderer failed") })
    const gap = vi.fn()
    expect(await readText(undefined, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("非法 target %s 在全部 IO 前退出", async (target) => {
    putLive(liveState())
    installHistory([snapshot(1, ["林砚知道历史事实"])])
    const history = vi.spyOn(historyModule, "loadValidMemorySnapshots")
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    expect(await readText(target, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
    for (const io of [mocks.readFile, mocks.listDirectory, mocks.fileExists, mocks.getFileModifiedTime]) expect(io).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    expect(fold).not.toHaveBeenCalled()
  })
})

describe("cognition 历史覆盖与不可重放边界", () => {
  it.each(["missing", "blank", "null"])("%s live 不截断有效 prior replay", async (kind) => {
    if (kind === "blank") mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, "")
    if (kind === "null") vi.spyOn(cognitionModule, "loadCognitionState").mockResolvedValue(null)
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("林砚知道：已发生事实")
    expect(gap).not.toHaveBeenCalled()
  })

  it("partial coverage 保留受支持的 prior facts，只报一次 unavailable", async () => {
    installHistory([snapshot(1, ["林砚知道已发生事实"]), snapshot(4, ["林砚知道target泄露"])])
    putLive(liveState())
    const gap = vi.fn()
    expect(await readText(4, gap)).toBe("林砚知道：已发生事实")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it("missing prior coverage + null live 仍诚实报告 unavailable", async () => {
    installHistory([snapshot(1)])
    const gap = vi.fn()
    expect(await readText(3, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it.each([1, 2])("N=%i 空 replay + live facts 不回填 live 或伪造 seed", async (target) => {
    putLive(liveState(0))
    if (target === 2) installHistory([snapshot(1)])
    const gap = vi.fn()
    expect(await readText(target, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it.each(["knows", "doesNotKnow", "readerKnows"])("完整空 replay + live %s facts 仍 unavailable", async (kind) => {
    const state = cognitionModule.emptyCognitionState()
    if (kind === "readerKnows") state.readerKnows = ["undated事实"]
    else state.characters = [{ character: "林砚", knows: kind === "knows" ? ["undated事实"] : [], doesNotKnow: kind === "doesNotKnow" ? ["undated事实"] : [] }]
    putLive(state)
    installHistory([snapshot(1)])
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it.each(["null", "empty", "empty-character"])("完整空历史 + %s live 是合法空结果", async (kind) => {
    if (kind === "empty") putLive(cognitionModule.emptyCognitionState())
    if (kind === "empty-character") putLive({ characters: [{ character: "林砚", knows: [], doesNotKnow: [] }], readerKnows: [], lastUpdatedChapter: 162 })
    installHistory([snapshot(1)])
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).not.toHaveBeenCalled()
  })

  it("N=1 + null live 的完整空 prior history 不制造 gap", async () => {
    const gap = vi.fn()
    expect(await readText(1, gap)).toBe("")
    expect(gap).not.toHaveBeenCalled()
  })

  it("absent history 不注入 live，报告 unavailable", async () => {
    putLive(liveState())
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })

  it("缺 cognition fold 即 unavailable，不能退回 live", async () => {
    putLive(liveState())
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const original = PROJECTION_REGISTRY.cognition
    PROJECTION_REGISTRY.cognition = { category: original.category, rebuildable: original.rebuildable, file: original.file }
    try {
      const gap = vi.fn()
      expect(await readText(2, gap)).toBe("")
      expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
    } finally {
      PROJECTION_REGISTRY.cognition = original
    }
  })

  it("fold 返回 undefined 即 unavailable，不能伪造空 seed", async () => {
    putLive(liveState())
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot").mockReturnValue(undefined)
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "temporal_history_unavailable")
  })
})

describe("cognition 损坏与 gap 分类", () => {
  it.each([
    {},
    { characters: null, readerKnows: [], lastUpdatedChapter: 1 },
    { characters: [{ character: 3, knows: [], doesNotKnow: [] }], readerKnows: [], lastUpdatedChapter: 1 },
    { characters: [{ character: "林砚", knows: [3], doesNotKnow: [] }], readerKnows: [], lastUpdatedChapter: 1 },
    { characters: [{ character: "林砚", knows: [], doesNotKnow: null }], readerKnows: [], lastUpdatedChapter: 1 },
    { characters: [], readerKnows: [3], lastUpdatedChapter: 1 },
    { characters: [], readerKnows: [], lastUpdatedChapter: -1 },
    { characters: [], readerKnows: [], lastUpdatedChapter: 0.5 },
    { characters: [], readerKnows: [], lastUpdatedChapter: null },
    "bad live shape",
  ])("malformed non-null live #%# 报一次 datasource_error", async (state) => {
    putLive(state)
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const fold = vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot")
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
    expect(fold).not.toHaveBeenCalled()
  })

  it("真实 corrupt live JSON + valid replay 不伪装 unavailable", async () => {
    mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, "{bad JSON")
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })

  it.each([
    null,
    {},
    { characters: [{ character: 1, knows: [], doesNotKnow: [] }] },
    { characters: [{ character: "林砚", knows: "bad", doesNotKnow: [] }] },
    { characters: [{ character: "林砚", knows: [], doesNotKnow: [false] }] },
    { readerKnows: "bad" },
    { readerKnows: [false] },
    { lastUpdatedChapter: -1 },
    { lastUpdatedChapter: 0.5 },
    { lastUpdatedChapter: Number.NaN },
    { lastUpdatedChapter: Number.POSITIVE_INFINITY },
    { lastUpdatedChapter: 2 },
    { lastUpdatedChapter: 3 },
  ])("malformed/非章前 fold #%# 报一次 datasource_error", async (patch) => {
    putLive(liveState())
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const view = patch === null ? null : Object.keys(patch).length === 0 ? {} : { ...cognitionModule.emptyCognitionState(), ...patch }
    vi.spyOn(PROJECTION_REGISTRY.cognition, "foldFromSnapshot").mockReturnValue(view)
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })

  it("真实 history loader 抛错仍是 datasource_error", async () => {
    putLive(liveState())
    vi.spyOn(historyModule, "loadValidMemorySnapshots").mockRejectedValue(new Error("history IO failed"))
    const gap = vi.fn()
    expect(await readText(2, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })

  it("gap sink 区分 unavailable 与 load_failed，不重复记录 source error", async () => {
    resetContextGaps()
    putLive(liveState())
    const gap = vi.fn(recordDatasourceLoadFailure)
    expect(await readText(2, gap)).toBe("")
    expect(collectContextGaps()).toEqual([{ type: "unavailable", ref: "cognitionText", reason: "temporal_history_unavailable", originalLength: 0, retainedLength: 0 }])
    expect(gap).toHaveBeenCalledTimes(1)
    resetContextGaps()
    gap.mockClear()
    mocks.files.set(`${PROJECT}/.novel/cognition-state.json`, "{bad JSON")
    expect(await readText(2, gap)).toBe("")
    expect(collectContextGaps()).toEqual([{ type: "load_failed", ref: "cognitionText", reason: "datasource_error", originalLength: 0, retainedLength: 0 }])
    expect(gap).toHaveBeenCalledTimes(1)
  })
})

describe("序列化 null 与 loader-null 的既有区别", () => {
  it.each([undefined, 2])("N=%s：文件内容 null 沿用原 loader 的 datasource_error", async (target) => {
    // 非空 JSON null 在既有 store 的 fileVersion 读取阶段报错，不能伪装成缺失。
    putLive(null)
    installHistory([snapshot(1, ["林砚知道已发生事实"])])
    const gap = vi.fn()
    expect(await readText(target, gap)).toBe("")
    expect(gap).toHaveBeenCalledExactlyOnceWith("cognitionText", "datasource_error")
  })
})
