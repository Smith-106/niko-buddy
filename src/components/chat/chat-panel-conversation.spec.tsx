// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, within } from "@/test-helpers/component-test-utils"
import { getChatPanelMocks, PROJECT, setConversation, setMessages, msg, renderPanel, rerenderPanel, flushAsync, sendText, lastStreamChatCall, lastFinalize } from "./chat-panel-test-setup"

const mocks = getChatPanelMocks()
import type { RetrievalGraph } from "@/lib/graph-relevance"
describe("ChatPanel — 会话标签栏 (ConversationTabs)", () => {
  it("空会话显示占位文案 + 新建按钮", () => {
    renderPanel()
    expect(screen.getByText("新建对话")).toBeInTheDocument()
    expect(screen.getByText("暂无对话")).toBeInTheDocument()
  })

  it("novel 模式空会话显示 novel 文案", () => {
    mocks.wikiState.novelMode = true
    renderPanel()
    expect(screen.getByText("新建写作对话")).toBeInTheDocument()
    expect(screen.getByText("暂无写作对话")).toBeInTheDocument()
  })

  it("点击新建会话调用 createConversation", () => {
    renderPanel()
    fireEvent.click(screen.getByText("新建对话"))
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
  })

  it("渲染会话标签：激活态/非激活态/标题/消息数/日期（今天+历史）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "会话一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "会话二", createdAt: 1, updatedAt: Date.now() - 3 * 86400000, deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [
      msg({ id: "a1", conversationId: "conv-1" }),
      msg({ id: "a2", conversationId: "conv-1", role: "assistant", content: "x" }),
    ]
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(tabs[1]).toHaveAttribute("aria-selected", "false")
    expect(within(tabs[0]).getByText("会话一")).toBeInTheDocument()
    expect(within(tabs[0]).getByText("2")).toBeInTheDocument()
    // 日期 span 非空（today → 时间，旧 → 月日）
    const dateSpans = tabs[0].querySelectorAll("span")
    expect(dateSpans.length).toBeGreaterThan(0)
  })

  it("键盘 Enter/Space 切换会话", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    fireEvent.keyDown(tabs[1], { key: "Enter" })
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-2")
    fireEvent.keyDown(tabs[0], { key: " " })
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("conv-1")
  })

  it("流式会话标签显示呼吸点", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.streamingContents = { "conv-1": "..." }
    renderPanel()
    const tab = screen.getByRole("tab")
    expect(tab.querySelector(".animate-pulse")).not.toBeNull()
  })

  it("非激活标签 hover 显示删除按钮，两步确认后删除（有项目时删除文件）", () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.messages = [msg({ id: "a1", conversationId: "conv-2" })]
    renderPanel()
    const tabs = screen.getAllByRole("tab")
    expect(within(tabs[0]).queryByLabelText("删除该会话")).not.toBeNull() // 激活标签常显
    // ui-audit-20261016 P0-B5（F-A3）：非激活标签的删除钮现在**常渲染**（否则键盘
    // 用户永远 Tab 不到，WCAG 2.1.1 失败），未 hover/未聚焦时靠 opacity-0 隐藏。
    const hiddenDel = within(tabs[1]).queryByLabelText("删除该会话")
    expect(hiddenDel).not.toBeNull()
    expect(hiddenDel).toHaveClass("opacity-0")
    fireEvent.mouseEnter(tabs[1])
    const del = within(tabs[1]).getByLabelText("删除该会话")
    fireEvent.click(del)
    expect(within(tabs[1]).getByLabelText("确认删除该会话")).toBeInTheDocument()
    fireEvent.click(within(tabs[1]).getByLabelText("确认删除该会话"))
    expect(mocks.chatState.deleteConversation).toHaveBeenCalledWith("conv-2")
    expect(mocks.deleteFile).toHaveBeenCalledWith("/p/mybook/.niko-buddy/chats/conv-2.json")
    fireEvent.mouseLeave(tabs[1])
  })

  it("删除按钮失焦重置确认态", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab = screen.getByRole("tab")
    const del = within(tab).getByLabelText("删除该会话")
    fireEvent.click(del)
    expect(within(tab).getByLabelText("确认删除该会话")).toBeInTheDocument()
    fireEvent.blur(within(tab).getByLabelText("确认删除该会话"))
    expect(within(tab).getByLabelText("删除该会话")).toBeInTheDocument()
  })

  it("删除会话时 abort 流并吞掉 deleteFile 失败（无项目不删文件）", async () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const tab = screen.getByRole("tab")
    fireEvent.click(within(tab).getByLabelText("删除该会话"))
    fireEvent.click(within(tab).getByLabelText("确认删除该会话"))
    expect(mocks.chatState.deleteConversation).toHaveBeenCalledWith("conv-1")
    expect(mocks.deleteFile).not.toHaveBeenCalled() // 无 project
    await flushAsync()
  })

  it("删除会话文件失败 → role=alert 如实上报（原先静默吞掉）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    mocks.deleteFile.mockRejectedValueOnce(new Error("io-boom"))
    renderPanel()
    const tab = screen.getByRole("tab")
    fireEvent.click(within(tab).getByLabelText("删除该会话"))
    fireEvent.click(within(tab).getByLabelText("确认删除该会话"))
    // R4 共识（deepseek+qwen）: 失败细节必须保留并上屏，不再只进 console。
    expect(await screen.findByRole("alert")).toHaveTextContent(/io-boom/)
    await flushAsync()
  })

  it("会话标签外层有 role=tablist 容器（ARIA 完整性）", () => {
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
      { id: "conv-2", title: "二", createdAt: 2, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    renderPanel()
    const list = screen.getByRole("tablist")
    expect(within(list).getAllByRole("tab")).toHaveLength(2)
  })

  it("删除会话时 abortControllersRef 被清理（流进行中删除）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.conversations = [
      { id: "conv-1", title: "一", createdAt: 1, updatedAt: Date.now(), deAiMode: false },
    ]
    mocks.chatState.activeConversationId = "conv-1"
    const capturedSignal: { current: AbortSignal | null } = { current: null }
    mocks.streamChat.mockImplementation((_c: any, _m: any, _h: any, signal?: AbortSignal) => {
      capturedSignal.current = signal ?? null
      return new Promise<void>(() => {}) // 挂起
    })
    // deleteFile 失败：仍清理 token，但不再静默（失败经 setDeleteFileError 上屏）
    mocks.deleteFile.mockRejectedValueOnce(new Error("io"))
    renderPanel()
    await sendText("hello")
    expect(capturedSignal.current).not.toBeNull()
    const tab = screen.getByRole("tab")
    fireEvent.click(within(tab).getByLabelText("删除该会话"))
    fireEvent.click(within(tab).getByLabelText("确认删除该会话"))
    expect(capturedSignal.current?.aborted).toBe(true)
    expect(mocks.deleteFile).toHaveBeenCalledWith("/p/mybook/.niko-buddy/chats/conv-1.json")
    await flushAsync()
  })
})

