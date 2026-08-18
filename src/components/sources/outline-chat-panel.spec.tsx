// @vitest-environment jsdom
/**
 * OutlineChatPanel 全口径覆盖 spec（s/l/b/f 100% 目标）。
 * 断言严格对照 src/components/sources/outline-chat-panel.tsx 源码实现。
 */
import { act } from "react"
import Module from "node:module"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"
import { OutlineChatPanel } from "./outline-chat-panel"

// 源码 outline-chat-panel.tsx:131 在 render 期用 Node 的 require() 读取 agent-parser
// （vite-node 的 createRequire 无法解析 @/ 别名）。拦截 Module._load 把该请求
// 映射到 vi.mock 的导出，保证 require 与动态 import 返回同一份 mock。
const originalLoad = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load
;(Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/novel/agent-parser") {
    return {
      parseAgentResponse: mocks.parseAgentResponse,
      detectEditIntent: mocks.detectEditIntent,
      buildAgentSystemSuffix: mocks.buildAgentSystemSuffix,
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

interface ProjectLike {
  id: string
  name: string
  path: string
}
interface ConvMsg {
  id: string
  role: "user" | "assistant"
  content: string
  sources?: string[]
}
interface Conv {
  id: string
  title: string
  createdAt: number
  messages: ConvMsg[]
}

const PROJECT: ProjectLike = { id: "p1", name: "MyBook", path: "E:/Novel" }

const mocks = vi.hoisted(() => {
  const wikiState: {
    project: ProjectLike | null
    llmConfig: { provider: string; apiKey: string; model: string }
    novelConfig: { contextTokenBudget: number }
  } = {
    project: null,
    llmConfig: { provider: "openai", apiKey: "k", model: "m" },
    novelConfig: { contextTokenBudget: 0 },
  }
  const outlineState: {
    conversations: Conv[]
    activeConversationId: string | null
    streamingContent: string
    isStreaming: boolean
    loaded: boolean
  } = {
    conversations: [],
    activeConversationId: null,
    streamingContent: "",
    isStreaming: false,
    loaded: false,
  }
  return {
    wikiState,
    outlineState,
    getWikiState: () => ({ searchApiConfig: { provider: "none" as const, apiKey: "" } }),
    // outline-chat-store actions（setState 会直接写 outlineState，模拟 zustand）
    createConversation: vi.fn<() => string>(() => "conv-created"),
    setActiveConversation: vi.fn<(id: string | null) => void>(),
    addMessage: vi.fn<(convId: string, message: ConvMsg) => void>(),
    replaceLastAssistant: vi.fn<(message: ConvMsg) => void>(),
    removeLastMessage: vi.fn<() => void>(),
    deleteConversation: vi.fn<(id: string) => void>(),
    setStreamingContent: vi.fn<(c: string) => void>((c: string) => { outlineState.streamingContent = c }),
    setIsStreaming: vi.fn<(v: boolean) => void>((v: boolean) => { outlineState.isStreaming = v }),
    loadFromDisk: vi.fn<() => Promise<void>>(async () => {}),
    // llm / 生成管线
    streamChat: vi.fn<(
      _config: unknown,
      _messages: unknown,
      callbacks: { onToken?: (t: string) => void; onReasoningToken?: (t: string) => void; onDone?: () => void; onError?: (e: Error) => void },
      _signal?: AbortSignal,
      _overrides?: unknown,
    ) => Promise<void>>(async (_config, _messages, callbacks) => {
      callbacks.onReasoningToken?.("推理片段")
      callbacks.onReasoningToken?.("第二段")
      callbacks.onReasoningToken?.("")
      callbacks.onToken?.("正文片段")
      callbacks.onDone?.()
    }),
    hasUsableLlm: vi.fn<() => boolean>(() => true),
    resolveNovelModel: vi.fn<() => { provider: string; apiKey: string; model: string }>(() => ({ provider: "openai", apiKey: "k", model: "m" })),
    runDeepOutlineGeneration: vi.fn<(
      _input: unknown,
      callbacks?: { onThinking?: (c: string) => void; onFinalContent?: (c: string) => void },
      _deps?: unknown,
      signal?: AbortSignal,
    ) => Promise<{ finalContent: string; taskBrief: string; draftContent: string; selfCheck: string }>>(async (_input, callbacks) => {
      callbacks?.onThinking?.("思考阶段")
      callbacks?.onFinalContent?.("最终大纲输出")
      return { finalContent: "最终大纲输出", taskBrief: "t", draftContent: "最终大纲输出", selfCheck: "s" }
    }),
    createDeepThinkingStreamRenderer: vi.fn<() => { updateThinking: (c: string) => string; appendFinal: (c: string) => string; getContent: () => string }>(() => ({
      updateThinking: vi.fn<(c: string) => string>((c: string) => c),
      appendFinal: vi.fn<(c: string) => string>((c: string) => c),
      getContent: vi.fn<() => string>(() => ""),
    })),
    resolveUserVisibleReasoning: vi.fn<(r?: unknown) => { mode: string }>((r?: unknown) => (r ?? { mode: "auto" as const }) as { mode: string }),
    // web research
    shouldUseWebResearch: vi.fn<(text: string) => boolean>(() => false),
    collectWebResearch: vi.fn<() => Promise<{ items: unknown[]; sources: string[] }>>(async () => ({ items: [], sources: [] })),
    buildWebResearchContext: vi.fn<() => { markdown: string; sources: string[] }>(() => ({ markdown: "", sources: [] })),
    // agent parser / tools（动态 import 走 mock）
    detectEditIntent: vi.fn<(text: string) => boolean>(() => false),
    buildAgentSystemSuffix: vi.fn<(scope: "chapters" | "outlines") => string>(() => "\n\n[agent-suffix]"),
    parseAgentResponse: vi.fn<(content: string) => { textContent: string; edits: unknown[]; hasEdits: boolean }>((content: string) => ({ textContent: content, edits: [], hasEdits: false })),
    readScopeFileContents: vi.fn<(path: string) => Promise<Array<{ name: string; content: string }>>>(async () => []),
    applyFileEdits: vi.fn<(projectPath: string, edits: unknown[]) => Promise<Array<{ path: string; ok: boolean }>>>(async () => [{ path: "E:/Novel/wiki/outlines/x.md", ok: true }]),
    // outline 保存
    prepareOutlineSaveDraft: vi.fn<(content: string) => { title: string; content: string }>((content: string) => ({ title: "测试大纲", content: `# 测试大纲\n\n${content}` })),
    refreshProjectState: vi.fn<(projectPath: string) => Promise<void>>(async () => {}),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p.replace(/\\/g, "/")),
    // fs
    readFile: vi.fn<(path: string) => Promise<string>>(async () => "file-content"),
    writeFile: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
    listDirectory: vi.fn<(path: string) => Promise<Array<{ name: string; is_dir: boolean; path?: string }>>>(async () => []),
    createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
    fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
    clipboardWrite: vi.fn<(text: string) => Promise<void>>(async () => {}),
  }
})

// ── store mocks ────────────────────────────────────────────────────────────────
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: mocks.getWikiState },
  ),
}))

