import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  deleteFile: fsMocks.deleteFile,
  fileExists: fsMocks.fileExists,
  listDirectory: fsMocks.listDirectory,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

const llmMocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: llmMocks.streamChat,
}))

const chapterUtilsMocks = vi.hoisted(() => ({
  extractChapterNumber: vi.fn(),
  findChapterFileByNumber: vi.fn(),
  flattenMdFiles: vi.fn(),
}))

vi.mock("../chapter-utils", () => ({
  extractChapterNumber: chapterUtilsMocks.extractChapterNumber,
  findChapterFileByNumber: chapterUtilsMocks.findChapterFileByNumber,
  flattenMdFiles: chapterUtilsMocks.flattenMdFiles,
}))

const projectMetaMocks = vi.hoisted(() => ({
  loadNovelProjectMeta: vi.fn(),
}))

vi.mock("../project-meta", () => ({
  loadNovelProjectMeta: projectMetaMocks.loadNovelProjectMeta,
}))

const userMemoryMocks = vi.hoisted(() => ({
  buildUserAwareDeAiPrompt: vi.fn(),
  getAvoidWords: vi.fn(),
  hasUserDeAiWeights: vi.fn(),
  loadUserMemoryForProject: vi.fn(),
}))

vi.mock("@/lib/user-memory", () => ({
  buildUserAwareDeAiPrompt: userMemoryMocks.buildUserAwareDeAiPrompt,
  getAvoidWords: userMemoryMocks.getAvoidWords,
  hasUserDeAiWeights: userMemoryMocks.hasUserDeAiWeights,
  loadUserMemoryForProject: userMemoryMocks.loadUserMemoryForProject,
}))

const statusMocks = vi.hoisted(() => ({
  buildNextStatus: vi.fn(),
  loadNovelSessionStatus: vi.fn(),
  saveNovelSessionStatus: vi.fn(),
}))

vi.mock("../novel-session-status", () => ({
  buildNextStatus: statusMocks.buildNextStatus,
  loadNovelSessionStatus: statusMocks.loadNovelSessionStatus,
  saveNovelSessionStatus: statusMocks.saveNovelSessionStatus,
}))

import {
  acceptAllDeAiBatchDrafts,
  acceptDeAiBatchDraft,
  discardDeAiBatch,
  rejectDeAiBatchDraft,
  runDeAiBatch,
} from "./scheduler"
import { DE_AI_BATCH_SCHEMA, type DeAiBatchState } from "./types"

const CHAPTER_1 = "---\nchapter_number: 1\ntitle: 第一章\n---\n\n他不禁深吸一口气，仿佛整个世界都安静了。仿佛时间都停止了，他不禁感到一阵恍惚。"
const CHAPTER_2 = "---\nchapter_number: 2\ntitle: 第二章\n---\n\n第二章正文内容。"

function mockChapterFiles(): void {
  chapterUtilsMocks.extractChapterNumber.mockImplementation((name: string) => {
    const match = name.match(/第(\d+)章/)
    return match ? Number(match[1]) : null
  })
  chapterUtilsMocks.flattenMdFiles.mockImplementation((nodes: any[]) => nodes)
  fsMocks.listDirectory.mockResolvedValue([
    { name: "第1章.md", path: "/p/wiki/chapters/第1章.md", is_dir: false },
    { name: "第2章.md", path: "/p/wiki/chapters/第2章.md", is_dir: false },
  ])
  chapterUtilsMocks.findChapterFileByNumber.mockImplementation(async (_p: string, n: number) =>
    n === 1 ? "/p/wiki/chapters/第1章.md" : n === 2 ? "/p/wiki/chapters/第2章.md" : null,
  )
  fsMocks.readFile.mockImplementation(async (path: string) =>
    path.includes("第1章") ? CHAPTER_1 : path.includes("第2章") ? CHAPTER_2 : "",
  )
}

function mockLlmOk(): void {
  llmMocks.streamChat.mockImplementation(async (_config: any, _messages: any, callbacks: any) => {
    callbacks.onToken("改写后的正文。")
    callbacks.onDone()
  })
}

