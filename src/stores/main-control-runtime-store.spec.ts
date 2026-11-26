import { afterEach, describe, expect, it } from "vitest"
import type { DeepChapterGenerationResult } from "@/lib/novel"
import { useMainControlRuntimeStore } from "./main-control-runtime-store"

function makeOutput(finalContent = "第3章正文内容"): DeepChapterGenerationResult {
  return {
    finalContent,
    taskBrief: "任务书",
    draftContent: finalContent,
    reviewResults: [],
    revised: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    manualReviewRequired: false,
    finalConsistencyReviewed: true,
    decisionGates: {
      overall: "pass",
      consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
      quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
    },
  }
}

afterEach(() => {
  useMainControlRuntimeStore.getState().reset()
})

describe("useMainControlRuntimeStore（纯内存保活与项目切换清理）", () => {
  it("同项目再次 syncProject 保留运行态与产出（切页保活）", () => {
    const store = useMainControlRuntimeStore.getState()
    const controller = new AbortController()
    store.beginDeepRun({ projectPath: "C:\\BookA\\", chapterNumber: 3, controller, startedAt: 1000 })
    store.appendDeepActivity(controller, {
      id: "act-1",
      stageId: "main_control_deep_chapter",
      kind: "stage_output",
      title: "深章阶段",
      content: "正在构思",
      timestamp: 1005,
    })
    store.finishDeepRunSuccess(controller, makeOutput("保活正文"))

    // 路径归一化等价 → 不清零
    useMainControlRuntimeStore.getState().syncProject("C:/BookA")
    const state = useMainControlRuntimeStore.getState()
    expect(state.deepRunning).toBe(false)
    expect(state.deepOutput?.finalContent).toBe("保活正文")
    expect(state.deepChapterNumber).toBe(3)
    expect(state.deepActivities).toHaveLength(1)
  })

  it("切换项目时立即 abort 旧句柄并清零全部运行态，迟到回调不得污染新项目", () => {
    const controller = new AbortController()
    useMainControlRuntimeStore.getState().beginDeepRun({
      projectPath: "/proj-a",
      chapterNumber: 5,
      controller,
      startedAt: 2000,
    })
    expect(controller.signal.aborted).toBe(false)

    // 切换到新项目 → 立刻中止旧任务并清零
    useMainControlRuntimeStore.getState().syncProject("/proj-b")
    expect(controller.signal.aborted).toBe(true)
    const afterSwitch = useMainControlRuntimeStore.getState()
    expect(afterSwitch.projectPath).toBe("/proj-b")
    expect(afterSwitch.deepRunning).toBe(false)
    expect(afterSwitch.deepOutput).toBeNull()
    expect(afterSwitch.deepActivities).toEqual([])

    // 旧句柄迟到回调必须被忽略
    afterSwitch.appendDeepActivity(controller, {
      id: "stale-act",
      stageId: "main_control_deep_chapter",
      kind: "stage_output",
      title: "旧项目事件",
      content: "不应写入",
      timestamp: 3000,
    })
    afterSwitch.finishDeepRunSuccess(controller, makeOutput("旧项目正文"))
    afterSwitch.finishDeepRunError(controller, "旧项目错误")
    const finalState = useMainControlRuntimeStore.getState()
    expect(finalState.deepOutput).toBeNull()
    expect(finalState.deepError).toBeNull()
    expect(finalState.deepActivities).toEqual([])
  })

  it("abortDeepRun 触发中止并记录 cancelledAt", () => {
    const controller = new AbortController()
    useMainControlRuntimeStore.getState().beginDeepRun({
      projectPath: "/proj-a",
      controller,
      startedAt: 1000,
    })
    useMainControlRuntimeStore.getState().abortDeepRun(5555)
    expect(controller.signal.aborted).toBe(true)
    const state = useMainControlRuntimeStore.getState()
    expect(state.deepRunning).toBe(false)
    expect(state.deepCancelledAt).toBe(5555)
    expect(state.deepAbortController).toBeNull()
  })
})
