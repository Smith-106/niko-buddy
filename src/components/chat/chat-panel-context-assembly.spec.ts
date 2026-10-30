/**
 * assembleChatContext — 系统上下文装配契约（chat-panel 拆分 T6）。
 * 覆盖：打招呼短路、Soul 弹窗取消、Soul 弹窗确认、项目为空时回退。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import { assembleChatContext, type AssembleChatContextParams } from "./chat-panel-context-assembly"

const mocks = vi.hoisted(() => ({
  searchWiki: vi.fn(),
  readFile: vi.fn(),
  buildContextPack: vi.fn(),
  contextPackToPrompt: vi.fn(() => "mock-preamble"),
  buildRetrievalGraph: vi.fn(),
  getRelatedNodes: vi.fn(() => []),
  setLastQueryPages: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: mocks.searchWiki,
  tokenizeQuery: (q: string) => q.split(" "),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: mocks.readFile,
  }
})

vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: mocks.buildRetrievalGraph,
  getRelatedNodes: mocks.getRelatedNodes,
}))

vi.mock("@/lib/novel/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
  contextPackToPrompt: mocks.contextPackToPrompt,
}))

vi.mock("./chat-shared", () => ({
  setLastQueryPages: mocks.setLastQueryPages,
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

const PROJECT: WikiProject = {
  name: "demo-project",
  path: "D:/project",
} as unknown as WikiProject

function makeParams(overrides: Partial<AssembleChatContextParams> = {}): {
  params: AssembleChatContextParams
  requestSoulDialog: ReturnType<typeof vi.fn>
  setReplayContextPack: ReturnType<typeof vi.fn>
} {
  const requestSoulDialog = vi.fn().mockResolvedValue(true)
  const setReplayContextPack = vi.fn()
  const params: AssembleChatContextParams = {
    text: "你好",
    project: PROJECT,
    novelMode: false,
    effectiveTaskRoute: null,
    goldenThreeChapter: undefined,
    dismantlingDirective: "",
    llmConfig: LLM_CONFIG,
    requestSoulDialog,
    setReplayContextPack,
    ...overrides,
  }
  return { params, requestSoulDialog, setReplayContextPack }
}

describe("assembleChatContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readFile.mockResolvedValue("")
    mocks.searchWiki.mockResolvedValue([])
    mocks.buildRetrievalGraph.mockResolvedValue({})
  })

  it("纯问候短路：不执行知识库检索，返回单条问候 system message 且 queryRefs 为空", async () => {
    const { params } = makeParams({ text: "你好", novelMode: false })
    const res = await assembleChatContext(params)

    expect(res.cancelled).toBe(false)
    if (res.cancelled) return
    expect(res.systemMessages).toHaveLength(1)
    expect(res.systemMessages[0].role).toBe("system")
    expect(res.systemMessages[0].content).toContain("你是项目「demo-project」的资料库问答助手。")
    expect(res.queryRefs).toEqual([])
    expect(mocks.searchWiki).not.toHaveBeenCalled()
  })

  it("Soul 对话框取消：当角色灵魂文本存在且用户取消时，返回 cancelled: true 及取消文案", async () => {
    mocks.buildContextPack.mockResolvedValue({
      characterAuras: "李四性格偏执冷酷",
    })
    const { params, requestSoulDialog, setReplayContextPack } = makeParams({
      text: "写第2章",
      novelMode: true,
      effectiveTaskRoute: { chapterNumber: 2, intent: "write_chapter", confidence: 1, extractedParams: {} },
    })
    requestSoulDialog.mockResolvedValue(false)

    const res = await assembleChatContext(params)

    expect(requestSoulDialog).toHaveBeenCalledWith("李四性格偏执冷酷")
    expect(setReplayContextPack).toHaveBeenCalledTimes(1)
    expect(res.cancelled).toBe(true)
    if (!res.cancelled) return
    expect(res.message).toBe("已取消本次生成，角色灵魂上下文未发送给模型。")
  })

  it("Soul 对话框确认：当用户确认后，正常装配并返回 systemMessages", async () => {
    mocks.buildContextPack.mockResolvedValue({
      characterAuras: "张三觉醒记忆",
    })
    const { params, requestSoulDialog } = makeParams({
      text: "写第2章",
      novelMode: true,
      effectiveTaskRoute: { chapterNumber: 2, intent: "write_chapter", confidence: 1, extractedParams: {} },
    })
    requestSoulDialog.mockResolvedValue(true)

    const res = await assembleChatContext(params)

    expect(requestSoulDialog).toHaveBeenCalledWith("张三觉醒记忆")
    expect(res.cancelled).toBe(false)
    if (res.cancelled) return
    expect(res.systemMessages.length).toBeGreaterThan(0)
    expect(mocks.contextPackToPrompt).toHaveBeenCalledTimes(1)
  })

  it("project 为空时：返回空 systemMessages 与空 queryRefs", async () => {
    const { params } = makeParams({ text: "任意文本", project: null })
    const res = await assembleChatContext(params)

    expect(res.cancelled).toBe(false)
    if (res.cancelled) return
    expect(res.systemMessages).toEqual([])
    expect(res.queryRefs).toEqual([])
  })
})
