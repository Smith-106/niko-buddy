/**
 * runChatEditMode — 章节修改模式分支的直接契约（chat-panel 拆分 T4）。
 * novel barrel / fs / streamChat / project-refresh / 选中文件写入全部 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { runChatEditMode, type ChatEditModeContext } from "./chat-panel-edit-mode"

const mocks = vi.hoisted(() => ({
  resolveChatEditTarget: vi.fn(),
  readSelectedChapterNumberForFile: vi.fn(),
  findChapterFileByNumber: vi.fn(),
  validateStructuredChapterEditResult: vi.fn(),
  normalizeChapterEditFile: vi.fn(),
  backupChapterFile: vi.fn(),
  appendChapterWorkspaceSnapshot: vi.fn(),
  invalidateChapterCache: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  streamChat: vi.fn(),
  resolveUserVisibleReasoning: vi.fn(() => "reasoning"),
  refreshProjectState: vi.fn(),
  setSelectedFile: vi.fn(),
}))

vi.mock("@/lib/novel", () => ({
  resolveChatEditTarget: mocks.resolveChatEditTarget,
  readSelectedChapterNumberForFile: mocks.readSelectedChapterNumberForFile,
  findChapterFileByNumber: mocks.findChapterFileByNumber,
  validateStructuredChapterEditResult: mocks.validateStructuredChapterEditResult,
  normalizeChapterEditFile: mocks.normalizeChapterEditFile,
  backupChapterFile: mocks.backupChapterFile,
  appendChapterWorkspaceSnapshot: mocks.appendChapterWorkspaceSnapshot,
  invalidateChapterCache: mocks.invalidateChapterCache,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChat,
}))

vi.mock("@/lib/user-visible-reasoning", () => ({
  resolveUserVisibleReasoning: mocks.resolveUserVisibleReasoning,
}))

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: mocks.refreshProjectState,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ setSelectedFile: mocks.setSelectedFile }),
  },
}))

const LLM_CONFIG: LlmConfig = {
  provider: "custom",
  model: "deepseek-v3",
  customEndpoint: "https://api.deepseek.com",
  ollamaUrl: "",
  maxContextSize: 120000,
  apiKey: "key",
  apiMode: "chat_completions",
}

function makeCtx(overrides: Partial<ChatEditModeContext> = {}): {
  ctx: ChatEditModeContext
  finalizeStream: ReturnType<typeof vi.fn>
  appendStreamToken: ReturnType<typeof vi.fn>
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
} {
  const finalizeStream = vi.fn()
  const appendStreamToken = vi.fn()
  const abortControllersRef = { current: {} as Record<string, AbortController> }
  const activeStreamSessionsRef = { current: { "conv-1": 7 } as Record<string, number> }
  const ctx: ChatEditModeContext = {
    text: "把第3章改成更紧凑",
    capturedConvId: "conv-1",
    sessionId: 7,
    pp: "D:/novel",
    selectedFile: "D:/novel/第3章.md",
    effectiveChatLlmConfig: LLM_CONFIG,
    finalizeStream,
    appendStreamToken,
    abortControllersRef,
    activeStreamSessionsRef,
    streamSessionGuardRef: {
      current: {
        start: vi.fn(),
        isActive: () => true,
        runIfActive: (_conversationId: string, _sessionId: number, callback: () => void) => callback(),
        finish: vi.fn(),
        stop: vi.fn(),
      },
    },
    ...overrides,
  }
  return { ctx, finalizeStream, appendStreamToken, abortControllersRef, activeStreamSessionsRef }
}

describe("runChatEditMode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveUserVisibleReasoning.mockReturnValue("reasoning")
    mocks.readSelectedChapterNumberForFile.mockResolvedValue(3)
    mocks.backupChapterFile.mockResolvedValue(undefined)
    mocks.appendChapterWorkspaceSnapshot.mockResolvedValue(undefined)
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.refreshProjectState.mockResolvedValue(undefined)
  })

  it("目标解析失败：finalizeStream 给出提示并清空活跃会话，不发起流式请求", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: false, message: "未指定要修改的章节" })
    const { ctx, finalizeStream, activeStreamSessionsRef } = makeCtx()
    await runChatEditMode(ctx)
    expect(mocks.resolveChatEditTarget).toHaveBeenCalledWith({ userRequest: ctx.text, selectedChapterNumber: 3 })
    expect(finalizeStream).toHaveBeenCalledWith("未指定要修改的章节", [], "conv-1")
    expect(activeStreamSessionsRef.current).toEqual({})
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("章节文件缺失：使用「未找到以下章节，暂时无法执行修改」文案", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "multi", chapterNumbers: [3, 4] } })
    mocks.findChapterFileByNumber.mockImplementation(async (_pp: string, n: number) => (n === 3 ? "D:/novel/第3章.md" : null))
    mocks.readFile.mockResolvedValue("原文")
    const { ctx, finalizeStream } = makeCtx()
    await runChatEditMode(ctx)
    expect(finalizeStream).toHaveBeenCalledWith("未找到以下章节，暂时无法执行修改：第4章", [], "conv-1")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("单章成功：backup → 快照 → 原子写入顺序不变，最终回传成功文案并写入选中文件", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "single", chapterNumbers: [3] } })
    mocks.findChapterFileByNumber.mockResolvedValue("D:/novel/第3章.md")
    mocks.readFile.mockResolvedValue("旧正文")
    mocks.normalizeChapterEditFile.mockReturnValue({ ok: true, content: "新正文" })
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers) => {
      handlers.onToken("新")
      handlers.onToken("正文")
      handlers.onDone()
    })
    const { ctx, finalizeStream, appendStreamToken, abortControllersRef } = makeCtx()
    await runChatEditMode(ctx)

    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(appendStreamToken).toHaveBeenNthCalledWith(1, "新", "conv-1")
    expect(abortControllersRef.current["conv-1"]).toBeUndefined()
    expect(mocks.backupChapterFile).toHaveBeenCalledWith({
      projectPath: "D:/novel",
      chapterPath: "D:/novel/第3章.md",
      chapterNumber: 3,
      content: "旧正文",
      source: "manual",
    })
    expect(mocks.appendChapterWorkspaceSnapshot).toHaveBeenCalledWith("D:/novel", 3, "新正文")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("D:/novel/第3章.md", "新正文")
    expect(mocks.invalidateChapterCache).toHaveBeenCalledWith("D:/novel")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("D:/novel")
    expect(mocks.setSelectedFile).toHaveBeenCalledWith("D:/novel/第3章.md")
    expect(finalizeStream).toHaveBeenCalledWith("已完成第3章修改，并已自动备份原内容。", [], "conv-1")

    const order = [
      mocks.backupChapterFile.mock.invocationCallOrder[0],
      mocks.appendChapterWorkspaceSnapshot.mock.invocationCallOrder[0],
      mocks.writeFileAtomic.mock.invocationCallOrder[0],
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("流式失败：回传「修改失败：」前缀错误并清理控制器", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "single", chapterNumbers: [3] } })
    mocks.findChapterFileByNumber.mockResolvedValue("D:/novel/第3章.md")
    mocks.readFile.mockResolvedValue("旧正文")
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers) => {
      handlers.onError(new Error("network down"))
    })
    const { ctx, finalizeStream, abortControllersRef } = makeCtx()
    await runChatEditMode(ctx)
    expect(finalizeStream).toHaveBeenCalledWith("修改失败：Error: network down", [], "conv-1")
    expect(abortControllersRef.current["conv-1"]).toBeUndefined()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("多章结构化校验失败：回传校验消息且不写回", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "multi", chapterNumbers: [3, 4] } })
    mocks.findChapterFileByNumber.mockResolvedValue("D:/novel/ch.md")
    mocks.readFile.mockResolvedValue("旧正文")
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers) => {
      handlers.onToken("残缺结果")
      handlers.onDone()
    })
    mocks.validateStructuredChapterEditResult.mockReturnValue({ ok: false, message: "缺少【第4章】段落" })
    const { ctx, finalizeStream } = makeCtx()
    await runChatEditMode(ctx)
    expect(finalizeStream).toHaveBeenCalledWith("缺少【第4章】段落", [], "conv-1")
    expect(mocks.backupChapterFile).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("归一化失败：回传归一化消息且不写回", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "single", chapterNumbers: [3] } })
    mocks.findChapterFileByNumber.mockResolvedValue("D:/novel/第3章.md")
    mocks.readFile.mockResolvedValue("旧正文")
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers) => {
      handlers.onToken("输出")
      handlers.onDone()
    })
    mocks.normalizeChapterEditFile.mockReturnValue({ ok: false, message: "模型返回了空的章节正文" })
    const { ctx, finalizeStream } = makeCtx()
    await runChatEditMode(ctx)
    expect(finalizeStream).toHaveBeenCalledWith("模型返回了空的章节正文", [], "conv-1")
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("单章缺少修改结果：回传「缺少修改结果，已停止写回」文案", async () => {
    mocks.resolveChatEditTarget.mockReturnValue({ ok: true, target: { mode: "multi", chapterNumbers: [3] } })
    mocks.findChapterFileByNumber.mockResolvedValue("D:/novel/第3章.md")
    mocks.readFile.mockResolvedValue("旧正文")
    mocks.streamChat.mockImplementation(async (_cfg, _msgs, handlers) => {
      handlers.onToken("输出")
      handlers.onDone()
    })
    mocks.validateStructuredChapterEditResult.mockReturnValue({ ok: true, files: [] })
    const { ctx, finalizeStream } = makeCtx()
    await runChatEditMode(ctx)
    expect(finalizeStream).toHaveBeenCalledWith("第3章缺少修改结果，已停止写回。", [], "conv-1")
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})