vi.mock("@/stores/outline-chat-store", () => ({
  useOutlineChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        ...mocks.outlineState,
        createConversation: mocks.createConversation,
        setActiveConversation: mocks.setActiveConversation,
        addMessage: mocks.addMessage,
        replaceLastAssistant: mocks.replaceLastAssistant,
        removeLastMessage: mocks.removeLastMessage,
        deleteConversation: mocks.deleteConversation,
        setStreamingContent: mocks.setStreamingContent,
        setIsStreaming: mocks.setIsStreaming,
        loadFromDisk: mocks.loadFromDisk,
      }),
    {
      getState: () => mocks.outlineState,
      setState: (partial: unknown) => {
        const next = typeof partial === "function" ? (partial as (s: typeof mocks.outlineState) => Partial<typeof mocks.outlineState>)(mocks.outlineState) : (partial as Partial<typeof mocks.outlineState>)
        Object.assign(mocks.outlineState, next)
      },
    },
  ),
}))

vi.mock("@/lib/llm-client", () => ({ streamChat: mocks.streamChat }))
vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveNovelModel: mocks.resolveNovelModel }))
vi.mock("@/lib/novel/deep-outline-generation", () => ({ runDeepOutlineGeneration: mocks.runDeepOutlineGeneration }))
vi.mock("@/lib/deep-thinking-stream", () => ({ createDeepThinkingStreamRenderer: mocks.createDeepThinkingStreamRenderer }))
vi.mock("@/lib/user-visible-reasoning", () => ({ resolveUserVisibleReasoning: mocks.resolveUserVisibleReasoning }))
vi.mock("@/lib/web-research", () => ({
  shouldUseWebResearch: mocks.shouldUseWebResearch,
  collectWebResearch: mocks.collectWebResearch,
  buildWebResearchContext: mocks.buildWebResearchContext,
}))
vi.mock("@/lib/novel/agent-parser", () => ({
  parseAgentResponse: mocks.parseAgentResponse,
  detectEditIntent: mocks.detectEditIntent,
  buildAgentSystemSuffix: mocks.buildAgentSystemSuffix,
}))
vi.mock("@/lib/novel/agent-tools", () => ({
  readScopeFileContents: mocks.readScopeFileContents,
  applyFileEdits: mocks.applyFileEdits,
}))
vi.mock("@/lib/outline-save", () => ({ prepareOutlineSaveDraft: mocks.prepareOutlineSaveDraft }))
vi.mock("@/lib/novel/outline-generation", () => ({
  OUTLINE_SECTION_GENERATION_CONFIGS: [
    { key: "chapterOutlines", title: "章节细纲", englishTitle: "", englishFileName: "", requestHint: "提示词A" },
    { key: "characterBriefs", title: "人物小传", englishTitle: "", englishFileName: "", requestHint: "提示词B" },
  ],
}))
vi.mock("@/lib/path-utils", () => ({ normalizePath: mocks.normalizePath }))
vi.mock("@/lib/project-refresh", () => ({ refreshProjectState: mocks.refreshProjectState }))
vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
}))
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: ({ onSend, onStop, isStreaming, placeholder, footerControls }: any) => (
    <div data-testid="chat-input">
      <form
        data-testid="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          const ta = (e.currentTarget as HTMLFormElement).querySelector("textarea")
          onSend(ta?.value ?? "")
        }}
      >
        <textarea data-testid="chat-textarea" placeholder={placeholder} disabled={isStreaming} />
        <button type="submit" data-testid="chat-send">发送</button>
      </form>
      <button type="button" data-testid="chat-stop" onClick={onStop}>停止</button>
      <div data-testid="chat-footer">{footerControls}</div>
    </div>
  ),
}))
vi.mock("@/components/chat/file-edit-preview", () => ({
  FileEditPreview: ({ edits, onApply, onDismiss, applied, results }: any) => (
    <div data-testid="file-edit-preview">
      <span>{`edits:${edits.length}`}</span>
      <span>{`applied:${String(applied)}`}</span>
      <button data-testid="preview-apply" onClick={() => { void onApply(edits) }}>应用</button>
      <button data-testid="preview-dismiss" onClick={onDismiss}>忽略</button>
      <span>{`results:${results?.length ?? 0}`}</span>
    </div>
  ),
}))
vi.mock("@/components/chat/chat-dock-controls", () => ({
  ChatDockControls: () => <div data-testid="chat-dock-controls" />,
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: any) => <div data-testid="tooltip-provider">{children}</div>,
}))