describe("ChatPanel — 空态与输入区", () => {
  it("无活跃会话显示 hero + 建议 chips，点击 chip 自动建会话并发送", async () => {
    renderPanel()
    expect(screen.getByText("开始新对话")).toBeInTheDocument()
    expect(screen.getByText("点击「新建对话」开始")).toBeInTheDocument()
    fireEvent.click(screen.getByText("总结一下当前项目的知识结构"))
    await flushAsync()
    expect(mocks.chatState.createConversation).toHaveBeenCalled()
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "总结一下当前项目的知识结构")
    expect(mocks.streamChat).toHaveBeenCalled()
  })

  it("novel 空态显示 novel 文案与建议", () => {
    mocks.wikiState.novelMode = true
    renderPanel()
    expect(screen.getByText("开始新的写作对话")).toBeInTheDocument()
    expect(screen.getByText("点击「新建对话」开始写作")).toBeInTheDocument()
    fireEvent.click(screen.getByText("帮我梳理当前小说的世界观和主要矛盾"))
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "帮我梳理当前小说的世界观和主要矛盾")
  })

  it("有会话时渲染输入区与占位（chat/ingest 两模式）", () => {
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input")).toBeInTheDocument()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "输入消息...")
    mocks.chatState.mode = "ingest"
    rerenderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "讨论资料内容或继续追问...")
    expect(screen.queryByText("开始新对话")).toBeNull()
  })

  it("novel 模式占位 + 底部控制区（dock/toggle/模型选择）", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    expect(screen.getByTestId("chat-input-textarea")).toHaveAttribute("placeholder", "输入写作需求...")
    expect(screen.getByTestId("chat-dock-controls")).toBeInTheDocument()
    expect(screen.getByLabelText("开启深度模式")).toBeInTheDocument()
    expect(screen.getByLabelText("编辑章节")).toBeInTheDocument()
    expect(screen.getByLabelText("标记为 Style Exemplar")).toBeInTheDocument()
    expect(screen.getByTestId("chat-model-select")).toBeInTheDocument()
  })

  it("非 novel 模式不渲染 novel 专属控制", () => {
    setConversation("conv-1")
    renderPanel()
    expect(screen.queryByLabelText("开启深度模式")).toBeNull()
    expect(screen.queryByLabelText("编辑章节")).toBeNull()
    expect(screen.queryByLabelText("标记为 Style Exemplar")).toBeNull()
  })

  it("模型选择 onChange 联动 setAiChatModel + saveAiChatModel", () => {
    setConversation("conv-1")
    renderPanel()
    fireEvent.change(screen.getByTestId("chat-model-select"), { target: { value: "providerA/modelX" } })
    expect(mocks.wikiState.setAiChatModel).toHaveBeenCalledWith("providerA/modelX")
    expect(mocks.saveAiChatModel).toHaveBeenCalledWith("providerA/modelX")
  })

  it("深度模式开关切换 aria-pressed 与按钮文案", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    const toggle = screen.getByLabelText("开启深度模式")
    fireEvent.click(toggle)
    rerenderPanel()
    expect(screen.getByLabelText("关闭深度模式")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByLabelText("关闭深度模式"))
    rerenderPanel()
    expect(screen.getByLabelText("开启深度模式")).toHaveAttribute("aria-pressed", "false")
  })

  it("编辑章节开关切换 chatEditModeEnabled", () => {
    mocks.wikiState.novelMode = true
    setConversation("conv-1")
    renderPanel()
    fireEvent.click(screen.getByLabelText("编辑章节"))
    expect(mocks.wikiState.setChatEditModeEnabled).toHaveBeenCalledWith(true)
    expect(mocks.wikiState.chatEditModeEnabled).toBe(true)
  })
})

