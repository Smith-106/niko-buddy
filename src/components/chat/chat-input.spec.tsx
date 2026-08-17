// @vitest-environment jsdom
/**
 * ChatInput — 受控/非受控 draft、发送/停止、键盘 Enter/IME、可调高度（键盘 + 指针）全口径覆盖。
 * chat-store 用 vi.hoisted 可写 state mock；chat-input-resize 保持真实实现（自身已 100%）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { ChatInput } from "./chat-input"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ChatStateLike {
  activeConversationId: string | null
  conversations: Array<{ id: string; inputDraft?: string; title: string; createdAt: number; updatedAt: number; deAiMode: boolean }>
  setConversationInputDraft: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const chatState: ChatStateLike = {
    activeConversationId: null,
    conversations: [],
    setConversationInputDraft: vi.fn((id: string, draft: string) => {
      const conv = chatState.conversations.find((c) => c.id === id)
      if (conv) conv.inputDraft = draft
    }),
  }
  return { chatState }
})

vi.mock("@/stores/chat-store", () => ({
  useChatStore: (selector: (s: ChatStateLike) => unknown) => selector(mocks.chatState),
}))

function renderChatInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const onSend = props.onSend ?? vi.fn()
  const onStop = props.onStop ?? vi.fn()
  const utils = render(
    <ChatInput
      onSend={onSend}
      onStop={onStop}
      isStreaming={props.isStreaming ?? false}
      {...props}
    />,
  )
  return { ...utils, onSend: onSend as ReturnType<typeof vi.fn>, onStop: onStop as ReturnType<typeof vi.fn> }
}

function separator(): HTMLElement {
  return screen.getByRole("separator")
}

describe("ChatInput", () => {
  beforeEach(() => {
    setupDomGlobals()
    mocks.chatState.activeConversationId = null
    mocks.chatState.conversations = []
    mocks.chatState.setConversationInputDraft.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it("非受控 + 无会话：fallback draft，输入并发送后清空", () => {
    const { onSend } = renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea).toHaveValue("")
    fireEvent.change(textarea, { target: { value: "你好" } })
    expect(textarea).toHaveValue("你好")
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }))
    expect(onSend).toHaveBeenCalledWith("你好")
    expect(textarea).toHaveValue("")
  })

  it("空白内容时发送按钮禁用，handleSend 不触发", () => {
    const { onSend } = renderChatInput()
    const sendButton = screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement
    expect(sendButton).toBeDisabled()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "   " } })
    fireEvent.click(sendButton)
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("有活动会话：draft 写入 store（setConversationInputDraft）", () => {
    mocks.chatState.activeConversationId = "conv-1"
    mocks.chatState.conversations = [{ id: "conv-1", title: "t", createdAt: 1, updatedAt: 1, deAiMode: false, inputDraft: "旧草稿" }]
    const { rerender, onSend } = renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea).toHaveValue("旧草稿")
    fireEvent.change(textarea, { target: { value: "新草稿" } })
    expect(mocks.chatState.setConversationInputDraft).toHaveBeenCalledWith("conv-1", "新草稿")
    // store mock 非响应式：手动 rerender 取最新 draft
    rerender(<ChatInput onSend={onSend} onStop={vi.fn()} isStreaming={false} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("新草稿")
    expect(mocks.chatState.setConversationInputDraft).toHaveBeenLastCalledWith("conv-1", "")
  })

  it("受控模式：value 来自 prop，onChange 收到输入，prop 变化驱动重渲染", () => {
    const onChange = vi.fn()
    const { rerender, onSend } = renderChatInput({ value: "受控", onChange })
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea).toHaveValue("受控")
    fireEvent.change(textarea, { target: { value: "受控2" } })
    expect(onChange).toHaveBeenCalledWith("受控2")
    // prop 未同步 → 值保持 prop 值
    expect(textarea).toHaveValue("受控")
    rerender(
      <ChatInput
        onSend={onSend}
        onStop={vi.fn()}
        isStreaming={false}
        value="受控3"
        onChange={onChange}
      />,
    )
    expect(screen.getByRole("textbox")).toHaveValue("受控3")
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }))
    expect(onSend).toHaveBeenCalledWith("受控3")
  })

  it("流式模式：显示停止按钮、textarea 禁用、发送被拦截", () => {
    const { onStop, onSend } = renderChatInput({ isStreaming: true })
    expect(screen.getByRole("button", { name: "停止生成" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea).toBeDisabled()
    fireEvent.change(textarea, { target: { value: "x" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("leading/footer controls 渲染；inlineSendButton=false 时不渲染按钮", () => {
    const { onSend } = renderChatInput({
      leadingControls: <span data-testid="lead">lead</span>,
      footerControls: <span data-testid="foot">foot</span>,
      inlineSendButton: false,
    })
    expect(screen.getByTestId("lead")).toBeTruthy()
    expect(screen.getByTestId("foot")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "发送消息" })).toBeNull()
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it("默认 placeholder 与自定义 placeholder", () => {
    const { unmount } = renderChatInput()
    expect(screen.getByPlaceholderText("输入消息，Enter 发送，Shift+Enter 换行")).toBeTruthy()
    unmount()
    renderChatInput({ placeholder: "自定义" })
    expect(screen.getByPlaceholderText("自定义")).toBeTruthy()
  })

  it("Enter 发送（preventDefault），Shift+Enter 不发送", () => {
    const { onSend } = renderChatInput()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "内容" } })
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("内容")
  })

  it("IME 组合中 Enter 不发送（keyCode 229 / isComposing）", () => {
    const { onSend } = renderChatInput()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "拼音" } })
    // legacy keyCode 229 信号
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    // 标准 isComposing 信号（jsdom 无法从 init 构造，手动 defineProperty）
    const composingEvent = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    Object.defineProperty(composingEvent, "isComposing", { value: true })
    fireEvent(textarea, composingEvent)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("输入内容超过当前高度时自动增高（scrollHeight 分支）", () => {
    const { onSend } = renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    expect(textarea.style.height).toBe("44px")
    // jsdom scrollHeight 默认为 0 → 不高（false 分支）
    fireEvent.change(textarea, { target: { value: "普通输入" } })
    expect(textarea.style.height).toBe("44px")
    // 模拟超高内容
    Object.defineProperty(textarea, "scrollHeight", { value: 120, configurable: true })
    fireEvent.change(textarea, { target: { value: "很长很长" } })
    expect(textarea.style.height).toBe("120px")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("键盘调整高度：ArrowUp/ArrowDown/PageUp/PageDown/Home/End 与默认键", () => {
    renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const grip = separator()
    expect(grip).toHaveAttribute("role", "separator")
    expect(grip).toHaveAttribute("aria-orientation", "horizontal")
    expect(grip).toHaveAttribute("tabindex", "0")

    // ArrowUp: 44 + step(17) = 61
    fireEvent.keyDown(grip, { key: "ArrowUp" })
    expect(textarea.style.height).toBe("61px")
    // ArrowDown: 61 - 17 = 44（被 min 夹住）
    fireEvent.keyDown(grip, { key: "ArrowDown" })
    expect(textarea.style.height).toBe("44px")
    // PageUp: 44 + 85 = 129
    fireEvent.keyDown(grip, { key: "PageUp" })
    expect(textarea.style.height).toBe("129px")
    // PageDown: 129 - 85 = 44
    fireEvent.keyDown(grip, { key: "PageDown" })
    expect(textarea.style.height).toBe("44px")
    // Home → max（viewport 768 / 2 = 384）
    fireEvent.keyDown(grip, { key: "Home" })
    expect(textarea.style.height).toBe("384px")
    // End → min（44）
    fireEvent.keyDown(grip, { key: "End" })
    expect(textarea.style.height).toBe("44px")
    // 默认键不处理
    fireEvent.keyDown(grip, { key: "a" })
    expect(textarea.style.height).toBe("44px")
  })

  it("指针拖动调整高度：pointerdown/move/up 生命周期", () => {
    renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const grip = separator()

    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 7, clientY: 100, bubbles: true }))
    })
    // jsdom 无 setPointerCapture → catch 分支
    expect(document.body.style.cursor).toBe("ns-resize")

    // 向上移动 30px → 高度 +30
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientY: 70 }))
    })
    expect(textarea.style.height).toBe("74px")

    // pointerup → 清理监听、恢复光标
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }))
    })
    expect(document.body.style.cursor).toBe("")

    // 释放后再 move → 不再改变高度（监听已移除）
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientY: 40 }))
    })
    expect(textarea.style.height).toBe("74px")
  })

  it("非主键 pointerdown 直接返回（button !== 0）", () => {
    renderChatInput()
    const grip = separator()
    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { button: 2, pointerId: 9, clientY: 100, bubbles: true }))
    })
    expect(document.body.style.cursor).toBe("")
  })

  it("resize 拖到超出上限时被 clamp 到 max", () => {
    renderChatInput()
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    const grip = separator()
    // 从 44 往上拖 2000px → clamp 到 384
    act(() => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerId: 3, clientY: 2000, bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientY: 0 }))
    })
    expect(textarea.style.height).toBe("384px")
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3 }))
    })
  })

  it("separator 暴露 aria-valuenow/min/max", () => {
    renderChatInput()
    const grip = separator()
    expect(grip.getAttribute("aria-valuenow")).toBe("44")
    expect(grip.getAttribute("aria-valuemin")).toBe("44")
    expect(grip.getAttribute("aria-valuemax")).toBe("384")
    void act
  })

  it("panel 高度非有限值时忽略（Number.isFinite 防御分支）", () => {
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = () => ({ height: NaN }) as DOMRect
    try {
      const { container } = renderChatInput()
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
      // 初始渲染时 ref 未挂载，walk 不执行；触发一次 getResizeBounds 调用
      fireEvent.keyDown(separator(), { key: "Home" })
      // panelHeight 全部 NaN → 0，maxHeight 回退 viewport 一半
      expect(textarea.style.height).toBe("384px")
      expect(container).toBeTruthy()
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })
})