// ── fixtures / helpers ─────────────────────────────────────────────────────────
function makeConv(overrides?: Partial<Conv>): Conv {
  return { id: "conv-1", title: "大纲对话 12:30", createdAt: 1, messages: [], ...overrides }
}

function existingPaths(): Set<string> {
  const set = new Set<string>()
  return set
}

function defaultFs(): void {
  mocks.listDirectory.mockImplementation(async (dir: string) => {
    if (dir.endsWith("/wiki/outlines")) {
      return [
        { name: "总纲.md", is_dir: false },
        { name: "长大纲.md", is_dir: false },
        { name: "readme.txt", is_dir: false },
        { name: "失败大纲.md", is_dir: false },
      ]
    }
    if (dir.endsWith("/wiki/chapters")) {
      return [
        { name: "ch1.md", is_dir: false },
        { name: "长章节.md", is_dir: false },
        { name: "ch3.md", is_dir: false },
        { name: "失败章节.md", is_dir: false },
        { name: "ch5.md", is_dir: false },
      ]
    }
    return []
  })
  mocks.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("长大纲.md")) return "A".repeat(3001)
    if (path.endsWith("长章节.md")) return "B".repeat(1501)
    if (path.endsWith("失败大纲.md") || path.endsWith("失败章节.md")) throw new Error("read-fail")
    return "正常内容"
  })
  mocks.fileExists.mockImplementation(async (path: string) => existingPaths().has(path))
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.prepareOutlineSaveDraft.mockImplementation((content: string) => ({ title: "测试大纲", content: `# 测试大纲\n\n${content}` }))
}

function resetStore(): void {
  mocks.wikiState.project = PROJECT
  mocks.outlineState.conversations = []
  mocks.outlineState.activeConversationId = null
  mocks.outlineState.streamingContent = ""
  mocks.outlineState.isStreaming = false
  mocks.outlineState.loaded = false
}

async function sendText(text: string): Promise<void> {
  const input = screen.getByTestId("chat-textarea")
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(screen.getByTestId("chat-form"))
  await act(async () => { await Promise.resolve() })
}