describe("ChatPanel — 消息列表与流式状态", () => {
  it("渲染消息（虚拟列表 mock 全量展开），isLastAssistant 仅最后一条助手消息", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "问题A" }),
      msg({ id: "a1", role: "assistant", content: "回答A" }),
      msg({ id: "u2", role: "user", content: "问题B" }),
      msg({ id: "a2", role: "assistant", content: "回答B" }),
    ])
    renderPanel()
    const msgs = screen.getAllByTestId("chat-message")
    expect(msgs).toHaveLength(4)
    expect(screen.getByText("问题A")).toBeInTheDocument()
    expect(screen.getByText("回答B")).toBeInTheDocument()
    const lastAssistant = msgs.find((el) => el.getAttribute("data-last") === "true")
    expect(lastAssistant?.getAttribute("data-role")).toBe("assistant")
    expect(lastAssistant?.textContent).toContain("回答B")
  })

  it("流式期间渲染 StreamingMessage 且 isLastAssistant 被抑制（按钮仍可用于停止）", () => {
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "部分回答" }),
    ])
    mocks.chatState.streamingContents = { "conv-1": "继续流式..." }
    renderPanel()
    expect(screen.getByTestId("streaming-message").textContent).toContain("继续流式...")
    const last = screen.getAllByTestId("chat-message").find((el) => el.getAttribute("data-last") === "true")
    expect(last).toBeUndefined() // isLastAssistant 被 isStreaming 抑制
    expect(screen.queryByTestId("save-status")).toBeNull()
    // 非流式恢复后 isLastAssistant 恢复
    mocks.chatState.streamingContents = {}
    rerenderPanel()
    const last2 = screen.getAllByTestId("chat-message").find((el) => el.getAttribute("data-last") === "true")
    expect(last2?.textContent).toContain("部分回答")
    expect(screen.getAllByTestId("save-as-chapter").length).toBeGreaterThan(0)
    expect(screen.getByTestId("continue-next-chapter")).toBeInTheDocument()
    expect(screen.getByTestId("continue-unfinished")).toBeInTheDocument()
    expect(screen.getByTestId("discard-draft")).toBeInTheDocument()
  })

  it("写入 wiki 按钮：ingest 模式且有助手消息时显示；点击执行写入", async () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "输出" })])
    renderPanel()
    const writeBtn = screen.getByText("写入资料库")
    expect(writeBtn).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(writeBtn)
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).toHaveBeenCalledWith("/p/mybook", mocks.wikiState.llmConfig, undefined, undefined)
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/p/mybook")
  })

  it("写入 wiki：chat 模式隐藏；ingest 模式无助手消息时隐藏", () => {
    mocks.wikiState.project = PROJECT
    mocks.chatState.mode = "chat"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })]) // 有助手消息但 chat 模式
    renderPanel()
    expect(screen.queryByText("写入资料库")).toBeNull()
    mocks.chatState.mode = "ingest"
    mocks.chatState.messages = [msg({ id: "u1", role: "user", content: "y" })]
    rerenderPanel()
    expect(screen.queryByText("写入资料库")).toBeNull() // ingest 但无助手消息
  })

  it("写入 wiki：无项目直接返回；失败上屏 role=alert；刷新失败被吞", async () => {
    mocks.chatState.mode = "ingest"
    setConversation("conv-1")
    setMessages([msg({ id: "a1", role: "assistant", content: "x" })])
    renderPanel()
    await act(async () => {
      fireEvent.click(screen.getByText("写入资料库"))
    })
    await flushAsync()
    expect(mocks.executeIngestWrites).not.toHaveBeenCalled() // 无 project

    mocks.wikiState.project = PROJECT
    rerenderPanel()
    // 阶段2：写入成功但刷新失败 → 被吞（不影响写入结果）
    mocks.executeIngestWrites.mockResolvedValueOnce([])
    mocks.refreshProjectState.mockRejectedValueOnce(new Error("refresh-boom"))
    await act(async () => {
      fireEvent.click(screen.getByText("写入资料库"))
    })
    await flushAsync()
    expect(screen.queryByTestId("write-wiki-error")).toBeNull()
    expect(screen.getByTestId("write-wiki-ok")).toBeInTheDocument()
    // 阶段3：写入失败 → 如实上屏（R4 共识 deepseek+glm：原先仅 console.error）
    mocks.executeIngestWrites.mockRejectedValueOnce(new Error("write-boom"))
    await act(async () => {
      fireEvent.click(screen.getByText("写入资料库"))
    })
    await flushAsync()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(/write-boom/)
    expect(screen.queryByTestId("write-wiki-ok")).toBeNull()
  })

  it("滚动 FAB：上滑显示，点击回底隐藏；回到底部自动隐藏", () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    const container = screen
      .getAllByTestId("chat-message")[0]
      .closest(".overflow-y-auto") as HTMLDivElement
    expect(container).not.toBeNull()
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 200 })
    // 先滚到底部（lastScrollTopRef 同步），再向上滚 → FAB 出现
    container.scrollTop = 1000
    act(() => {
      fireEvent.scroll(container)
    })
    container.scrollTop = 100
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    const fab = screen.getByLabelText("滚动到最新消息")
    expect(fab).toBeInTheDocument()
    act(() => {
      fireEvent.click(fab)
    })
    rerenderPanel()
    expect(screen.queryByLabelText("滚动到最新消息")).toBeNull()
    expect(container.scrollTop).toBe(1000)
    // 再次上滑显示，再滚到底部自动隐藏
    container.scrollTop = 100
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    expect(screen.getByLabelText("滚动到最新消息")).toBeInTheDocument()
    container.scrollTop = 760
    act(() => {
      fireEvent.scroll(container)
    })
    rerenderPanel()
    expect(screen.queryByLabelText("滚动到最新消息")).toBeNull()
  })
})