function mockStatusOk(): void {
  statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed" })
  statusMocks.buildNextStatus.mockImplementation((base: any, overrides: any) => ({ ...base, ...overrides }))
  statusMocks.saveNovelSessionStatus.mockResolvedValue(undefined)
}

function mockUserMemoryEmpty(): void {
  userMemoryMocks.loadUserMemoryForProject.mockResolvedValue({ preferences: [] })
  userMemoryMocks.hasUserDeAiWeights.mockReturnValue(false)
  userMemoryMocks.getAvoidWords.mockReturnValue([])
}

const llmConfig = {
  provider: "openai",
  apiKey: "k",
  model: "m",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 100000,
} as any

describe("de-ai-batch scheduler — runDeAiBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.deleteFile.mockResolvedValue(undefined)
    projectMetaMocks.loadNovelProjectMeta.mockResolvedValue({ genre: "玄幻" })
    mockChapterFiles()
    mockLlmOk()
    mockStatusOk()
    mockUserMemoryEmpty()
  })

  it("全书批量：逐章机械双遍 + LLM 改写 → ready + 草稿工件 + 摘要", async () => {
    const progress: any[] = []
    const summary = await runDeAiBatch("/p", {
      llmConfig,
      onProgress: (p) => progress.push(p),
    })
    expect(summary.schemaVersion).toBe(DE_AI_BATCH_SCHEMA)
    expect(summary.phase).toBe("completed")
    expect(summary.total).toBe(2)
    expect(summary.processed).toBe(2)
    expect(summary.failed).toEqual([])
    expect(summary.skipped).toBe(0)
    expect(summary.durationMs).toBeGreaterThanOrEqual(0)
    // LLM 消息携带 dual-pass fragment（机械检测闭环）
    const messages = llmMocks.streamChat.mock.calls[0][1]
    expect(messages[0].role).toBe("system")
    expect(messages[1].content).toContain("De-AI dual-pass")
    // 草稿工件落盘
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/p/.novel/de-ai-batch-drafts/1.json",
      expect.stringContaining('"candidateContent": "改写后的正文。"'),
    )
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/p/.novel/de-ai-batch-drafts/2.json",
      expect.any(String),
    )
    // 状态持久化（含 de_ai_batch 线穿）
    expect(statusMocks.saveNovelSessionStatus).toHaveBeenCalled()
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.perChapter[1].status).toBe("ready")
    expect(savedState.perChapter[2].status).toBe("ready")
    // 进度回调：最终 completed
    expect(progress[progress.length - 1].phase).toBe("completed")
    expect(progress[progress.length - 1].done).toBe(2)
  })

  it("用户个性化：有权重时 userPrompt 注入 system，避用词进机械检测", async () => {
    userMemoryMocks.hasUserDeAiWeights.mockReturnValue(true)
    userMemoryMocks.buildUserAwareDeAiPrompt.mockReturnValue("个性化规则")
    userMemoryMocks.getAvoidWords.mockReturnValue(["不禁", "仿佛"])
    await runDeAiBatch("/p", { llmConfig })
    const messages = llmMocks.streamChat.mock.calls[0][1]
    expect(messages[0].content).toContain("个性化规则")
    // 避用词命中进 promptFragment（正文含「不禁」？无 → 不强制；验证调用链）
    expect(userMemoryMocks.getAvoidWords).toHaveBeenCalled()
  })

  it("skipCleanChapters：机械干净章节跳过 LLM 改写", async () => {
    // 让第 2 章机械干净：正文无机械腔信号
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.includes("第1章") ? CHAPTER_1 : "---\nchapter_number: 2\ntitle: 第二章\n---\n\n自然流畅的对话。",
    )
    const summary = await runDeAiBatch("/p", { llmConfig, skipCleanChapters: true })
    expect(summary.skipped).toBe(1)
    expect(summary.processed).toBe(1)
    // 只有第 1 章调用了 LLM
    expect(llmMocks.streamChat).toHaveBeenCalledTimes(1)
  })

  it("章节文件缺失 → 单章失败隔离，其余继续", async () => {
    chapterUtilsMocks.findChapterFileByNumber.mockImplementation(async (_p: string, n: number) =>
      n === 1 ? "/p/wiki/chapters/第1章.md" : null,
    )
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.processed).toBe(1)
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0].chapterNumber).toBe(2)
    expect(summary.failed[0].error).toContain("章节文件不存在")
    expect(summary.phase).toBe("completed")
  })

  it("LLM 瞬时错误：退避重试后仍失败 → 记 failed", async () => {
    llmMocks.streamChat.mockImplementation(async (_c: any, _m: any, callbacks: any) => {
      callbacks.onError(new Error("HTTP 429 Too Many Requests"))
    })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.failed).toHaveLength(2)
    expect(summary.failed[0].error).toContain("429")
    // 每章 3 次尝试（1 + 2 重试）
    expect(llmMocks.streamChat).toHaveBeenCalledTimes(6)
  })

  it("LLM 业务错误不重试", async () => {
    llmMocks.streamChat.mockImplementation(async (_c: any, _m: any, callbacks: any) => {
      callbacks.onError(new Error("HTTP 400 bad request"))
    })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.failed).toHaveLength(2)
    expect(llmMocks.streamChat).toHaveBeenCalledTimes(2)
  })

  it("LLM 返回非 Error 错误 → String 兜底记 failed", async () => {
    llmMocks.streamChat.mockImplementation(async (_c: any, _m: any, callbacks: any) => {
      callbacks.onError("boom-string")
    })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.failed).toHaveLength(2)
    expect(summary.failed[0].error).toBe("boom-string")
  })

  it("genre 为空 → resolveGenre 返回 undefined（userPrompt 不带类型）", async () => {
    projectMetaMocks.loadNovelProjectMeta.mockResolvedValue({ genre: "  " })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.processed).toBe(2)
  })

  it("恢复批次中止：failed 章未重跑 → 摘要兜底字段", async () => {
    const existing: DeAiBatchState = {
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-old",
      phase: "paused",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1, draftPath: "/p/.novel/de-ai-batch-drafts/1.json" },
        2: { status: "failed", attempts: 0 },
      },
    }
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: existing })
    const controller = new AbortController()
    controller.abort()
    const summary = await runDeAiBatch("/p", { llmConfig, signal: controller.signal })
    expect(summary.phase).toBe("paused")
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0].error).toBe("未知错误")
    expect(summary.failed[0].retries).toBe(0)
    expect(summary.failed[0].lastAttemptAt).toBeTruthy()
  })

  it("signal 中止 → phase paused，中断章回 pending", async () => {
    const controller = new AbortController()
    llmMocks.streamChat.mockImplementation(async (_c: any, _m: any, callbacks: any) => {
      controller.abort()
      callbacks.onError(new Error("request aborted"))
    })
    const summary = await runDeAiBatch("/p", { llmConfig, signal: controller.signal })
    expect(summary.phase).toBe("paused")
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.perChapter[1].status).toBe("pending")
  })

  it("中止后不再拉取新章（并发 < 章数时后续章不处理）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "第1章.md", path: "/p/wiki/chapters/第1章.md", is_dir: false },
      { name: "第2章.md", path: "/p/wiki/chapters/第2章.md", is_dir: false },
      { name: "第3章.md", path: "/p/wiki/chapters/第3章.md", is_dir: false },
      { name: "第4章.md", path: "/p/wiki/chapters/第4章.md", is_dir: false },
    ])
    chapterUtilsMocks.findChapterFileByNumber.mockImplementation(async (_p: string, n: number) =>
      `/p/wiki/chapters/第${n}章.md`,
    )
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const n = path.match(/第(\d+)章/)?.[1]
      return `---\nchapter_number: ${n}\ntitle: 第${n}章\n---\n\n第${n}章正文。`
    })
    const controller = new AbortController()
    let calls = 0
    llmMocks.streamChat.mockImplementation(async (_c: any, _m: any, callbacks: any) => {
      calls += 1
      if (calls === 1) {
        controller.abort()
        callbacks.onError(new Error("request aborted"))
        return
      }
      callbacks.onToken("改写后的正文。")
      callbacks.onDone()
    })
    const summary = await runDeAiBatch("/p", { llmConfig, concurrency: 2, signal: controller.signal })
    expect(summary.phase).toBe("paused")
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.perChapter[1].status).toBe("pending")
    expect(savedState.perChapter[2].status).toBe("ready")
    // 第 3/4 章：worker 启动时已中止 → 直接返回，未进入 perChapter
    expect(savedState.perChapter[3]).toBeUndefined()
    expect(savedState.perChapter[4]).toBeUndefined()
  })

  it("章节内容为空 → 单章失败隔离，其余继续", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.includes("第1章") ? "   \n  " : CHAPTER_2,
    )
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0].error).toContain("章节内容为空")
    expect(summary.processed).toBe(1)
  })

  it("状态持久化失败 → 吞掉不中断批次", async () => {
    statusMocks.saveNovelSessionStatus.mockRejectedValueOnce(new Error("save-fail"))
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.phase).toBe("completed")
    expect(summary.processed).toBe(2)
  })

  it("断点恢复：ready 跳过、failed 重试", async () => {
    const existing: DeAiBatchState = {
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-old",
      phase: "paused",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1, draftPath: "/p/.novel/de-ai-batch-drafts/1.json" },
        2: { status: "failed", attempts: 2, lastError: "boom" },
      },
    }
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: existing })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.batchId).toBe("de-ai-old") // 保留批次身份
    expect(summary.processed).toBe(2) // 1 ready + 1 重试成功
    expect(summary.failed).toEqual([])
    // 只处理了第 2 章
    expect(llmMocks.streamChat).toHaveBeenCalledTimes(1)
  })

  it("completed 状态 → 新批次", async () => {
    const existing: DeAiBatchState = {
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-old",
      phase: "completed",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {},
    }
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: existing })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.batchId).not.toBe("de-ai-old")
    expect(summary.processed).toBe(2)
  })

  it("显式 chapterNumbers 子集 → 新批次只处理子集", async () => {
    const summary = await runDeAiBatch("/p", { llmConfig, chapterNumbers: [2] })
    expect(summary.total).toBe(1)
    expect(summary.processed).toBe(1)
    expect(llmMocks.streamChat).toHaveBeenCalledTimes(1)
  })

  it("并发上限 clamp：9 → 5，0 → 1", async () => {
    await runDeAiBatch("/p", { llmConfig, concurrency: 9 })
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.concurrency).toBe(5)
    await runDeAiBatch("/p", { llmConfig, concurrency: 0 })
    const calls = statusMocks.buildNextStatus.mock.calls
    const lastCall = calls[calls.length - 1]!
    const savedState2 = lastCall[1].de_ai_batch as DeAiBatchState
    expect(savedState2.concurrency).toBe(1)
  })

  it("无章节 → 抛错", async () => {
    fsMocks.listDirectory.mockResolvedValue([])
    await expect(runDeAiBatch("/p", { llmConfig })).rejects.toThrow("未找到可处理的章节")
  })

  it("全部 ready 的批次重跑 → 直接 completed 不调 LLM", async () => {
    const existing: DeAiBatchState = {
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-old",
      phase: "paused",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1 },
        2: { status: "ready", attempts: 1 },
      },
    }
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: existing })
    const summary = await runDeAiBatch("/p", { llmConfig })
    expect(summary.phase).toBe("completed")
    expect(llmMocks.streamChat).not.toHaveBeenCalled()
  })
})