function renderPanel(onClose = () => {}): ReturnType<typeof render> {
  return render(<OutlineChatPanel onClose={onClose} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  defaultFs()
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.shouldUseWebResearch.mockReturnValue(false)
  mocks.detectEditIntent.mockReturnValue(false)
  mocks.parseAgentResponse.mockImplementation((content: string) => ({ textContent: content, edits: [], hasEdits: false }))
  mocks.streamChat.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onReasoningToken?.("推理片段")
    callbacks.onReasoningToken?.("第二段")
    callbacks.onReasoningToken?.("")
    callbacks.onToken?.("正文片段")
    callbacks.onDone?.()
  })
  mocks.runDeepOutlineGeneration.mockImplementation(async (_input, callbacks) => {
    callbacks?.onThinking?.("思考阶段")
    callbacks?.onFinalContent?.("最终大纲输出")
    return { finalContent: "最终大纲输出", taskBrief: "t", draftContent: "最终大纲输出", selfCheck: "s" }
  })
  setupDomGlobals({ resizeObserver: true, scrollTo: true, matchMedia: true })
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: mocks.clipboardWrite },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ── 挂载 / 空态 / 头部 ────────────────────────────────────────────────────────
describe("OutlineChatPanel — 挂载 / 空态 / 头部", () => {
  it("loaded=false 时挂载触发 loadFromDisk，无会话时显示空态提示", async () => {
    renderPanel()
    expect(mocks.loadFromDisk).toHaveBeenCalledTimes(1)
    expect(screen.getByText("输入关于大纲的问题或指令，AI 会基于当前大纲和章节内容进行回答和创作。")).toBeTruthy()
  })

  it("loaded=true 时不再重复加载", async () => {
    mocks.outlineState.loaded = true
    renderPanel()
    await act(async () => {})
    expect(mocks.loadFromDisk).not.toHaveBeenCalled()
  })

  it("isStreaming 且无消息时隐藏空态提示", () => {
    mocks.outlineState.isStreaming = true
    renderPanel()
    expect(screen.queryByText("输入关于大纲的问题或指令，AI 会基于当前大纲和章节内容进行回答和创作。")).toBeNull()
  })

  it("点击新建对话按钮调用 createConversation", () => {
    renderPanel()
    fireEvent.click(screen.getByTitle("新建大纲对话"))
    expect(mocks.createConversation).toHaveBeenCalledTimes(1)
  })

  it("会话标签渲染、切换与删除（stopPropagation）", () => {
    mocks.outlineState.conversations = [
      makeConv({ id: "conv-1", title: "对话一" }),
      makeConv({ id: "conv-2", title: "对话二" }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    expect(screen.getByText("对话一")).toBeTruthy()
    expect(screen.getByText("对话二")).toBeTruthy()
    // 切换会话
    fireEvent.click(screen.getByText("对话二"))
    expect(mocks.setActiveConversation).toHaveBeenCalledWith("conv-2")
    // 删除 conv-2（点击 trash 图标不应触发切换）
    const trash = screen.getAllByText("对话二")[0].parentElement?.querySelector(".lucide-trash-2") as HTMLElement
    expect(trash).not.toBeNull()
    fireEvent.click(trash)
    expect(mocks.deleteConversation).toHaveBeenCalledWith("conv-2")
    // stopPropagation：trash 点击不应再次触发 setActiveConversation
    expect(mocks.setActiveConversation.mock.calls.filter((c) => c[0] === "conv-2")).toHaveLength(1)
  })

  it("onClose 回调", () => {
    const onClose = vi.fn()
    const { container } = renderPanel(onClose)
    const closeBtn = container.querySelector(".lucide-x")?.closest("button") as HTMLElement
    expect(closeBtn).not.toBeNull()
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── 消息渲染 ───────────────────────────────────────────────────────────────────
describe("OutlineChatPanel — 消息渲染（数据态）", () => {
  it("用户 + 助手消息完整渲染：思考块 / markdown / 引用资料 / 操作按钮", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [
          { id: "u1", role: "user", content: "用户提问" },
          { id: "a1", role: "assistant", content: "<thinking>内部推理</thinking>\n\n## 回答正文", sources: ["大纲: 总纲", "章节: ch1"] },
        ],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    expect(screen.getByText("用户提问")).toBeTruthy()
    expect(screen.getByText("内部推理")).toBeTruthy()
    expect(screen.getByText("## 回答正文")).toBeTruthy()
    expect(screen.getByText("引用资料（2）")).toBeTruthy()
    expect(screen.getByText(/大纲: 总纲/)).toBeTruthy()
    expect(screen.getByText("保存为大纲")).toBeTruthy()
    expect(screen.getByText("复制")).toBeTruthy()
    expect(screen.getByText("重新生成")).toBeTruthy()
    expect(screen.queryByTestId("file-edit-preview")).toBeNull()
  })

  it("已复制状态：copied === msg.id 时按钮显示 已复制", async () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "正文内容", sources: [] }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    // 通过一次真实的复制交互触发 copied 状态（setCopied 触发组件自身重渲染）
    mocks.clipboardWrite.mockResolvedValue(undefined)
    fireEvent.click(screen.getByText("复制"))
    await waitFor(() => expect(screen.getByText("已复制")).toBeTruthy())
  })

  it("流式占位消息（最后一条 assistant content 为空）不渲染重复流式块", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "", sources: ["章节: ch1"] }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    mocks.outlineState.isStreaming = true
    mocks.outlineState.streamingContent = "正在生成中"
    renderPanel()
    // 占位 assistant 消息直接显示流式内容（displayContent = streamingContent）
    expect(screen.getByText("正在生成中")).toBeTruthy()
    // 无第二个流式块（每个 markdown 容器唯一）
    expect(screen.getAllByTestId("markdown").length).toBe(1)
    // 流式时无操作按钮 / 引用资料
    expect(screen.queryByText("复制")).toBeNull()
    expect(screen.queryByText("引用资料（1）")).toBeNull()
  })

  it("流式且最后一条为 user 消息时渲染补充流式块", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "u1", role: "user", content: "用户问题" }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    mocks.outlineState.isStreaming = true
    mocks.outlineState.streamingContent = "流式输出内容"
    renderPanel()
    expect(screen.getByText("流式输出内容")).toBeTruthy()
    expect(screen.getByText("用户问题")).toBeTruthy()
  })

  it("非流式时残留 streamingContent 不渲染补充块", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "u1", role: "user", content: "问题" }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    mocks.outlineState.streamingContent = "残留内容"
    renderPanel()
    expect(screen.queryByText("残留内容")).toBeNull()
  })

  it("assistant 无内容且非流式 → 不渲染操作按钮", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "" }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    expect(screen.queryByText("复制")).toBeNull()
    expect(screen.queryByText("保存为大纲")).toBeNull()
  })

  it("思考块 open=true 样式（isStreaming）与 open=false", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "<think>推理中</think>答案" }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    const { rerender } = renderPanel()
    expect(screen.getByText("思考过程")).toBeTruthy()
    mocks.outlineState.isStreaming = true
    rerender(<OutlineChatPanel onClose={() => {}} />)
    expect(screen.getByText("思考中...")).toBeTruthy()
  })

  it("未闭合的思考标签：openMatch 分支截断正文并保留思考内容", () => {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "正文<think>未闭合思考" }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    // separateThinking：openMatch 命中 → thinkParts=[未闭合思考]，answer=正文
    expect(screen.getByText("未闭合思考")).toBeTruthy()
    expect(screen.getByText("正文")).toBeTruthy()
    expect(screen.getByText("复制")).toBeTruthy()
  })
})