describe("ChatPanel — handleSend 主链路", () => {
  it("小说模式没有可用模型时不启动生成，并说明先去设置", async () => {
    mocks.wikiState.novelMode = true
    mocks.hasUsableLlm.mockReturnValue(false)
    renderPanel()

    await sendText("写第一章")

    expect(mocks.chatState.addMessage).toHaveBeenNthCalledWith(1, "user", "写第一章")
    expect(mocks.chatState.addMessage).toHaveBeenNthCalledWith(
      2,
      "assistant",
      expect.stringContaining("还不能开始写作"),
    )
    expect(mocks.chatState.startStreaming).not.toHaveBeenCalled()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("无项目发送：仅历史消息 + onDone finalize（含 reasoning token 与 closeReasoning）", async () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "问题A" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onReasoningToken?.("思考")
      handlers?.onReasoningToken?.("中")
      handlers?.onToken?.("回答")
      handlers?.onDone?.()
    })
    await sendText("继续")
    const [config, llmMessages, handlers] = lastStreamChatCall()
    expect(config.model).toBe("gpt-test")
    // 无 project → 无 system；历史（问题A）+ 新消息（继续）
    expect(llmMessages).toEqual([
      { role: "user", content: "问题A" },
      { role: "user", content: "继续" },
    ])
    expect(mocks.chatState.addMessage).toHaveBeenCalledWith("user", "继续")
    expect(mocks.chatState.startStreaming).toHaveBeenCalledWith("conv-1")
    expect(mocks.chatState.finalizeStream).toHaveBeenCalledWith("<think>思考中</think>回答", [], "conv-1")
    expect(handlers).toBeDefined()
    // streaming 缓冲被推理 token + 正文更新
    expect(mocks.chatState.streamingContents).toEqual({})
    await flushAsync()
  })

  it("无项目发送：空 reasoning token 与 guard 失效时跳过", async () => {
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onReasoningToken?.("") // 空 token → return
      mocks.streamGuard.isActive.mockReturnValue(false)
      handlers?.onReasoningToken?.("被忽略")
      handlers?.onToken?.("被忽略")
      mocks.streamGuard.isActive.mockReturnValue(true)
      handlers?.onToken?.("正文")
      handlers?.onDone?.()
    })
    await sendText("再来")
    expect(mocks.chatState.finalizeStream).toHaveBeenCalled()
    const content = lastFinalize()[0]
    expect(content).toBe("正文") // 被忽略的 token 未进入
  })

  it("greeting 短路：项目存在 + 打招呼 → 问候 system prompt，跳过检索", async () => {
    mocks.wikiState.project = PROJECT
    mocks.isGreeting.mockReturnValue(true)
    mocks.getOutputLanguage.mockReturnValue("English")
    setConversation("conv-1")
    renderPanel()
    await sendText("你好")
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    expect(sys.role).toBe("system")
    expect(sys.content).toContain("资料库问答助手")
    expect(sys.content).toContain("English")
    expect(mocks.searchWiki).not.toHaveBeenCalled()
    expect(lastFinalize()[1]).toEqual([]) // queryRefs 为空
  })

  it("检索链路：索引裁剪 + 图扩展 + 页面注入 + agent suffix（数组 content）+ langReminder 前置", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: undefined,
      extractedParams: {},
    })
    mocks.buildQmQuaiSystemPrompt.mockReturnValue("QM_QUAI_SKILL")
    mocks.detectEditIntent.mockReturnValue(true)
    mocks.readScopeFileContents.mockImplementation(async () => [
      { name: "chapter-003.md", path: "/p/mybook/wiki/chapters/chapter-003.md", content: "正文..." },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) {
        return ["## 章节目录", "chapter one 简介", "无关行", "## 设定", "chapter two 简介"].join("\n")
      }
      if (path.endsWith("purpose.md")) return "本书目标"
      if (path.includes("wiki/pages/a.md")) return "页面A内容" + "x".repeat(50)
      if (path.includes("wiki/pages/b.md")) return "B" + "y".repeat(20)
      return ""
    })
    mocks.computeContextBudget.mockReturnValue({ strategy: "full", maxCtx: 204800, responseReserve: 30720, indexBudget: 30, pageBudget: 2000, maxPageSize: 800, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 }, hardInjectionBudget: { capChars: 3072, baselineChars: 3072 } })
    mocks.tokenizeQuery.mockReturnValue(["chapter"])
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    mocks.buildRetrievalGraph.mockImplementation(async () => ({ nodes: new Map(), dataVersion: 0 }))
    mocks.getRelatedNodes.mockImplementation((nodeId: string, _graph: RetrievalGraph, _limit?: number) => {
      if (nodeId === "a") {
        return [
          { node: { id: "c", title: "C", path: "/p/mybook/wiki/pages/c.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 1.5 },
          { node: { id: "b", title: "B", path: "/p/mybook/wiki/pages/b.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
          { node: { id: "d", title: "D", path: "/p/mybook/wiki/pages/d.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 3.0 },
          { node: { id: "d", title: "D", path: "/p/mybook/wiki/pages/d.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
        ]
      }
      return []
    })
    mocks.detectLastGeneratedChapterNumber.mockReturnValue(2)
    mocks.resolveTargetChapterNumberForChat.mockImplementation(async () => 3)
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "上一句" })])
    renderPanel()
    await sendText("继续写下一章")
    expect(mocks.searchWiki).toHaveBeenCalledWith(
      "/p/mybook",
      "继续写下一章",
      expect.objectContaining({ rerank: true, topK: 10 }),
    )
    expect(mocks.resolveTargetChapterNumberForChat).toHaveBeenCalledWith(
      expect.objectContaining({ routeChapterNumber: undefined, lastGeneratedChapterNumber: 2 }),
    )
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]
    const sysText = Array.isArray(sys.content)
      ? sys.content.map((b: any) => b.text).join("\n")
      : sys.content
    expect(sysText).toContain("QM_QUAI_SKILL")
    // array content → agent suffix 追加为 text block
    expect(Array.isArray(sys.content)).toBe(true)
    const blocks = sys.content as { text: string }[]
    const suffixBlock = blocks[blocks.length - 1]
    expect(suffixBlock.text).toContain("AGENT_SUFFIX")
    expect(suffixBlock.text).toContain("chapter-003.md")
    // langReminder 前置到最后一条 user
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.role).toBe("user")
    expect(lastUser.content).toContain("请使用中文回复")
    expect(mocks.setLastQueryPages).toHaveBeenCalled()
    await flushAsync()
  })

  it("检索链路：预算/截断/读文件失败/overview 回退 + 索引不裁剪", async () => {
    mocks.wikiState.project = PROJECT
    mocks.computeContextBudget.mockReturnValue({ strategy: "full", maxCtx: 204800, responseReserve: 30720, indexBudget: 5000, pageBudget: 25, maxPageSize: 10, activeEntitiesBudget: { rank0Floor: 8, rank1CompressibleCap: 2000, rank2CompressibleCap: 1000 }, hardInjectionBudget: { capChars: 3072, baselineChars: 3072 } })
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) return "短索引"
      if (path.includes("wiki/pages/")) return "L".repeat(40)
      if (path.endsWith("overview.md")) return "总览内容"
      return ""
    })
    mocks.searchWiki.mockImplementation(async () => [
      { title: "A", path: "/p/mybook/wiki/pages/a.md", snippet: "", score: 0, titleMatch: true, images: [] },
      { title: "B", path: "/p/mybook/wiki/pages/b.md", snippet: "", score: 0, titleMatch: false, images: [] },
    ])
    mocks.getRelatedNodes.mockReturnValue([
      { node: { id: "c", title: "C", path: "/p/mybook/wiki/pages/c.md", type: "source", sources: [], outLinks: new Set(), inLinks: new Set(), relationEdges: [] }, relevance: 2.5 },
    ])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("index.md")) return "短索引"
      if (path.includes("wiki/pages/a.md")) return "L".repeat(40) // 截断
      if (path.includes("wiki/pages/b.md")) throw new Error("no file") // 读失败
      if (path.includes("wiki/pages/c.md")) return "L".repeat(40) // 超预算
      if (path.endsWith("overview.md")) return "总览内容"
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("查资料")
    expect(mocks.streamChat).toHaveBeenCalled()
    expect(lastFinalize()[1]).toBeDefined()
    await flushAsync()
  })

  it("overview 回退：无搜索结果且 overview 读取失败 → 提示无页面", async () => {
    mocks.wikiState.project = PROJECT
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("overview.md")) throw new Error("no overview")
      return ""
    })
    setConversation("conv-1")
    renderPanel()
    await sendText("随便问问")
    expect(mocks.buildRetrievalGraph).toHaveBeenCalled()
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]?.content as { text: string }[]
    const joined = sys.map((b) => b.text).join("\n")
    expect(joined).toContain("No wiki pages found")
    await flushAsync()
  })

  it("novel 上下文包：task/golden 指令前置 + tokenBudget 生效（buildContextPack 正常）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.wikiState.novelConfig.contextTokenBudget = 4000
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: { chapterNumber: "3" },
    })
    mocks.buildTaskDirective.mockReturnValue("TASK_DIRECTIVE")
    mocks.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: true, targetChapter: 3, requestedFirstThree: false })
    mocks.buildGoldenThreeChapterDirective.mockReturnValue("GOLDEN_DIRECTIVE")
    mocks.contextPackToPrompt.mockReturnValue("CONTEXT_PROMPT")
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(mocks.buildContextPack).toHaveBeenCalledWith("/p/mybook", "写第3章", 5)
    expect(mocks.contextPackToPrompt).toHaveBeenCalledWith(expect.anything(), 4000, {
      layeredRecall: "default",
      sectionCharBudget: 4000,
    })
    const [, llmMessages] = lastStreamChatCall()
    const sys = llmMessages[0]?.content as { text: string }[]
    const joined = sys.map((b) => b.text).join("\n")
    expect(joined).toContain("TASK_DIRECTIVE")
    expect(joined).toContain("GOLDEN_DIRECTIVE")
    expect(joined).toContain("CONTEXT_PROMPT")
    await flushAsync()
  })

  it("novel 上下文包构建失败 → 走 fallback 对象（characterAuras 空，不弹 dialog）", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({
      intent: "write_chapter",
      confidence: 1,
      chapterNumber: 3,
      extractedParams: {},
    })
    mocks.buildContextPack.mockRejectedValueOnce(new Error("pack-boom"))
    setConversation("conv-1")
    renderPanel()
    await sendText("写章节")
    expect(mocks.streamChat).toHaveBeenCalled()
    expect(screen.queryByTestId("dialog")).toBeNull()
    await flushAsync()
  })

  it("soul dialog：characterAuras 非空弹出；取消 → finalize 取消文案", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质：冷静克制",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
    }))
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("本次写作将注入角色灵魂上下文")).toBeInTheDocument()
    expect(screen.getByText("主角气质：冷静克制")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText("取消本次生成"))
    })
    await flushAsync()
    expect(lastFinalize()[0]).toContain("已取消本次生成，角色灵魂上下文未发送给模型。")
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it("soul dialog：确认继续 → 正常继续生成", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
    }))
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    await act(async () => {
      fireEvent.click(screen.getByText("继续生成"))
    })
    await flushAsync()
    expect(mocks.streamChat).toHaveBeenCalled()
    // CONTEXT_PROMPT 进入 system prompt（最终内容为空是因为无 token 输出）
    const [, confirmMessages] = lastStreamChatCall()
    const confirmSys = confirmMessages[0]?.content as { text: string }[]
    expect(confirmSys.map((b) => b.text).join("\n")).toContain("CONTEXT_PROMPT")
  })

  it("soul dialog：dialog-close（onOpenChange false）→ 取消生成并关闭", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.novelMode = true
    mocks.routeTask.mockReturnValue({ intent: "write_chapter", confidence: 1, chapterNumber: 3, extractedParams: {} })
    mocks.buildContextPack.mockImplementation(async () => ({
      task: "",
      chapterGoal: "",
      outline: "",
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "主角气质：冷静克制",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
    }))
    setConversation("conv-1")
    renderPanel()
    await sendText("写第3章")
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText("主角气质：冷静克制")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dialog-close"))
    await flushAsync()
    expect(lastFinalize()[0]).toContain("已取消本次生成，角色灵魂上下文未发送给模型。")
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(screen.queryByTestId("dialog")).toBeNull()
  })

  it("deAiMode 会话：注入 de-AI 指令（与 langReminder 叠加）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1", { deAiMode: true })
    setMessages([msg({ id: "u1", role: "user", content: "旧问题" })])
    renderPanel()
    await sendText("新问题")
    const [, llmMessages] = lastStreamChatCall()
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.content).toContain("DEAI:")
    expect(lastUser.content).toContain("请使用中文回复")
    await flushAsync()
  })

  it("langReminder 前置到最新 user 消息（历史最后一条为助手消息同样前置）", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    setMessages([
      msg({ id: "u1", role: "user", content: "q" }),
      msg({ id: "a1", role: "assistant", content: "a" }),
    ])
    renderPanel()
    await sendText("再来")
    const [, llmMessages] = lastStreamChatCall()
    const lastUser = llmMessages[llmMessages.length - 1]
    expect(lastUser.content).toContain("[请使用中文回复]")
    expect(lastUser.content).toContain("再来")
    await flushAsync()
  })

  it("streamChat onError：URL 与鉴权头脱敏后 finalize 出错文案", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    setConversation("conv-1")
    setMessages([msg({ id: "u1", role: "user", content: "q" })])
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("请求 https://api.example.com/v1 失败 Authorization: Bearer abc123"))
    })
    await sendText("提问")
    expect(errSpy).toHaveBeenCalled()
    const [content, refs] = lastFinalize()
    expect(content).toContain("出错：请求 [url] 失败")
    expect(content).toContain("[redacted]")
    expect(refs).toBeUndefined()
    errSpy.mockRestore()
  })

  it("streamChat onError：普通错误原文展示", async () => {
    setConversation("conv-1")
    renderPanel()
    mocks.streamChat.mockImplementation(async (_c: any, _m: any, handlers: any) => {
      handlers?.onError?.(new Error("plain failure"))
    })
    await sendText("提问")
    expect(lastFinalize()[0]).toContain("出错：plain failure")
  })

  it("aiChatModel 解析：空 → 使用默认 llmConfig", async () => {
    mocks.wikiState.project = PROJECT
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("gpt-test")
  })

  it("aiChatModel 解析：providerId/modelId 精确匹配（preset 命中）", async () => {
    mocks.wikiState.aiChatModel = "providerA/modelX"
    mocks.wikiState.providerConfigs = {
      providerA: { savedModels: [{ model: "modelX" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("modelX")
  })

  it("aiChatModel 解析：providerId/modelId 但 provider 未配置 → 仅覆盖 model", async () => {
    mocks.wikiState.aiChatModel = "providerZ/ghost"
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("ghost")
  })

  it("aiChatModel 解析：providerId 不在 preset 时回退 custom", async () => {
    mocks.wikiState.aiChatModel = "providerN/modelY"
    mocks.wikiState.providerConfigs = {
      providerN: { savedModels: [{ model: "modelY" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("modelY")
  })

  it("aiChatModel 解析：纯模型名匹配到 provider", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    mocks.wikiState.providerConfigs = {
      providerA: { savedModels: [{ model: "plain-model" }] },
    }
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(mocks.resolveConfig).toHaveBeenCalled()
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
  })

  it("aiChatModel 解析：纯模型名未匹配 → 回退默认 + model 覆盖", async () => {
    mocks.wikiState.aiChatModel = "plain-model"
    setConversation("conv-1")
    renderPanel()
    await sendText("hi")
    expect(lastStreamChatCall()[0].model).toBe("plain-model")
  })
})
