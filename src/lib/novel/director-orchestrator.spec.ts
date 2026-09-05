import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  tryAdvanceDirector,
  collectPhaseGateInput,
  phaseGapHint,
  retryDirector,
  loadDirectorState,
  serializeDirectorState,
  isDirectorStateValid,
  directorStatePath,
  type DirectorSnapshot,
} from "./director-orchestrator"
import { createDirectorPipeline } from "./director-pipeline"
import { createEmptyWorldBlueprint } from "./world-blueprint"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async () => {
    throw new Error("ENOENT")
  }),
}))

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