// ── 文件编辑预览 ──────────────────────────────────────────────────────────────
describe("OutlineChatPanel — 文件编辑预览", () => {
  function renderWithEdits(overrides?: { project?: ProjectLike | null; isStreaming?: boolean }): ReturnType<typeof render> {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [{ id: "a1", role: "assistant", content: "有编辑指令的回答", sources: [] }],
      }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    mocks.wikiState.project = overrides?.project !== undefined ? overrides.project : PROJECT
    mocks.outlineState.isStreaming = overrides?.isStreaming ?? false
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "有编辑指令的回答",
      edits: [{ filePath: "wiki/outlines/x.md", search: "旧", replace: "新" }],
      hasEdits: true,
    })
    return renderPanel()
  }

  it("hasEdits + project + 非流式 → 预览可见；应用走 applyFileEdits + refreshProjectState；忽略隐藏", async () => {
    renderWithEdits({})
    expect(screen.getByTestId("file-edit-preview")).toBeTruthy()
    expect(screen.getByText("edits:1")).toBeTruthy()
    fireEvent.click(screen.getByTestId("preview-apply"))
    await waitFor(() => expect(mocks.applyFileEdits).toHaveBeenCalledWith(PROJECT.path, expect.any(Array)))
    expect(mocks.refreshProjectState).toHaveBeenCalledWith(PROJECT.path)
    expect(screen.getByText("applied:true")).toBeTruthy()
    fireEvent.click(screen.getByTestId("preview-dismiss"))
    expect(screen.queryByTestId("file-edit-preview")).toBeNull()
  })

  it("hasEdits + isStreaming → 预览隐藏", () => {
    renderWithEdits({ isStreaming: true })
    expect(screen.queryByTestId("file-edit-preview")).toBeNull()
  })

  it("hasEdits + project 为 null → 预览隐藏", () => {
    renderWithEdits({ project: null })
    expect(screen.queryByTestId("file-edit-preview")).toBeNull()
  })

  it("无 hasEdits → 不渲染预览，markdown 用 textContent", () => {
    mocks.outlineState.conversations = [
      makeConv({ messages: [{ id: "a1", role: "assistant", content: "普通回答" }] }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    expect(screen.queryByTestId("file-edit-preview")).toBeNull()
    expect(screen.getByText("普通回答")).toBeTruthy()
  })
})

