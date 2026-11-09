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
// `./draft-actions` 自身 import 了被上面整模块 mock 掉的 `@/lib/novel`（`writeDraft` 等），
// 不整模块替换就会让真实实现里的 `writeDraft` 变 undefined：成功用例会由 done 翻成 failed。
const writeChapterDraft = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel", () => ({
  runDeepChapterGeneration,
}))

vi.mock("./draft-actions", () => ({ writeChapterDraft }))

import { getPipelineTask, resetPipelineTasks, startDirectorAdvanceTask, startOutlineGenerationTask, startPipelineBatch, startPipelineTask } from "./pipeline-tasks"

/** 草稿序号：每次落盘递增，用来让相邻用例拿到不同的 draftId/path。 */
let draftSeq = 0

beforeEach(() => {
  resetPipelineTasks()
  runDeepChapterGeneration.mockReset()
  draftSeq = 0
  writeChapterDraft.mockReset()
  // 默认成功实现：返回形状与 draft-actions 的 ChapterDraftResult 一致（draftId/chapterName/path/chars/note），
  // 因此既有成功用例拿到的 draft.path 永不为 undefined。需要抛错的用例自行覆盖。
  writeChapterDraft.mockImplementation(
    async (projectPath: string, params: { chapterName?: unknown; content?: unknown }) => {
      draftSeq += 1
      return {
        draftId: `draft_${draftSeq}`,
        chapterName: String(params.chapterName ?? ""),
        path: `${projectPath}/.qm-drafts/draft_${draftSeq}.md`,
        chars: String(params.content ?? "").length,
        note: "",
      }
    },
  )
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

describe("一窗口全流程：批量与编排任务的参数门", () => {
  it("批量空数组 / 超上限 / 坏的成员一律整批拒绝，且不起任何任务", () => {
    setWiki("/proj", "test-key")
    const empty = startPipelineBatch({ requests: [] })
    expect(empty.ok).toBe(false)

    const tooMany = startPipelineBatch({
      requests: Array.from({ length: 11 }, (_, i) => ({ userRequest: `第${i}章` })),
    })
    expect(tooMany.ok).toBe(false)

    const badMember = startPipelineBatch({
      requests: [{ userRequest: "好的" }, { userRequest: "   " }],
    })
    expect(badMember.ok).toBe(false)
    if (!badMember.ok) expect(badMember.error).toContain("requests[1]")

    // 校验失败必须一个任务都不留（否则调用方要去清理半批任务）。
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
    setWiki(null, null)
  })

  it("批量未打开项目时整批拒绝", () => {
    const res = startPipelineBatch({ requests: [{ userRequest: "写一章" }] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("没有打开的项目")
    expect(runDeepChapterGeneration).not.toHaveBeenCalled()
  })

  it("批量成功时每章一个 taskId，且都进同一张登记表", async () => {
    setWiki("/proj", "test-key")
    runDeepChapterGeneration.mockImplementation(() => new Promise(() => {}))
    const res = startPipelineBatch({
      requests: [{ userRequest: "写第1章", chapterNumber: 1 }, { userRequest: "写第2章", chapterNumber: 2 }],
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.started).toBe(2)
      expect(res.tasks.map((t) => t.chapterNumber)).toEqual([1, 2])
      for (const task of res.tasks) {
        expect(getPipelineTask(task.taskId)?.kind).toBe("chapter")
      }
    }
    setWiki(null, null)
  })

  it("导演推进：maxPhases 越界 / 未打开项目 / 缺模型都在起任务前拒绝", () => {
    expect(startDirectorAdvanceTask({ maxPhases: 0 }).ok).toBe(false)
    expect(startDirectorAdvanceTask({ maxPhases: 9 }).ok).toBe(false)
    expect(startDirectorAdvanceTask({ targetVolumes: 99 }).ok).toBe(false)

    const noProject = startDirectorAdvanceTask({})
    expect(noProject.ok).toBe(false)
    if (!noProject.ok) expect(noProject.error).toContain("没有打开的项目")

    setWiki("/proj", null)
    const noKey = startDirectorAdvanceTask({})
    expect(noKey.ok).toBe(false)
    if (!noKey.ok) expect(noKey.error).toContain("apiKey")
    setWiki(null, null)
  })

  it("大纲生成：缺 prompt / 未打开项目 / 缺模型都在起任务前拒绝", () => {
    const noPrompt = startOutlineGenerationTask({ prompt: "  " })
    expect(noPrompt.ok).toBe(false)
    if (!noPrompt.ok) expect(noPrompt.error).toContain("prompt")

    const noProject = startOutlineGenerationTask({ prompt: "三卷仙侠" })
    expect(noProject.ok).toBe(false)
    if (!noProject.ok) expect(noProject.error).toContain("没有打开的项目")

    setWiki("/proj", null)
    const noKey = startOutlineGenerationTask({ prompt: "三卷仙侠" })
    expect(noKey.ok).toBe(false)
    if (!noKey.ok) expect(noKey.error).toContain("apiKey")
    setWiki(null, null)
  })
})

// ===== DEBT-20261108-01：workflowMode 必须落到管线真实在读的开关 =====
describe("startPipelineTask 的 workflowMode 深度映射", () => {
  beforeEach(() => {
    setWiki("/proj", "test-key")
  })

  afterEach(() => {
    setWiki(null, null)
    wikiState.novelConfig = {}
  })

  it("fast 关闭共识写作/审查与门控后文学打磨", async () => {
    wikiState.novelConfig = { consensusEnabled: true, literaryPolishAfterGate: true }
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    const res = startPipelineTask({ userRequest: "写一章", workflowMode: "fast" })
    expect(res.ok).toBe(true)
    const input = runDeepChapterGeneration.mock.calls[0][0] as { novelConfig: Record<string, unknown> }
    expect(input.novelConfig).toMatchObject({ consensusEnabled: false, literaryPolishAfterGate: false })
    await flushPipeline()
    await flushPipeline()
  })

  it("strict 打开两处加厚阶段", async () => {
    wikiState.novelConfig = { consensusEnabled: false, literaryPolishAfterGate: false }
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    startPipelineTask({ userRequest: "写一章", workflowMode: "strict" })
    const input = runDeepChapterGeneration.mock.calls[0][0] as { novelConfig: Record<string, unknown> }
    expect(input.novelConfig).toMatchObject({ consensusEnabled: true, literaryPolishAfterGate: true })
    await flushPipeline()
    await flushPipeline()
  })

  it("未传档位时原配置引用直通（零行为变更）", async () => {
    const original = { consensusEnabled: true, literaryPolishAfterGate: false }
    wikiState.novelConfig = original
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    startPipelineTask({ userRequest: "写一章" })
    const input = runDeepChapterGeneration.mock.calls[0][0] as { novelConfig: Record<string, unknown> }
    expect(input.novelConfig).toBe(original)
    await flushPipeline()
    await flushPipeline()
  })

  it("standard 档位等价于未传（仍按应用设置）", async () => {
    const original = { consensusEnabled: false, literaryPolishAfterGate: true }
    wikiState.novelConfig = original
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    startPipelineTask({ userRequest: "写一章", workflowMode: "standard" })
    const input = runDeepChapterGeneration.mock.calls[0][0] as { novelConfig: Record<string, unknown> }
    expect(input.novelConfig).toBe(original)
    await flushPipeline()
    await flushPipeline()
  })
})

// ===== G1：成品正文落 .qm-drafts 草稿并由 artifactPath 指回 =====
// 落盘闸门只有「有没有可采纳正文」一条：非空 finalContent（partial 部分稿同样算）落一次草稿；
// partial 的终态仍是既有 status=done + partial:true，靠 gates/manualReviewRequired 表达「需人工复核」。
describe("startPipelineTask 落草稿（G1）", () => {
  beforeEach(() => {
    setWiki("/proj", "test-key")
  })

  afterEach(() => {
    setWiki(null, null)
  })

  it("C1-1 非 partial 非空稿：写一次草稿并回填 artifactPath", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文内容")))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    expect(writeChapterDraft).toHaveBeenCalledTimes(1)
    expect(writeChapterDraft.mock.calls[0][0]).toBe("/proj")
    expect(writeChapterDraft.mock.calls[0][1]).toEqual({ chapterName: "第3章", content: "正文内容" })
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({
      status: "done",
      stage: "done",
      artifactPath: "/proj/.qm-drafts/draft_1.md",
      contentChars: 4,
    })
    expect(snap?.gates?.overall).toBe("pass")
  })

  it("C1-2 空稿不落草稿、如实失败", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("   ")))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    // 默认成功实现仍挂在 beforeEach 里：这里证明的是「没被调用」而不是「没配」。
    expect(writeChapterDraft).not.toHaveBeenCalled()
    const snap = getPipelineTask(res.taskId)
    expect(snap?.status).toBe("failed")
    expect(snap?.artifactPath).toBeUndefined()
    expect(snap?.error).toContain("为空")
    expect(snap?.error).toContain("未写草稿")
    expect(snap?.partial).toBe(false)
    expect(snap?.contentChars).toBe(3)
    expect(snap?.gates?.overall).toBe("pass")
  })

  it("C1-3 partial 且正文非空：仍落一次草稿，status=done + partial:true（需人工复核）", async () => {
    const partialResult: DeepChapterGenerationResult = {
      ...fakeDoneResult("正文"),
      partial: true,
      partialReason: "transport-inactivity",
    }
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(partialResult))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    expect(writeChapterDraft).toHaveBeenCalledTimes(1)
    expect(writeChapterDraft.mock.calls[0][0]).toBe("/proj")
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({
      status: "done",
      stage: "done",
      partial: true,
      // 管线报的是 false，快照原样保留（本任务不改 manualReviewRequired 的取值来源）。
      manualReviewRequired: false,
      artifactPath: "/proj/.qm-drafts/draft_1.md",
      contentChars: 2,
    })
    expect(snap?.gates?.overall).toBe("pass")
    expect(snap?.error).toBeUndefined()
    expect(JSON.stringify(snap)).not.toContain("正文")
  })

  it("C1-4 写盘抛错如实失败（不虚报 done）", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    writeChapterDraft.mockImplementation(() => Promise.reject(new Error("EACCES: 落盘失败")))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({ status: "failed", error: "EACCES: 落盘失败" })
    expect(snap?.artifactPath).toBeUndefined()
    expect(snap?.gates?.overall).toBe("pass")
    expect(snap?.partial).toBe(false)
  })

  it("C1-5 无 chapterNumber 时用 userRequest 前 40 字作 chapterName", async () => {
    const longRequest = "续".repeat(60)
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    const res = startPipelineTask({ userRequest: longRequest })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    expect(writeChapterDraft).toHaveBeenCalledTimes(1)
    const params = writeChapterDraft.mock.calls[0][1] as { chapterName: string }
    expect(params.chapterName.length).toBe(40)
    expect(params.chapterName).toBe(longRequest.slice(0, 40))
  })

  it("C1-6 同一章号的两个任务各自落一次（不做跨任务去重）", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("正文")))
    const first = startPipelineTask({ userRequest: "写第七章", chapterNumber: 7 })
    const second = startPipelineTask({ userRequest: "再写第七章", chapterNumber: 7 })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    await flushPipeline()
    await flushPipeline()
    expect(writeChapterDraft).toHaveBeenCalledTimes(2)
    expect(getPipelineTask(first.taskId)?.artifactPath).toBe("/proj/.qm-drafts/draft_1.md")
    expect(getPipelineTask(second.taskId)?.artifactPath).toBe("/proj/.qm-drafts/draft_2.md")
  })

  it("C1-7 快照不含正文（正文不塞 status）", async () => {
    runDeepChapterGeneration.mockImplementation(() => Promise.resolve(fakeDoneResult("UNIQUE_BODY_MARKER")))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    const snap = getPipelineTask(res.taskId)
    expect(JSON.stringify(snap)).not.toContain("UNIQUE_BODY_MARKER")
    expect(snap).not.toHaveProperty("content")
  })

  it("C1-8 管线取消 / 中途 reject 如实失败，不落草稿、不产生 artifactPath", async () => {
    // USER_ABORT_MESSAGE：用户取消路径与任意取消类 reject 走同一个 catch 分支。
    runDeepChapterGeneration.mockRejectedValue(new Error("已停止生成"))
    const res = startPipelineTask({ userRequest: "写第三章", chapterNumber: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    await flushPipeline()
    await flushPipeline()
    const snap = getPipelineTask(res.taskId)
    expect(snap).toMatchObject({ status: "failed", stage: "failed", error: "已停止生成" })
    expect(snap?.artifactPath).toBeUndefined()
    expect(snap?.finishedAt).toBeGreaterThan(0)
    expect(writeChapterDraft).not.toHaveBeenCalled()
  })
})
