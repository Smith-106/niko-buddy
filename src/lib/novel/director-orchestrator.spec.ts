import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  tryAdvanceDirector,
  tryAdvanceDirectorFromProject,
  collectPhaseGateInput,
  collectProjectSnapshot,
  phaseGapHint,
  retryDirector,
  loadDirectorState,
  serializeDirectorState,
  isDirectorStateValid,
  directorStatePath,
  type DirectorSnapshot,
} from "./director-orchestrator"
import { createDirectorPipeline } from "./director-pipeline"
import { createEmptyWorldBlueprint, type WorldBlueprint } from "./world-blueprint"
import { listEntityFiles } from "./entity-subdir-resolver"
import { listSnapshots } from "./chapter-ingest"
import { listDirectory } from "@/commands/fs"
import { loadWorldBlueprint } from "./world-blueprint"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: vi.fn(async () => {
        throw new Error("ENOENT")
      }),
      listDirectory: vi.fn(async () => []),
  }
})

vi.mock("./entity-subdir-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./entity-subdir-resolver")>()
  return { ...actual, listEntityFiles: vi.fn(async () => []) }
})

vi.mock("./chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-ingest")>()
  return { ...actual, listSnapshots: vi.fn(async () => []) }
})

vi.mock("./world-blueprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./world-blueprint")>()
  return { ...actual, loadWorldBlueprint: vi.fn(async () => null) }
})

const mockListEntityFiles = vi.mocked(listEntityFiles)
const mockListSnapshots = vi.mocked(listSnapshots)
const mockListDirectory = vi.mocked(listDirectory)
const mockLoadWorldBlueprint = vi.mocked(loadWorldBlueprint)

const FULL_SNAPSHOT: DirectorSnapshot = {
  idea: { title: "雾都侦探", genre: "悬疑", coreConflict: "连环失踪案与旧案关联" },
  worldComplete: true,
  protagonistNamed: true,
  antagonistNamed: true,
  frameworkChosen: true,
  volumesPlanned: true,
  firstChapterReady: true,
}