// ── 发送流程 ──────────────────────────────────────────────────────────────────
describe("OutlineChatPanel — 发送流程", () => {
  it("空输入直接返回", async () => {
    renderPanel()
    await sendText("   ")
    expect(mocks.addMessage).not.toHaveBeenCalled()
  })

  it("无项目时直接返回", async () => {
    mocks.wikiState.project = null
    renderPanel()
    await sendText("请生成大纲")
    expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.createConversation).not.toHaveBeenCalled()
  })

  it("isStreaming 时忽略发送", async () => {
    mocks.outlineState.isStreaming = true
    renderPanel()
    await sendText("请生成大纲")
    expect(mocks.addMessage).not.toHaveBeenCalled()
  })

  it("无可用的 LLM：有活动会话 → 直接向该会话追加错误提示", async () => {
    mocks.outlineState.activeConversationId = "conv-1"
    mocks.hasUsableLlm.mockReturnValue(false)
    renderPanel()
    await sendText("请生成大纲")
    expect(mocks.addMessage).toHaveBeenCalledWith("conv-1", expect.objectContaining({
      role: "assistant",
      content: "请先在设置中配置可用的AI模型（API Key 和模型名称），或在AI会话中选择一个模型。",
    }))
    expect(mocks.createConversation).not.toHaveBeenCalled()
  })

  it("无可用的 LLM：无活动会话 → 新建会话后追加错误提示", async () => {
    mocks.hasUsableLlm.mockReturnValue(false)
    renderPanel()
    await sendText("请生成大纲")
    expect(mocks.createConversation).toHaveBeenCalledTimes(1)
    expect(mocks.addMessage).toHaveBeenCalledWith("conv-created", expect.objectContaining({ role: "assistant" }))
  })

  it("完整生成链路：loadOutlineContext → 占位消息 → runDeepOutlineGeneration → replaceLastAssistant", async () => {
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    // 用户消息 + assistant 占位消息
    expect(mocks.addMessage).toHaveBeenNthCalledWith(1, "conv-created", expect.objectContaining({ role: "user", content: "请生成大纲" }))
    expect(mocks.addMessage).toHaveBeenNthCalledWith(2, "conv-created", expect.objectContaining({ role: "assistant", content: "", sources: expect.any(Array) }))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    const inputObj = input as { userRequest: string; context: string; historyMessages: unknown[] }
    expect(inputObj.userRequest).toBe("请生成大纲")
    // 上下文包含截断标记与章节，来源列表齐全
    expect(inputObj.context).toContain("...(已截断)")
    expect(inputObj.context).toContain("【章节:")
    expect(inputObj.historyMessages).toHaveLength(0)
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "最终大纲输出", expect.any(Array))
    expect(mocks.setStreamingContent).toHaveBeenLastCalledWith("")
    expect(mocks.setIsStreaming).toHaveBeenLastCalledWith(false)
  })

  it("无活动会话时创建会话并把历史消息传入生成器", async () => {
    mocks.outlineState.conversations = [
      makeConv({ messages: [{ id: "p1", role: "user", content: "历史问题" }, { id: "p2", role: "assistant", content: "历史回答" }] }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    await sendText("新问题")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    const history = (input as { historyMessages: ConvMsg[] }).historyMessages
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({ role: "user", content: "历史问题" })
    expect(history[1]).toEqual({ role: "assistant", content: "历史回答" })
  })

  it("outlines 目录与 chapters 目录读取失败时降级为空上下文继续生成", async () => {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      throw new Error(`ls-fail:${dir}`)
    })
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { context: string }).context).toBe("")
    expect(mocks.replaceLastAssistant).toHaveBeenCalled()
  })

  it("章节目录读取失败（outlines 正常）", async () => {
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir.endsWith("/wiki/chapters")) throw new Error("chapters-fail")
      return [{ name: "总纲.md", is_dir: false }]
    })
    mocks.readFile.mockResolvedValue("大纲内容")
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { context: string }).context).toContain("【总纲】")
    expect(mocks.replaceLastAssistant).toHaveBeenCalled()
  })

  it("Web Research 命中：拼接网页上下文与来源", async () => {
    mocks.shouldUseWebResearch.mockReturnValue(true)
    mocks.collectWebResearch.mockResolvedValue({ items: [{ title: "t", url: "u", snippet: "s" }], sources: ["网页: 某站"] })
    mocks.buildWebResearchContext.mockReturnValue({ markdown: "网页资料内容", sources: ["网页: 某站"] })
    renderPanel()
    await sendText("请上网查一下")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    expect(mocks.collectWebResearch).toHaveBeenCalledWith(expect.objectContaining({
      text: "请上网查一下",
      maxSearchResults: 5,
      maxImportedDocuments: 4,
    }))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { context: string }).context).toContain("网页资料内容")
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "最终大纲输出", expect.arrayContaining(["网页: 某站"]))
  })

  it("Web Research 命中但 markdown 为空 → 上下文不变，来源仍追加", async () => {
    mocks.shouldUseWebResearch.mockReturnValue(true)
    mocks.buildWebResearchContext.mockReturnValue({ markdown: "   ", sources: ["网页: 空站"] })
    renderPanel()
    await sendText("请上网查一下")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { context: string }).context).not.toContain("网页资料内容")
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "最终大纲输出", expect.arrayContaining(["网页: 空站"]))
  })

  it("Agent 模式（编辑意图）：组装 system 提示 + 文件内容，走 streamChat 推理/正文回调", async () => {
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockResolvedValue([{ name: "总纲.md", content: "大纲文件内容" }])
    renderPanel()
    await sendText("帮我改大纲")
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1))
    expect(mocks.buildAgentSystemSuffix).toHaveBeenCalledWith("outlines")
    expect(mocks.readScopeFileContents).toHaveBeenCalledWith(PROJECT.path, "outlines")
    const [_config, messages, callbacks, _signal, overrides] = mocks.streamChat.mock.calls[0]
    const msgs = messages as Array<{ role: string; content: string }>
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toContain("总纲.md")
    expect(msgs[0].content).toContain("[agent-suffix]")
    expect(overrides).toEqual({ reasoning: { mode: "auto" } })
    // 默认 mock 序列：onReasoningToken(推理片段) → onReasoningToken(第二段) → onReasoningToken("") → onToken(正文片段) → onDone
    expect((callbacks as { onToken: (t: string) => void }).onToken).toBeTypeOf("function")
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "<think>推理片段第二段</think>正文片段", expect.any(Array))
  })

  it("Agent 模式且无大纲文件 → 系统提示降级文案", async () => {
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockResolvedValue([])
    renderPanel()
    await sendText("帮我改大纲")
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1))
    const [_config, messages] = mocks.streamChat.mock.calls[0]
    expect((messages as Array<{ content: string }>)[0].content).toContain("暂无大纲文件")
  })

  it("Agent 模式 onError → closeReasoning 收尾", async () => {
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.streamChat.mockImplementationOnce(async (_c, _m, callbacks: any) => {
      callbacks.onReasoningToken?.("r1")
      callbacks.onError?.(new Error("x"))
    })
    renderPanel()
    await sendText("帮我改大纲")
    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1))
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "<think>r1</think>", expect.any(Array))
  })

  it("生成失败（Error 非 aborted）→ replaceLastAssistant 生成失败文案", async () => {
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce(new Error("网络错误"))
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "生成失败：网络错误"))
  })

  it("生成失败（非 Error）→ String 化错误", async () => {
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce("boom")
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "生成失败：boom"))
  })

  it("aborted 且无部分内容 → removeLastMessage 回滚占位消息", async () => {
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce(new Error("request aborted by user"))
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.removeLastMessage).toHaveBeenCalledWith("conv-created"))
    expect(mocks.replaceLastAssistant).not.toHaveBeenCalled()
  })

  it("空 message 的 Error → removeLastMessage", async () => {
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce(new Error(""))
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.removeLastMessage).toHaveBeenCalledWith("conv-created"))
  })

  it("生成失败但有部分流式内容 → 保留部分内容", async () => {
    mocks.runDeepOutlineGeneration.mockImplementationOnce(async (_i, callbacks) => {
      callbacks?.onThinking?.("部分思考")
      throw new Error("中断")
    })
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-created", "部分思考"))
  })

  it("章节快捷按钮：组装模板提示发送", async () => {
    renderPanel()
    fireEvent.click(screen.getByText("章节细纲"))
    await act(async () => { await Promise.resolve() })
    const userCall = mocks.addMessage.mock.calls[0]
    expect(userCall[1]).toEqual(expect.objectContaining({
      role: "user",
      content: "请继续生成「章节细纲」。提示词A 请基于已有大纲、章节内容和项目记忆直接输出该分项内容，结构清晰，可保存为大纲。",
    }))
    expect(mocks.runDeepOutlineGeneration).toHaveBeenCalled()
  })

  it("章节快捷按钮在 isStreaming 时禁用且不触发", async () => {
    mocks.outlineState.isStreaming = true
    renderPanel()
    const btn = screen.getByText("章节细纲")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(btn)
    await act(async () => {})
    expect(mocks.addMessage).not.toHaveBeenCalled()
  })

  it("无项目时点击章节快捷按钮不触发", async () => {
    mocks.wikiState.project = null
    renderPanel()
    fireEvent.click(screen.getByText("人物小传"))
    await act(async () => {})
    expect(mocks.addMessage).not.toHaveBeenCalled()
  })
})

