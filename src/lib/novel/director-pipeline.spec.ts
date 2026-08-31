import { describe, expect, it } from "vitest"
import {
  advanceDirectorPhase,
  createDirectorPipeline,
  DIRECTOR_PHASES,
  directorPipelineSummary,
  phaseGateOutput,
  retryDirectorPhase,
  type PhaseGateInput,
} from "./director-pipeline"

function passingInput(): PhaseGateInput {
  return {
    idea: { title: "长夜灯", genre: "悬疑", coreConflict: "灯下藏凶" },
    worldComplete: true,
    protagonistNamed: true,
    antagonistNamed: true,
    frameworkChosen: true,
    volumesPlanned: true,
    firstChapterReady: true,
  }
}

describe("director-pipeline（吸收自 ANWA services/novel/director 阶段门模式）", () => {
  it("阶段序列固定 5 段；初始 idea=running 其余 pending", () => {
    expect(DIRECTOR_PHASES).toEqual(["idea", "world", "character", "outline", "chapters"])
    const s = createDirectorPipeline()
    expect(s.currentPhase).toBe("idea")
    expect(s.statuses.idea).toBe("running")
    expect(s.statuses.chapters).toBe("pending")
  })

  it("phaseGateOutput 逐阶段出口条件精确校验", () => {
    expect(phaseGateOutput("idea", { ...passingInput(), idea: { title: "", genre: "悬疑", coreConflict: "x" } })).toContain("书名")
    expect(phaseGateOutput("world", { ...passingInput(), worldComplete: false })).toContain("世界骨架")
    expect(phaseGateOutput("character", { ...passingInput(), antagonistNamed: false })).toContain("对手")
    expect(phaseGateOutput("outline", { ...passingInput(), frameworkChosen: false })).toContain("情节框架")
    expect(phaseGateOutput("chapters", { ...passingInput(), firstChapterReady: false })).toContain("首章")
    expect(phaseGateOutput("chapters", passingInput())).toBeNull()
  })

  it("全过门：逐阶段推进至 completed；状态单向 done", () => {
    let state = createDirectorPipeline()
    for (let i = 0; i < DIRECTOR_PHASES.length; i++) {
      const result = advanceDirectorPhase(state, passingInput())
      expect(result.advanced).toBe(true)
      state = result.state
    }
    expect(state.statuses.idea).toBe("done")
    expect(state.statuses.chapters).toBe("done")
  })

  it("末阶段过门 → completed=true", () => {
    let state = createDirectorPipeline()
    for (let i = 0; i < DIRECTOR_PHASES.length - 1; i++) state = advanceDirectorPhase(state, passingInput()).state
    const last = advanceDirectorPhase(state, passingInput())
    expect(last.completed).toBe(true)
  })

  it("未过门 → failed + 重试计数；retryDirectorPhase 回 running 后可再推进", () => {
    let state = createDirectorPipeline()
    const blocked = advanceDirectorPhase(state, { ...passingInput(), idea: { title: "", genre: "悬疑", coreConflict: "x" } })
    expect(blocked.advanced).toBe(false)
    expect(blocked.blockedReason).toContain("书名")
    state = blocked.state
    expect(state.statuses.idea).toBe("failed")
    expect(state.retryCount.idea).toBe(1)

    state = retryDirectorPhase(state)
    expect(state.statuses.idea).toBe("running")

    const retry = advanceDirectorPhase(state, { ...passingInput(), idea: { title: "", genre: "", coreConflict: "x" } })
    expect(retry.state.retryCount.idea).toBe(2)
  })

  it("重试通过后 currentPhase 前移", () => {
    let state = advanceDirectorPhase(
      createDirectorPipeline(),
      { ...passingInput(), idea: { title: "", genre: "", coreConflict: "" } },
    ).state
    expect(state.currentPhase).toBe("idea")
    expect(state.statuses.idea).toBe("failed")
    state = retryDirectorPhase(state)
    const ok = advanceDirectorPhase(state, passingInput())
    expect(ok.advanced).toBe(true)
    expect(ok.state.currentPhase).toBe("world")
    expect(ok.state.statuses.idea).toBe("done")
  })

  it("directorPipelineSummary 渲染全阶段与重试标记", () => {
    const state = advanceDirectorPhase(
      createDirectorPipeline(),
      { ...passingInput(), idea: { title: "", genre: "", coreConflict: "" } },
    ).state
    const summary = directorPipelineSummary(state)
    expect(summary).toContain("导演管线 @ idea")
    expect(summary).toContain("✗ idea")
    expect(summary).toContain("（重试 1）")
  })

  it("确定性：同输入双跑全等", () => {
    const a = advanceDirectorPhase(createDirectorPipeline(), passingInput())
    const b = advanceDirectorPhase(createDirectorPipeline(), passingInput())
    expect(a.advanced).toBe(b.advanced)
    expect(a.state.currentPhase).toBe(b.state.currentPhase)
    expect(JSON.stringify(a.state.statuses)).toBe(JSON.stringify(b.state.statuses))
  })
})
