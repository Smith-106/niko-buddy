// @vitest-environment jsdom
/**
 * pipeline-tasks 覆盖 spec（方案 `d23eb1df` P2）。
 *
 * 这里钉死的是**参数校验发生在起任务之前**：非法参数若留下一个注定失败的任务，
 * 调用方会以为"任务起来了、只是失败了"，把参数错误误读成运行时故障。
 *
 * 生成本身不在这里跑——它需要真实模型配置与几分钟时间，属于端到端验收范畴。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

// ===== 增补：成功路径 / 完成与失败快照 / 上限裁剪（覆盖 nextTaskId、pruneIfNeeded、
// 章号规整、apiKey 门禁、任务创建与 onCheckpoint/then/catch 全链路）=====
import type { DeepChapterGenerationResult } from "@/lib/novel"

/** 受控 wiki store：默认无项目无 key，各用例按需打开；跑完必须归零。 */
const wikiState = vi.hoisted(() => ({
  project: null as { path: string } | null,
  llmConfig: null as { apiKey: string } | null,
  novelConfig: {} as Record<string, unknown>,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => wikiState },
}))

function setWiki(projectPath: string | null, apiKey: string | null) {
  wikiState.project = projectPath ? { path: projectPath } : null
  wikiState.llmConfig = apiKey ? { apiKey } : null
}

function fakeDoneResult(finalContent: string): DeepChapterGenerationResult {
  const gate = {
    status: "passed" as const,
    verdict: "pass" as const,
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
  }
  return {
    finalContent,
    taskBrief: "brief",
    draftContent: "draft",
    reviewResults: [],
    revised: false,
    decisionGates: {
      consistency: gate,
      anti_ai: gate,
      quality: gate,
      overall: "pass" as const,
    },
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
  }
}

const flushPipeline = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("startPipelineTask 成功路径与快照（增补）", () => {
  beforeEach(() => {
    setWiki("/proj", "test-key")
  })

  afterEach(() => {
    setWiki(null, null)
  })

  it("数字字符串 chapterNumber 被规整为数字并透传给管线", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    const res = startPipelineTask({ userRequest: "写一章", chapterNumber: "3" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.taskId.startsWith("ptask_")).toBe(true)
    expect(res.stage).toBe("queued")
    expect(runDeepChapterGeneration).toHaveBeenCalledTimes(1)
    expect(runDeepChapterGeneration.mock.calls[0][0]).toMatchObject({
      projectPath: "/proj",
      userRequest: "写一章",
      chapterNumber: 3,
    })
    await flushPipeline()
    await flushPipeline()
    expect(getPipelineTask(res.taskId)?.status).toBe("done")
  })

  it("缺 apiKey 时拒绝且不起任务", () => {
    setWiki("/proj", null)
    const res = startPipelineTask({ userRequest: "写一章" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("apiKey")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("onCheckpoint 推进 stage；完成后快照含门控结论与字数", async () => {
    runDeepChapterGeneration.mockImplementation((_input, hooks) => {
      hooks.onCheckpoint?.({ stage: "after_draft" })
      return Promise.resolve(fakeDoneResult("abcdef"))
    })
    const res = startPipelineTask({ userRequest: "写一章" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(getPipelineTask(res.taskId)).toMatchObject({ status: "running", stage: "after_draft" })
    await flushPipeline()
    await flushPipeline()
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({
      taskId: res.taskId,
      status: "done",
      stage: "done",
      manualReviewRequired: false,
      partial: false,
      contentChars: 6,
    })
    expect(snap?.finishedAt).toBeGreaterThan(0)
    expect(snap?.gates?.overall).toBe("pass")
  })

  it("管线抛错时快照 failed 并保留可读错误", async () => {
    runDeepChapterGeneration.mockRejectedValue(new Error("模型挂了"))
    const res = startPipelineTask({ userRequest: "写一章" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({ status: "failed", stage: "failed", error: "模型挂了" })
    expect(snap?.finishedAt).toBeGreaterThan(0)
  })

  it("超过上限时丢最旧已完成任务，运行中任务永不丢", async () => {
    let releaseFirst!: (v: DeepChapterGenerationResult) => void
    runDeepChapterGeneration
      .mockImplementationOnce(
        () =>
          new Promise<DeepChapterGenerationResult>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockImplementation(() => Promise.resolve(fakeDoneResult("x")))
    const first = startPipelineTask({ userRequest: "first" })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const doneIds: string[] = []
    for (let i = 0; i < 32; i++) {
      const r = startPipelineTask({ userRequest: `t${i}` })
      if (!r.ok) throw new Error("unexpected reject")
      doneIds.push(r.taskId)
      await flushPipeline()
      await flushPipeline()
    }
    const last = startPipelineTask({ userRequest: "last" })
    if (!last.ok) throw new Error("unexpected reject")
    await flushPipeline()
    await flushPipeline()
    // 33 个已完成 + 1 个运行中 → 裁掉最旧的 2 个已完成，运行中的 first 还在。
    expect(getPipelineTask(first.taskId)?.status).toBe("running")
    expect(getPipelineTask(doneIds[0])).toBeNull()
    expect(getPipelineTask(doneIds[1])).toBeNull()
    expect(getPipelineTask(doneIds[2])?.status).toBe("done")
    expect(getPipelineTask(last.taskId)?.status).toBe("done")
    releaseFirst(fakeDoneResult("first-done"))
    await flushPipeline()
    await flushPipeline()
    expect(getPipelineTask(first.taskId)?.status).toBe("done")
  })
})