describe("director-orchestrator（60 号设计：director-pipeline 接线编排）", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("全量快照 → 逐阶段推进至 completed", () => {
    let state = createDirectorPipeline()
    const snap = FULL_SNAPSHOT
    for (let i = 0; i < 5; i++) {
      const out = tryAdvanceDirector(state, snap)
      expect(out.advanced).toBe(true)
      state = out.state
    }
    expect(state.statuses.idea).toBe("done")
    expect(state.statuses.world).toBe("done")
    expect(state.statuses.character).toBe("done")
    expect(state.statuses.outline).toBe("done")
    expect(state.statuses.chapters).toBe("done")
  })

  it("idea 缺核心冲突 → 不推进 + 缺口提示", () => {
    const state = createDirectorPipeline()
    const snap: DirectorSnapshot = {
      ...FULL_SNAPSHOT,
      idea: { title: "雾都侦探", genre: "悬疑", coreConflict: "" },
    }
    const out = tryAdvanceDirector(state, snap)
    expect(out.advanced).toBe(false)
    expect(out.blockedReason).toBe("核心冲突缺失")
    expect(out.gap).toBe("请先描述核心冲突")
    expect(state.statuses.idea).toBe("running")
  })

  it("world 未完备（blueprint 校验失败）→ 不推进", () => {
    const state = createDirectorPipeline()
    // 推进 idea 过门
    const ideaOut = tryAdvanceDirector(state, FULL_SNAPSHOT)
    expect(ideaOut.advanced).toBe(true)
    // world 阶段：提供校验失败的 blueprint
    const bp = createEmptyWorldBlueprint("都市")
    const out = tryAdvanceDirector(ideaOut.state, FULL_SNAPSHOT, bp)
    expect(out.advanced).toBe(false)
    expect(out.blockedReason).toContain("世界骨架未完备")
    expect(out.gap).toContain("世界蓝图校验")
  })

  it("character 缺对手 → 不推进 + 对手缺口提示", () => {
    let state = createDirectorPipeline()
    const snap: DirectorSnapshot = { ...FULL_SNAPSHOT, antagonistNamed: false }
    state = tryAdvanceDirector(state, snap).state // idea
    state = tryAdvanceDirector(state, snap).state // world
    const out = tryAdvanceDirector(state, snap)
    expect(out.advanced).toBe(false)
    expect(out.gap).toBe("对手（反派）尚未建立")
  })

  it("失败后 retryDirector 回 running 可再推进", () => {
    let state = createDirectorPipeline()
    const bad: DirectorSnapshot = { ...FULL_SNAPSHOT, idea: { ...FULL_SNAPSHOT.idea, genre: "" } }
    const out = tryAdvanceDirector(state, bad)
    expect(out.advanced).toBe(false)
    expect(out.state.statuses.idea).toBe("failed")
    // 补全后重试
    const retried = retryDirector(out.state)
    expect(retried.statuses.idea).toBe("running")
    const good = tryAdvanceDirector(retried, FULL_SNAPSHOT)
    expect(good.advanced).toBe(true)
  })

  it("collectPhaseGateInput 无 blueprint 时用快照标记", () => {
    const input = collectPhaseGateInput(FULL_SNAPSHOT)
    expect(input.worldComplete).toBe(true)
    expect(input.idea.title).toBe("雾都侦探")
  })

  it("phaseGapHint 各阶段缺口文案精确", () => {
    expect(phaseGapHint("idea", { ...FULL_SNAPSHOT, idea: { title: "", genre: "", coreConflict: "" } })).toBe("请先填写书名")
    expect(phaseGapHint("character", { ...FULL_SNAPSHOT, protagonistNamed: false })).toBe("主角尚未建立")
    expect(phaseGapHint("outline", { ...FULL_SNAPSHOT, frameworkChosen: false })).toBe("情节框架未选型")
    expect(phaseGapHint("chapters", FULL_SNAPSHOT)).toBe("首章尚未生成")
  })

  it("loadDirectorState 文件缺失 → 新管线", async () => {
    const state = await loadDirectorState("/proj")
    expect(state.statuses.idea).toBe("running")
  })

  it("directorStatePath 同步拼接 .novel 路径", () => {
    expect(directorStatePath("/proj")).toBe("/proj/.novel/director-pipeline.json")
  })

  it("serialize/isValid 往返一致", () => {
    const state = createDirectorPipeline()
    const json = serializeDirectorState(state)
    const parsed = JSON.parse(json)
    expect(isDirectorStateValid(parsed)).toBe(true)
    expect(isDirectorStateValid(null)).toBe(false)
    expect(isDirectorStateValid({ foo: 1 })).toBe(false)
  })

  it("world blueprint 校验失败（空蓝图）→ worldComplete=false（与 verdict 一致）", () => {
    // 空 blueprint 校验必有 findings（REQUIRED_WORLD_LAYERS 全缺失）→ verdict incomplete
    const bp = createEmptyWorldBlueprint("都市")
    const input = collectPhaseGateInput({ ...FULL_SNAPSHOT, worldComplete: false }, bp)
    expect(input.worldComplete).toBe(false)
  })
})

