// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — WritingWorkspace 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { WritingWorkspace } from "./writing-workspace"

const mocks = vi.hoisted(() => {
  const wikiState: {
    chatExpanded: boolean
    chatDockPosition: "bottom" | "right"
  } = {
    chatExpanded: false,
    chatDockPosition: "bottom",
  }
  return {
    wikiState,
    t: vi.fn((key: string) => key),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("./preview-panel", () => ({
  PreviewPanel: () => <div data-testid="preview-panel">preview</div>,
}))

// The lazy ChatPanel is loaded via `await import("@/components/chat/chat-panel")`.
vi.mock("@/components/chat/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel">chat</div>,
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.style.cursor = ""
  document.body.style.userSelect = ""
  delete document.body.dataset.panelResizing
})

beforeEach(() => {
  setupDomGlobals()
  mocks.wikiState.chatExpanded = false
  mocks.wikiState.chatDockPosition = "bottom"
  localStorage.clear()
})

/** Root div of the component = the containerRef element. */
function rootContainer(): HTMLElement {
  const el = document.body.querySelector("div.flex.h-full") as HTMLElement
  if (!el) throw new Error("container div not found")
  return el
}

function mockRect(el: HTMLElement, rect: { bottom: number; right: number }): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    bottom: rect.bottom,
    right: rect.right,
    top: 0,
    left: 0,
    width: rect.right,
    height: rect.bottom,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

describe("WritingWorkspace", () => {
  it("聊天关闭时只渲染 PreviewPanel（无 dock 分支）", async () => {
    render(<WritingWorkspace />)
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument()
    expect(document.querySelector('[class*="cursor-row-resize"]')).toBeNull()
    // 初始持久化 effect：写入默认值
    expect(localStorage.getItem("lk-chat-height")).toBe("260")
    expect(localStorage.getItem("lk-chat-right-width")).toBe("360")
    await act(async () => {})
  })

  it("bottom dock：渲染 resize 手柄与懒加载 ChatPanel（含 Suspense 回退）", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    render(<WritingWorkspace />)
    // Suspense 挂起阶段显示回退文案
    expect(screen.getByText("加载中...")).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    expect(screen.queryByText("加载中...")).not.toBeInTheDocument()
    const handle = document.querySelector('[class*="cursor-row-resize"]') as HTMLElement
    expect(handle).not.toBeNull()
    const chatBox = handle.nextElementSibling as HTMLElement
    expect(chatBox.style.height).toBe("260px")
  })

  it("right dock：渲染水平手柄与右侧聊天栏", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    expect(document.querySelector('[class*="cursor-col-resize"]')).not.toBeNull()
    expect(document.querySelector('[class*="cursor-row-resize"]')).toBeNull()
  })

  it("从 localStorage 恢复高度/宽度（有效值）", async () => {
    localStorage.setItem("lk-chat-height", "400")
    localStorage.setItem("lk-chat-right-width", "500")
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const chatBox = document.querySelector('[style*="width:"]') as HTMLElement
    expect(chatBox).not.toBeNull()
    expect(chatBox.style.width).toBe("500px")
    expect(localStorage.getItem("lk-chat-height")).toBe("400")
    expect(localStorage.getItem("lk-chat-right-width")).toBe("500")
  })

  it("localStorage 非法值（NaN）时保留默认值", async () => {
    localStorage.setItem("lk-chat-height", "abc")
    localStorage.setItem("lk-chat-right-width", "xyz")
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const chatBox = document.querySelector('[style*="height:"]') as HTMLElement
    expect(chatBox.style.height).toBe("260px")
    expect(localStorage.getItem("lk-chat-height")).toBe("260")
  })

  it("localStorage 值为 0（saved > 0 为 false）时保留默认值", async () => {
    localStorage.setItem("lk-chat-height", "0")
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const chatBox = document.querySelector('[style*="height:"]') as HTMLElement
    expect(chatBox.style.height).toBe("260px")
  })

  it("垂直 resize：mousemove 更新高度（clamp）并持久化，mouseup 清理", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const handle = document.querySelector('[class*="cursor-row-resize"]') as HTMLElement
    mockRect(rootContainer(), { bottom: 800, right: 800 })

    fireEvent.mouseDown(handle)
    expect(document.body.style.cursor).toBe("row-resize")
    expect(document.body.style.userSelect).toBe("none")
    expect(document.body.dataset.panelResizing).toBe("true")

    fireEvent.mouseMove(document.body, { clientY: 300 })
    const chatBox = handle.nextElementSibling as HTMLElement
    // nextHeight = 800 - 300 = 500（在 180–520 区间内）
    expect(chatBox.style.height).toBe("500px")
    expect(localStorage.getItem("lk-chat-height")).toBe("500")

    // 超过 clamp 上限
    fireEvent.mouseMove(document.body, { clientY: 100 })
    expect(chatBox.style.height).toBe("520px")

    // 低于 clamp 下限
    fireEvent.mouseMove(document.body, { clientY: 900 })
    expect(chatBox.style.height).toBe("180px")

    fireEvent.mouseUp(document.body)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
    expect(document.body.dataset.panelResizing).toBeUndefined()
  })

  it("水平 resize：mousemove 更新宽度（clamp）并持久化，mouseup 清理", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const handle = document.querySelector('[class*="cursor-col-resize"]') as HTMLElement
    mockRect(rootContainer(), { bottom: 800, right: 1200 })

    fireEvent.mouseDown(handle)
    expect(document.body.style.cursor).toBe("col-resize")
    expect(document.body.dataset.panelResizing).toBe("true")

    fireEvent.mouseMove(document.body, { clientX: 700 })
    const chatBox = handle.nextElementSibling as HTMLElement
    // nextWidth = 1200 - 700 = 500
    expect(chatBox.style.width).toBe("500px")
    expect(localStorage.getItem("lk-chat-right-width")).toBe("500")

    fireEvent.mouseMove(document.body, { clientX: 500 })
    expect(chatBox.style.width).toBe("520px")

    fireEvent.mouseMove(document.body, { clientX: 1100 })
    expect(chatBox.style.width).toBe("280px")

    fireEvent.mouseUp(document.body)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
    expect(document.body.dataset.panelResizing).toBeUndefined()
  })

  it("水平 resize 过程中组件卸载：containerRef 为 null → mousemove 早退不崩溃", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    const { unmount } = render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const handle = document.querySelector('[class*="cursor-col-resize"]') as HTMLElement
    fireEvent.mouseDown(handle)
    unmount()
    expect(() => fireEvent.mouseMove(document.body, { clientX: 200 })).not.toThrow()
    expect(() => fireEvent.mouseUp(document.body)).not.toThrow()
  })

  it("resize 过程中组件卸载：containerRef 为 null → mousemove 早退不崩溃", async () => {
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    const { unmount } = render(<WritingWorkspace />)
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
    const handle = document.querySelector('[class*="cursor-row-resize"]') as HTMLElement
    fireEvent.mouseDown(handle)
    unmount()
    // 组件卸载后 document 上的监听器仍在：containerRef.current 为 null → 早退
    expect(() => fireEvent.mouseMove(document.body, { clientY: 200 })).not.toThrow()
    expect(() => fireEvent.mouseUp(document.body)).not.toThrow()
  })
})