describe("de-ai-batch scheduler — accept/reject/discard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.writeFile.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.deleteFile.mockResolvedValue(undefined)
    mockStatusOk()
    chapterUtilsMocks.findChapterFileByNumber.mockImplementation(async (_p: string, n: number) =>
      n === 1 ? "/p/wiki/chapters/第1章.md" : null,
    )
  })

  function readyState(): DeAiBatchState {
    return {
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-1",
      phase: "completed",
      concurrency: 3,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      queue: [1, 2],
      perChapter: {
        1: { status: "ready", attempts: 1, draftPath: "/p/.novel/de-ai-batch-drafts/1.json" },
        2: { status: "failed", attempts: 2, lastError: "boom" },
      },
    }
  }

  it("acceptAll：仅 ready 回填（保留 frontmatter），状态 → accepted", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-1",
      chapterNumber: 1,
      sourcePath: "/p/wiki/chapters/第1章.md",
      originalContent: CHAPTER_1,
      candidateContent: "改写后的正文。",
      dualPassScore: 42,
      avoidWordsHits: [],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }))
    const result = await acceptAllDeAiBatchDrafts("/p")
    expect(result).toEqual({ accepted: 1, skipped: 1 })
    // 写回保留 frontmatter + 标题，仅替换正文
    const written = fsMocks.writeFile.mock.calls[0][1] as string
    expect(written).toContain("chapter_number: 1")
    expect(written).toContain("改写后的正文。")
    expect(written).not.toContain("第一章正文内容。")
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.perChapter[1].status).toBe("accepted")
    expect(savedState.perChapter[2].status).toBe("failed")
  })

  it("acceptDeAiBatchDraft 单章：成功返回 true", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-1",
      chapterNumber: 1,
      sourcePath: "/p/wiki/chapters/第1章.md",
      originalContent: CHAPTER_1,
      candidateContent: "改写后的正文。",
      dualPassScore: 42,
      avoidWordsHits: [],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }))
    expect(await acceptDeAiBatchDraft("/p", 1)).toBe(true)
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  it("acceptDeAiBatchDraft 非 ready：返回 false 不写回", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    expect(await acceptDeAiBatchDraft("/p", 2)).toBe(false)
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("acceptAll：ready 但草稿工件缺失 → skipped", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    fsMocks.readFile.mockRejectedValue(new Error("no draft"))
    const result = await acceptAllDeAiBatchDrafts("/p")
    expect(result).toEqual({ accepted: 0, skipped: 2 })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("acceptAll：ready + 工件在但章节文件缺失 → skipped", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: DE_AI_BATCH_SCHEMA,
      batchId: "de-ai-1",
      chapterNumber: 1,
      sourcePath: "/p/wiki/chapters/第1章.md",
      originalContent: CHAPTER_1,
      candidateContent: "改写后的正文。",
      dualPassScore: 42,
      avoidWordsHits: [],
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }))
    chapterUtilsMocks.findChapterFileByNumber.mockResolvedValue(null)
    const result = await acceptAllDeAiBatchDrafts("/p")
    expect(result).toEqual({ accepted: 0, skipped: 2 })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("rejectDeAiBatchDraft：ready → rejected（不删工件）", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    expect(await rejectDeAiBatchDraft("/p", 1)).toBe(true)
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.perChapter[1].status).toBe("rejected")
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("rejectDeAiBatchDraft 非 ready：返回 false", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    expect(await rejectDeAiBatchDraft("/p", 2)).toBe(false)
  })

  it("discardDeAiBatch：清状态 + 删草稿工件", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue({ status: "completed", de_ai_batch: readyState() })
    expect(await discardDeAiBatch("/p")).toBe(true)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/p/.novel/de-ai-batch-drafts/1.json")
    const savedState = statusMocks.buildNextStatus.mock.calls[0][1].de_ai_batch as DeAiBatchState
    expect(savedState.phase).toBe("idle")
    expect(savedState.perChapter).toEqual({})
  })

  it("无批次状态：accept/reject/discard 均返回空结果", async () => {
    statusMocks.loadNovelSessionStatus.mockResolvedValue(null)
    expect(await acceptAllDeAiBatchDrafts("/p")).toEqual({ accepted: 0, skipped: 0 })
    expect(await acceptDeAiBatchDraft("/p", 1)).toBe(false)
    expect(await rejectDeAiBatchDraft("/p", 1)).toBe(false)
    expect(await discardDeAiBatch("/p")).toBe(false)
  })
})
