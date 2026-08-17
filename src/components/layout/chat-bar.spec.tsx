// @vitest-environment jsdom
/**
 * ChatBar — 底部停靠聊天栏可见性（chatExpanded + chatDockPosition）与折叠按钮全口径覆盖。
 * wiki-store 与 ChatPanel 子组件 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ChatBar } from "./chat-bar"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface WikiStateLike {
  chatExpanded: boolean
  chatDockPosition: "bottom" | "right"
  setChatExpanded: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const wikiState: WikiStateLike = {
    chatExpanded: false,
    chatDockPosition: "bottom",
    setChatExpanded: vi.fn(),
  }
  return { wikiState }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: WikiStateLike) => unknown) => selector(mocks.wikiState),
}))

vi.mock("@/components/chat/chat-panel", async () => {
  const React = await import("react")
  return {
    ChatPanel: () => React.createElement("div", { "data-testid": "mock-chat-panel" }),
  }
})

describe("ChatBar", () => {
  beforeEach(() => {
    mocks.wikiState.chatExpanded = false
    mocks.wikiState.chatDockPosition = "bottom"
    mocks.wikiState.setChatExpanded.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it("折叠时（chatExpanded=false）不渲染", () => {
    const { container } = render(<ChatBar />)
    expect(container.innerHTML).toBe("")
    expect(screen.queryByText("AI 对话")).toBeNull()
  })

  it("停靠在侧栏时即使展开也不渲染", () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    const { container } = render(<ChatBar />)
    expect(container.innerHTML).toBe("")
  })

  it("展开且停靠底部时渲染标题栏与 ChatPanel，点击折叠", () => {
    mocks.wikiState.chatExpanded = true
    render(<ChatBar />)
    expect(screen.getByText("AI 对话")).toBeTruthy()
    expect(screen.getByTestId("mock-chat-panel")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /AI 对话/ }))
    expect(mocks.wikiState.setChatExpanded).toHaveBeenCalledWith(false)
  })
})