// ── 停止 / 重新生成 ───────────────────────────────────────────────────────────
describe("OutlineChatPanel — 停止 / 重新生成", () => {
  it("生成中点击停止：abort 信号 + 保留部分内容", async () => {
    let capturedSignal: AbortSignal | undefined
    mocks.runDeepOutlineGeneration.mockImplementationOnce(async (_i, callbacks, _deps, signal) => {
      capturedSignal = signal
      callbacks?.onThinking?.("进行中内容")
      return new Promise(() => {})
    })
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    await sendText("请生成大纲")
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId("chat-stop"))
    await act(async () => {})
    expect(capturedSignal?.aborted).toBe(true)
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-1", "进行中内容")
    expect(mocks.setStreamingContent).toHaveBeenLastCalledWith("")
    expect(mocks.setIsStreaming).toHaveBeenLastCalledWith(false)
  })

  it("无进行中生成时点击停止无副作用", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("chat-stop"))
    expect(mocks.replaceLastAssistant).not.toHaveBeenCalled()
  })

  function renderWithAssistant(): ReturnType<typeof render> {
    mocks.outlineState.conversations = [
      makeConv({
        messages: [
          { id: "u1", role: "user", content: "问题" },
          { id: "a1", role: "assistant", content: "回答1" },
          { id: "a2", role: "assistant", content: "回答2" },
        ],
      }),
      makeConv({ id: "conv-other", title: "另一个会话" }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    return renderPanel()
  }

  it("重新生成：截断消息、取最近用户请求、重新生成", async () => {
    renderWithAssistant()
    // 第一条 assistant 消息位于 index=1 → 保留 [u1]
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    expect(mocks.outlineState.conversations[0].messages).toHaveLength(1)
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { userRequest: string }).userRequest).toBe("问题")
    expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-1", "最终大纲输出", expect.any(Array))
  })

  it("重新生成 index=0（无目标消息）：回退默认请求", async () => {
    mocks.outlineState.conversations = [
      makeConv({ messages: [{ id: "a0", role: "assistant", content: "仅助手消息" }] }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
    fireEvent.click(screen.getByText("重新生成"))
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(1))
    const [input] = mocks.runDeepOutlineGeneration.mock.calls[0]
    expect((input as { userRequest: string }).userRequest).toBe("请基于已有大纲重新生成。")
  })

  it("重新生成：无可用的 LLM → 追加错误提示", async () => {
    mocks.hasUsableLlm.mockReturnValue(false)
    renderWithAssistant()
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await act(async () => {})
    expect(mocks.addMessage).toHaveBeenCalledWith("conv-1", expect.objectContaining({ role: "assistant", content: expect.stringContaining("请先在设置中配置可用的AI模型") }))
    expect(mocks.runDeepOutlineGeneration).not.toHaveBeenCalled()
  })

  it("重新生成：无项目 / 会话不存在 → 直接返回", async () => {
    const { rerender } = renderWithAssistant()
    const regenButtons = () => screen.getAllByText("重新生成")
    // 无项目（按钮不依赖 project，仍可见）
    mocks.wikiState.project = null
    rerender(<OutlineChatPanel onClose={() => {}} />)
    fireEvent.click(regenButtons()[0])
    await act(async () => {})
    expect(mocks.runDeepOutlineGeneration).not.toHaveBeenCalled()
    // 会话不存在：恢复 project 与会话并重渲染，随后清空 getState 的 conversations
    mocks.wikiState.project = PROJECT
    mocks.outlineState.conversations = [
      makeConv({
        messages: [
          { id: "u1", role: "user", content: "问题" },
          { id: "a1", role: "assistant", content: "回答1" },
          { id: "a2", role: "assistant", content: "回答2" },
        ],
      }),
    ]
    rerender(<OutlineChatPanel onClose={() => {}} />)
    mocks.outlineState.conversations = []
    fireEvent.click(regenButtons()[0])
    await act(async () => {})
    expect(mocks.runDeepOutlineGeneration).not.toHaveBeenCalled()
  })

  it("重新生成：非 Error 错误 → String 化错误文案", async () => {
    renderWithAssistant()
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce("字符串错误")
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-1", "生成失败：字符串错误"))
  })

  it("重新生成失败（非 aborted）→ 生成失败文案；aborted → 无操作", async () => {
    renderWithAssistant()
    mocks.runDeepOutlineGeneration.mockRejectedValueOnce(new Error("生成超时"))
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-1", "生成失败：生成超时"))

    mocks.runDeepOutlineGeneration.mockRejectedValueOnce(new Error("aborted"))
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await waitFor(() => expect(mocks.runDeepOutlineGeneration).toHaveBeenCalledTimes(2))
    expect(mocks.replaceLastAssistant).not.toHaveBeenCalledWith("conv-1", "生成失败：aborted")
  })

  it("重新生成失败但有部分内容 → 保留部分内容", async () => {
    renderWithAssistant()
    mocks.runDeepOutlineGeneration.mockImplementationOnce(async (_i, callbacks) => {
      callbacks?.onThinking?.("重生成部分")
      throw new Error("x")
    })
    fireEvent.click(screen.getAllByText("重新生成")[0])
    await waitFor(() => expect(mocks.replaceLastAssistant).toHaveBeenCalledWith("conv-1", "重生成部分"))
  })
})

