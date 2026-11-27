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

  it("纯内存跟踪 deepSavedDraftId 与 deepAutoSaveError：按 output 引用防串台、同项目切页保活、重启/清零/换项目复位", () => {
    const store = useMainControlRuntimeStore.getState()
    const controller1 = new AbortController()
    const out1 = makeOutput("第1轮深章正文")
    const outStale = makeOutput("过期深章正文")

    store.beginDeepRun({ projectPath: "/proj-a", chapterNumber: 4, controller: controller1, startedAt: 1000 })
    store.finishDeepRunSuccess(controller1, out1)
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()

    // 过期 output 引用不得污染当前运行态
    store.markDeepAutoSaveError(outStale, "过期错误")
    store.markDeepDraftSaved(outStale, "draft_stale")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()

    // 当前 output 自动存草稿失败 → 记录错误供重试
    store.markDeepAutoSaveError(out1, "磁盘满")
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBe("磁盘满")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()

    // 重试保存成功 → 锁定 deepSavedDraftId 并清空错误，后续错误不得覆盖已保存状态
    store.markDeepDraftSaved(out1, "draft_saved_4")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBe("draft_saved_4")
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()
    store.markDeepAutoSaveError(out1, "迟到错误")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBe("draft_saved_4")
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()

    // 同项目 syncProject 保活已保存 ID（防止切页回来重复存草稿）
    store.syncProject("/proj-a/")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBe("draft_saved_4")

    // clearDeepOutput 复位
    store.clearDeepOutput()
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()

    // 新一轮 beginDeepRun 复位
    const controller2 = new AbortController()
    const out2 = makeOutput("第2轮深章正文")
    store.beginDeepRun({ projectPath: "/proj-a", chapterNumber: 5, controller: controller2 })
    store.finishDeepRunSuccess(controller2, out2)
    store.markDeepDraftSaved(out2, "draft_saved_5")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBe("draft_saved_5")

    const controller3 = new AbortController()
    store.beginDeepRun({ projectPath: "/proj-a", chapterNumber: 6, controller: controller3 })
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()

    // 切换项目复位
    store.finishDeepRunSuccess(controller3, makeOutput("第6章"))
    store.markDeepDraftSaved(useMainControlRuntimeStore.getState().deepOutput!, "draft_saved_6")
    store.syncProject("/proj-b")
    expect(useMainControlRuntimeStore.getState().deepSavedDraftId).toBeNull()
    expect(useMainControlRuntimeStore.getState().deepAutoSaveError).toBeNull()
  })

  it("REV2-LOW-05：冷启动 syncProject('' -> projectPath) 保留 pendingLaunchDialog，切项目或关闭项目时清零", () => {
    const store = useMainControlRuntimeStore.getState()
    expect(store.projectPath).toBe("")

    // 冷启动前由 Ctrl+K 请求打开长程战役弹窗 -> 首次 syncProject 绑定项目不得冲掉待消费弹窗
    store.requestLaunchDialog("campaign")
    store.syncProject("C:\\BookA\\")
    expect(useMainControlRuntimeStore.getState().projectPath).toBe("C:/BookA")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBe("campaign")
    expect(useMainControlRuntimeStore.getState().consumePendingLaunchDialog()).toBe("campaign")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()

    // 同项目再次 syncProject 仍保留待消费弹窗
    store.requestLaunchDialog("incubator")
    store.syncProject("C:/BookA")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBe("incubator")

    // 切换到不同项目 -> 立即清零，杜绝跨项目弹窗串台
    store.syncProject("/proj-b")
    expect(useMainControlRuntimeStore.getState().projectPath).toBe("/proj-b")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()

    // 关闭项目（projectPath -> ''）-> 清零
    store.requestLaunchDialog("campaign")
    store.syncProject("")
    expect(useMainControlRuntimeStore.getState().projectPath).toBe("")
    expect(useMainControlRuntimeStore.getState().pendingLaunchDialog).toBeNull()
  })
})
