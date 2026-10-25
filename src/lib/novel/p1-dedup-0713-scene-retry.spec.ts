import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  SCENE_BREAKDOWN_MAX_ATTEMPTS,
  isSceneBreakdownCheckpointComplete,
  runSceneBreakdownStage,
} from "@/lib/novel/deep-chapter-context-assembly"
import type { DeepChapterGenerationResumeCheckpoint } from "@/lib/novel/deep-chapter-generation"

const mocks = vi.hoisted(() => ({
  runSceneBreakdown: vi.fn(),
  persistDraft: vi.fn(),
  appendMetric: vi.fn(),
}))

vi.mock("@/lib/novel/scene-breakdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/scene-breakdown")>()
  return {
    ...actual,
    runSceneBreakdown: mocks.runSceneBreakdown,
    persistSceneBreakdownDraft: mocks.persistDraft,
  }
})

vi.mock("@/lib/novel/novel-session-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/novel-session-status")>()
  return {
    ...actual,
    appendStageMetric: mocks.appendMetric,
  }
})

function checkpoint(stage: DeepChapterGenerationResumeCheckpoint["stage"]): DeepChapterGenerationResumeCheckpoint {
  return {
    version: 1,
    originalRequest: "req",
    chapterNumber: 3,
    stage,
  }
}

const novelConfigOn = { sceneBreakdownEnabled: true } as never
const novelConfigOff = { sceneBreakdownEnabled: false } as never
const contextPack = {} as never
const callbacks = { onThinking: vi.fn(), onCheckpoint: vi.fn() } as never
const input = { userRequest: "blueprint", projectPath: "C:/p", chapterNumber: 3 } as never

/**
 * ISS-20260713-009：resume 不 retry 改 retry 失败 scene。
 */
describe("ISS-20260713-009 scene breakdown retry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("重试上限为 2（含首次）", () => {
    expect(SCENE_BREAKDOWN_MAX_ATTEMPTS).toBe(2)
  })

  it("仅 after_scene_breakdown 及之后才算完成（未过则重试）", () => {
    expect(isSceneBreakdownCheckpointComplete(undefined)).toBe(false)
    expect(isSceneBreakdownCheckpointComplete(checkpoint("after_context"))).toBe(false)
    expect(isSceneBreakdownCheckpointComplete(checkpoint("after_scene_breakdown"))).toBe(true)
    expect(isSceneBreakdownCheckpointComplete(checkpoint("after_task_brief"))).toBe(true)
  })

  it("disabled 直接跳过（不调用 LLM）", async () => {
    await runSceneBreakdownStage(input, novelConfigOff, undefined, contextPack, callbacks, undefined, () => {})
    expect(mocks.runSceneBreakdown).not.toHaveBeenCalled()
  })

  it("已完成 checkpoint 跳过（不重复拆解）", async () => {
    await runSceneBreakdownStage(input, novelConfigOn, checkpoint("after_scene_breakdown"), contextPack, callbacks, undefined, () => {})
    expect(mocks.runSceneBreakdown).not.toHaveBeenCalled()
  })

  it("未完成 resume 不再整体跳过：失败一次后重试成功", async () => {
    mocks.runSceneBreakdown
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ scenes: [{ sceneId: "scene-1" }], latencyMs: 1 })
    await runSceneBreakdownStage(input, novelConfigOn, checkpoint("after_context"), contextPack, callbacks, undefined, () => {})
    expect(mocks.runSceneBreakdown).toHaveBeenCalledTimes(2)
    expect(mocks.persistDraft).toHaveBeenCalledTimes(1)
  })

  it("全失败仍非阻断（记日志后继续，不抛错）", async () => {
    mocks.runSceneBreakdown.mockRejectedValue(new Error("down"))
    await expect(
      runSceneBreakdownStage(input, novelConfigOn, undefined, contextPack, callbacks, undefined, () => {}),
    ).resolves.toBeUndefined()
    expect(mocks.runSceneBreakdown).toHaveBeenCalledTimes(2)
    expect(mocks.persistDraft).not.toHaveBeenCalled()
  })
});