// ── 复制 / 保存为大纲 ─────────────────────────────────────────────────────────
describe("OutlineChatPanel — 复制 / 保存为大纲", () => {
  function renderAssistant(): void {
    mocks.outlineState.conversations = [
      makeConv({ messages: [{ id: "a1", role: "assistant", content: "可保存内容", sources: [] }] }),
    ]
    mocks.outlineState.activeConversationId = "conv-1"
    renderPanel()
  }

  it("复制成功：写入剪贴板、显示 已复制、2 秒后复位", async () => {
    vi.useFakeTimers()
    mocks.clipboardWrite.mockResolvedValue(undefined)
    renderAssistant()
    fireEvent.click(screen.getByText("复制"))
    await act(async () => {})
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("可保存内容")
    expect(screen.getByText("已复制")).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByText("已复制")).toBeNull()
    expect(screen.getByText("复制")).toBeTruthy()
  })

  it("复制失败被吞掉", async () => {
    mocks.clipboardWrite.mockRejectedValue(new Error("clipboard-fail"))
    renderAssistant()
    fireEvent.click(screen.getByText("复制"))
    await act(async () => {})
    expect(screen.getByText("复制")).toBeTruthy()
  })

  it("保存为大纲成功：唯一路径 + frontmatter 写入 + 状态提示", async () => {
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines")
    expect(mocks.listDirectory).toHaveBeenCalledWith("E:/Novel/wiki/outlines")
    expect(mocks.prepareOutlineSaveDraft).toHaveBeenCalled()
    const [path, content] = mocks.writeFile.mock.calls[0]
    expect(path).toBe("E:/Novel/wiki/outlines/测试大纲.md")
    expect(content).toContain('type: outline')
    expect(content).toContain('title: "测试大纲"')
    expect(content).toContain("# 测试大纲")
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByText("已保存：测试大纲")).toBeTruthy()
  })

  it("标题冲突：getUniqueOutlinePath 返回 -2 序号路径", async () => {
    const existing = new Set(["E:/Novel/wiki/outlines/测试大纲.md"])
    mocks.fileExists.mockImplementation(async (path: string) => existing.has(path))
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    expect(mocks.writeFile.mock.calls[0][0]).toBe("E:/Novel/wiki/outlines/测试大纲-2.md")
  })

  it("全部候选路径冲突 → 回退 Date.now() 路径", async () => {
    mocks.fileExists.mockResolvedValue(true)
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    expect(mocks.writeFile.mock.calls[0][0]).toMatch(/^E:\/Novel\/wiki\/outlines\/测试大纲-\d{13}\.md$/)
  })

  it("listDirectory 读取失败 → 空标题集合继续保存", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("ls-fail"))
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/已保存：/)).toBeTruthy()
  })

  it("文件列表含无标题文件（.md 空名）被 filter(Boolean) 过滤", async () => {
    mocks.listDirectory.mockResolvedValue([{ name: ".md", is_dir: false }, { name: "总纲.md", is_dir: false }])
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1))
    expect(mocks.prepareOutlineSaveDraft).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["总纲"]))
  })

  it("保存失败 → 状态提示 保存失败", async () => {
    mocks.writeFile.mockRejectedValue(new Error("write-fail"))
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(screen.getByText("保存失败：write-fail")).toBeTruthy())
  })

  it("保存失败（非 Error）→ String 化错误文案", async () => {
    mocks.writeFile.mockRejectedValueOnce("write-boom")
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await waitFor(() => expect(screen.getByText("保存失败：write-boom")).toBeTruthy())
  })

  it("无项目时保存直接返回", async () => {
    mocks.wikiState.project = null
    renderAssistant()
    fireEvent.click(screen.getByText("保存为大纲"))
    await act(async () => {})
    expect(mocks.createDirectory).not.toHaveBeenCalled()
  })
})

// ── 自动滚动 ──────────────────────────────────────────────────────────────────
describe("OutlineChatPanel — 自动滚动", () => {
  function scroller(): HTMLElement {
    const el = document.querySelector(".flex-1.overflow-y-auto") as HTMLElement
    expect(el).not.toBeNull()
    return el
  }

  it("新消息到达时滚动到底部（无用户上滚）", () => {
    mocks.outlineState.conversations = [makeConv({ messages: [{ id: "u1", role: "user", content: "问题" }] })]
    mocks.outlineState.activeConversationId = "conv-1"
    const { rerender } = renderPanel()
    const el = scroller()
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true })
    // 追加新消息（新数组引用触发 activeMessages 变化）
    mocks.outlineState.conversations = [
      makeConv({ messages: [{ id: "u1", role: "user", content: "问题" }, { id: "a1", role: "assistant", content: "新回答" }] }),
    ]
    rerender(<OutlineChatPanel onClose={() => {}} />)
    expect(el.scrollTop).toBe(1000)
  })

  it("用户上滚后不再自动滚动，回到底部后恢复", () => {
    mocks.outlineState.conversations = [makeConv({ messages: [{ id: "u1", role: "user", content: "问题" }] })]
    mocks.outlineState.activeConversationId = "conv-1"
    const { rerender } = renderPanel()
    const el = scroller()
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true })
    // 首次滚动到底部 → userScrolledUp=false，lastScrollTop=600
    el.scrollTop = 600
    fireEvent.scroll(el)
    // 上滚 → userScrolledUp=true
    el.scrollTop = 100
    fireEvent.scroll(el)
    // 下滚但未到底 → atBottom=false（覆盖 else-if 假分支）
    el.scrollTop = 300
    fireEvent.scroll(el)
    // 有新内容但用户已上滚 → 不自动滚动
    mocks.outlineState.streamingContent = "x"
    rerender(<OutlineChatPanel onClose={() => {}} />)
    expect(el.scrollTop).toBe(300)
    // 回到底部 → userScrolledUp=false → 恢复自动滚动
    el.scrollTop = 600
    fireEvent.scroll(el)
    mocks.outlineState.streamingContent = "y"
    rerender(<OutlineChatPanel onClose={() => {}} />)
    expect(el.scrollTop).toBe(1000)
  })
})