describe("director-orchestrator · 项目快照采集与异步推进（MIG-001 增补）", () => {
  const COMPLETE_BP: WorldBlueprint = {
    version: "1.0",
    worldType: "都市",
    layers: {
      axioms: ["a"],
      background: ["b"],
      geography: ["g"],
      cultures: ["c"],
      conflicts: ["f"],
    },
  }
  const IDEA = { title: "雾都侦探", genre: "悬疑", coreConflict: "连环失踪案与旧案关联" }

  beforeEach(() => {
    mockListEntityFiles.mockReset()
    mockListSnapshots.mockReset()
    mockListDirectory.mockReset()
    mockLoadWorldBlueprint.mockReset()
    mockListEntityFiles.mockResolvedValue([])
    mockListSnapshots.mockResolvedValue([])
    mockListDirectory.mockResolvedValue([])
    mockLoadWorldBlueprint.mockResolvedValue(null)
  })

  it("collectProjectSnapshot 全绿：角色/大纲/快照/world 逐项采真值", async () => {
    mockLoadWorldBlueprint.mockResolvedValue(COMPLETE_BP)
    mockListEntityFiles.mockResolvedValue([
      { name: "主角", path: "wiki/entities/characters/主角.md" },
      { name: "对手", path: "wiki/entities/characters/对手.md" },
      { name: "路人", path: "wiki/entities/others/路人.md" },
    ])
    mockListDirectory.mockResolvedValue([
      { name: "00-framework.md", path: "p/wiki/outlines/00-framework.md", is_dir: false },
      { name: "01-卷一.md", path: "p/wiki/outlines/01-卷一.md", is_dir: false },
      { name: "草稿", path: "p/wiki/outlines/草稿", is_dir: true },
    ])
    mockListSnapshots.mockResolvedValue([1, 2])
    const snap = await collectProjectSnapshot("/proj", IDEA)
    expect(snap.idea).toEqual(IDEA)
    expect(snap.worldComplete).toBe(true)
    expect(snap.protagonistNamed).toBe(true)
    expect(snap.antagonistNamed).toBe(true)
    expect(snap.frameworkChosen).toBe(true)
    expect(snap.volumesPlanned).toBe(true)
    expect(snap.firstChapterReady).toBe(true)
  })

  it("collectProjectSnapshot 数据源全挂 → 保守全 false（不伪报完备）", async () => {
    mockLoadWorldBlueprint.mockRejectedValue(new Error("boom"))
    mockListEntityFiles.mockRejectedValue(new Error("boom"))
    mockListDirectory.mockRejectedValue(new Error("boom"))
    mockListSnapshots.mockRejectedValue(new Error("boom"))
    const snap = await collectProjectSnapshot("/proj", IDEA)
    expect(snap.worldComplete).toBe(false)
    expect(snap.protagonistNamed).toBe(false)
    expect(snap.antagonistNamed).toBe(false)
    expect(snap.frameworkChosen).toBe(false)
    expect(snap.volumesPlanned).toBe(false)
    expect(snap.firstChapterReady).toBe(false)
  })

  it("collectProjectSnapshot 防御分支：无 layers 蓝图/反斜杠路径/负号与零号快照", async () => {
    mockLoadWorldBlueprint.mockResolvedValue({} as unknown as WorldBlueprint)
    mockListEntityFiles.mockResolvedValue([{ name: "主角", path: "wiki\\entities\\characters\\主角.md" }])
    mockListDirectory.mockResolvedValue([
      { name: "a.md", path: "p/wiki/outlines/a.md", is_dir: false },
      { name: "笔记.txt", path: "p/wiki/outlines/笔记.txt", is_dir: false },
    ])
    mockListSnapshots.mockResolvedValue([-1, 0])
    const snap = await collectProjectSnapshot("/proj", IDEA)
    expect(snap.worldComplete).toBe(false)
    expect(snap.protagonistNamed).toBe(true)
    expect(snap.antagonistNamed).toBe(false)
    expect(snap.frameworkChosen).toBe(true)
    expect(snap.volumesPlanned).toBe(false)
    // 0 不是正章快照（大纲快照为负号），首章未就绪
    expect(snap.firstChapterReady).toBe(false)
  })

  it("tryAdvanceDirectorFromProject 全绿 → 推进 idea 阶段", async () => {
    mockLoadWorldBlueprint.mockResolvedValue(COMPLETE_BP)
    mockListEntityFiles.mockResolvedValue([
      { name: "主角", path: "wiki/entities/characters/主角.md" },
      { name: "对手", path: "wiki/entities/characters/对手.md" },
    ])
    mockListDirectory.mockResolvedValue([
      { name: "a.md", path: "p/wiki/outlines/a.md", is_dir: false },
      { name: "b.md", path: "p/wiki/outlines/b.md", is_dir: false },
    ])
    mockListSnapshots.mockResolvedValue([1])
    const state = createDirectorPipeline()
    const out = await tryAdvanceDirectorFromProject("/proj", state, IDEA)
    expect(out.advanced).toBe(true)
    expect(out.completed).toBe(false)
    expect(out.state.currentPhase).toBe("world")
    expect(out.blockedReason).toBeUndefined()
    expect(mockLoadWorldBlueprint).toHaveBeenCalledWith("/proj")
  })

  it("tryAdvanceDirectorFromProject 快照缺口 → 不推进 + gap", async () => {
    const state = createDirectorPipeline()
    const out = await tryAdvanceDirectorFromProject("/proj", state, { title: "", genre: "悬疑", coreConflict: "c" })
    expect(out.advanced).toBe(false)
    expect(out.gap).toBe("请先填写书名")
    expect(out.state.statuses.idea).toBe("failed")
  })

  it("tryAdvanceDirectorFromProject 显式 blueprint 覆盖持久化（门控以显式值为准）", async () => {
    // 磁盘蓝图完备，但显式传入空蓝图 → 门控仍按显式值判 world 未过门
    mockLoadWorldBlueprint.mockResolvedValue(COMPLETE_BP)
    mockListEntityFiles.mockResolvedValue([
      { name: "主角", path: "wiki/entities/characters/主角.md" },
      { name: "对手", path: "wiki/entities/characters/对手.md" },
    ])
    mockListDirectory.mockResolvedValue([
      { name: "a.md", path: "p/wiki/outlines/a.md", is_dir: false },
      { name: "b.md", path: "p/wiki/outlines/b.md", is_dir: false },
    ])
    mockListSnapshots.mockResolvedValue([1])
    const state = createDirectorPipeline()
    const emptyBp = createEmptyWorldBlueprint("都市")
    // 第一步：idea 过门
    const first = await tryAdvanceDirectorFromProject("/proj", state, IDEA, emptyBp)
    expect(first.advanced).toBe(true)
    expect(first.state.currentPhase).toBe("world")
    // 第二步：world 被显式空蓝图挡住（磁盘完备也不顶替显式值）
    const out = await tryAdvanceDirectorFromProject("/proj", first.state, IDEA, emptyBp)
    expect(out.advanced).toBe(false)
    expect(out.blockedReason).toContain("世界骨架未完备")
    expect(out.gap).toContain("世界蓝图校验")
  })
})

