// @vitest-environment jsdom
/**
 * pipeline-tasks 覆盖 spec（方案 `d23eb1df` P2）。
 *
 * 这里钉死的是**参数校验发生在起任务之前**：非法参数若留下一个注定失败的任务，
 * 调用方会以为"任务起来了、只是失败了"，把参数错误误读成运行时故障。
 *
 * 生成本身不在这里跑——它需要真实模型配置与几分钟时间，属于端到端验收范畴。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const runDeepChapterGeneration = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel", () => ({
  runDeepChapterGeneration,
}))

import { getPipelineTask, resetPipelineTasks, startPipelineTask } from "./pipeline-tasks"

beforeEach(() => {
  resetPipelineTasks()
  runDeepChapterGeneration.mockReset()
})

describe("startPipelineTask 参数校验", () => {
  it("缺 userRequest 直接拒绝", () => {
    const res = startPipelineTask({})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("userRequest")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("空白 userRequest 直接拒绝", () => {
    const res = startPipelineTask({ userRequest: "   " })
    expect(res.ok).toBe(false)
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("非字符串 userRequest 直接拒绝", () => {
    const res = startPipelineTask({ userRequest: 42 })
    expect(res.ok).toBe(false)
  })

  it("chapterNumber 必须是正整数", () => {
    for (const bad of [0, -1, 1.5, "abc", Number.NaN]) {
      const res = startPipelineTask({ userRequest: "写一章", chapterNumber: bad })
      expect(res.ok, `chapterNumber=${String(bad)} 应被拒`).toBe(false)
    }
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("workflowMode 只接受三档", () => {
    const res = startPipelineTask({ userRequest: "写一章", workflowMode: "turbo" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("fast / standard / strict")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })
})

describe("startPipelineTask 前置条件", () => {
  it("没有打开项目时拒绝，且不起任务", () => {
    const res = startPipelineTask({ userRequest: "写一章" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("没有打开的项目")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })
})

describe("getPipelineTask", () => {
  it("未知 taskId 返回 null（调用方据此报未知任务，不猜）", () => {
    expect(getPipelineTask("ptask_nope")).toBeNull()
  })

  it("reset 之后旧 id 查不到", () => {
    resetPipelineTasks()
    expect(getPipelineTask("ptask_anything")).toBeNull()
  })
})