describe("director-orchestrator 收尾补齐（战役收尾轮）", () => {
  const IDEA2 = { title: "雾都侦探", genre: "悬疑", coreConflict: "连环失踪案与旧案关联" }

  it("phaseGapHint idea 三要素齐全仍在 idea 阶段 → 通用缺口文案", () => {
    // 三个 trim 均非空时落到 line 176 通用分支（前三个 if 全 false）
    expect(phaseGapHint("idea", FULL_SNAPSHOT)).toBe("开书立意信息不完整")
  })

  it("phaseGapHint outline 已选型未规划分卷 → 分卷缺口文案", () => {
    // frameworkChosen=true 跳过 line 183 真分支，落到 line 184
    expect(phaseGapHint("outline", FULL_SNAPSHOT)).toBe("分卷尚未规划")
  })

  it("loadDirectorState 磁盘存在合法 JSON → 直接复原（覆盖 line 200 成功分支）", async () => {
    const fsMod = await import("@/commands/fs")
    const mockRead = vi.mocked(fsMod.readFile)
    const state = createDirectorPipeline()
    const payload = JSON.stringify({ ...state, currentPhase: "world" })
    mockRead.mockResolvedValueOnce(payload)
    const loaded = await loadDirectorState("/proj")
    expect(loaded.currentPhase).toBe("world")
    // 可观测行为：复原的状态可继续推进（非全新管线）
    expect(loaded.statuses).toBeDefined()
  })

  it("tryAdvanceDirectorFromProject 未传 blueprint 且磁盘加载失败 → catch 回退 null 继续推进", async () => {
    // line 158 箭头 `() => null`：外层 loadWorldBlueprint reject 时经 catch 回退。
    // 注意 tryAdvance 内部先调 collectProjectSnapshot（line 54 亦调 load），两次调用均需拒绝
    // 才能命中外层 catch，故此处用 mockRejectedValue（非 Once）覆盖两次。
    mockLoadWorldBlueprint.mockRejectedValue(new Error("ENOENT"))
    mockListEntityFiles.mockResolvedValue([])
    mockListDirectory.mockResolvedValue([])
    mockListSnapshots.mockResolvedValue([])
    const state = createDirectorPipeline()
    const out = await tryAdvanceDirectorFromProject("/proj", state, IDEA2)
    // 磁盘蓝图缺失 → snapshot.worldComplete=false，但 idea 阶段仍应推进（blueprint=null 不挡 idea）
    expect(mockLoadWorldBlueprint).toHaveBeenCalledWith("/proj")
    expect(out.state.currentPhase).toBe("world")
    expect(out.advanced).toBe(true)
    mockLoadWorldBlueprint.mockResolvedValue(null)
  })
})
