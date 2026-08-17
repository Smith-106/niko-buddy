// @vitest-environment jsdom
/**
 * SourcesView — 大纲/预览双列与底部 Dock 布局、横向/纵向拖拽缩放、bulkIngest 横幅全分支覆盖。
 * store 使用 zustand 兼容迷你 store（订阅 + 可写 state，参照 src/App.spec.tsx 的 vi.hoisted 模式），
 * 子组件全部 vi.mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, setupDomGlobals, waitFor } from "@/test-helpers/component-test-utils"
import { SourcesView } from "./sources-view"

type DockPosition = "bottom" | "right"

interface MiniStore<T extends Record<string, unknown>> {
  getState: () => T
  setState: (partial: Partial<T>) => void
  subscribe: (listener: () => void) => () => void
}

const mocks = vi.hoisted(() => {
  function createMiniStore<T extends Record<string, unknown>>(initial: T): MiniStore<T> {
    let state = { ...initial }
    const listeners = new Set<() => void>()
    return {
      getState: () => state,
      setState: (partial: Partial<T>) => {
        state = { ...state, ...partial }
        listeners.forEach((listener) => listener())
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }
  const wiki = createMiniStore({ novelMode: true, chatDockPosition: "bottom" as DockPosition })
  const outline = createMiniStore({
    panelOpen: false,
    setPanelOpen: (v: boolean) => {
      outline.setState({ panelOpen: v })
    },
  })
  return {
    wiki,
    outline,
    t: vi.fn((key: string) => key),
    toolbarProps: {
      onBulkIngestResult: null as null | ((message: string | null) => void),
      onToggleOutlineChat: null as null | (() => void),
    },
    chatProps: { onClose: null as null | (() => void) },
    previewCalls: 0,
  }
})

vi.mock("@/stores/wiki-store", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useWikiStore: (selector: (s: unknown) => unknown) =>
      useSyncExternalStore(mocks.wiki.subscribe, () => selector(mocks.wiki.getState())),
  }
})

vi.mock("@/stores/outline-generation-store", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useOutlineGenerationStore: (selector: (s: unknown) => unknown) =>
      useSyncExternalStore(mocks.outline.subscribe, () => selector(mocks.outline.getState())),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/components/sources/outline-action-toolbar", () => ({
  OutlineActionToolbar: (props: {
    onBulkIngestResult: (message: string | null) => void
    onToggleOutlineChat: () => void
  }) => {
    mocks.toolbarProps.onBulkIngestResult = props.onBulkIngestResult
    mocks.toolbarProps.onToggleOutlineChat = props.onToggleOutlineChat
    return (
      <button data-testid="toolbar-toggle" onClick={props.onToggleOutlineChat}>
        toolbar
      </button>
    )
  },
}))

vi.mock("@/components/layout/preview-panel", () => ({
  PreviewPanel: () => {
    mocks.previewCalls += 1
    return <div>preview-panel</div>
  },
}))

vi.mock("@/components/sources/outline-chat-panel", () => ({
  OutlineChatPanel: (props: { onClose: () => void }) => {
    mocks.chatProps.onClose = props.onClose
    return <div>outline-chat</div>
  },
}))

describe("SourcesView", () => {
  beforeEach(() => {
    setupDomGlobals()
    vi.clearAllMocks()
    mocks.wiki.setState({ novelMode: true, chatDockPosition: "bottom" })
    mocks.outline.setState({ panelOpen: false })
    mocks.toolbarProps.onBulkIngestResult = null
    mocks.toolbarProps.onToggleOutlineChat = null
    mocks.chatProps.onClose = null
    mocks.previewCalls = 0
  })

  afterEach(() => {
    cleanup()
  })

  it("非 novel 模式：普通标题，无大纲工具栏", () => {
    mocks.wiki.setState({ novelMode: false })
    render(<SourcesView />)
    expect(screen.getByText("sources.title")).toBeTruthy()
    expect(screen.queryByTestId("toolbar-toggle")).toBeNull()
    expect(screen.getByText("preview-panel")).toBeTruthy()
  })

  it("novel 模式：novel 标题 + 工具栏；点击切换打开大纲聊天面板", async () => {
    render(<SourcesView />)
    expect(screen.getByText("novel.sources.title")).toBeTruthy()
    expect(screen.getByTestId("toolbar-toggle")).toBeTruthy()
    fireEvent.click(screen.getByTestId("toolbar-toggle"))
    await waitFor(() => expect(screen.getByText("outline-chat")).toBeTruthy())
  })

  it("bulkIngestResult 回调显示结果横幅，null 时隐藏", () => {
    render(<SourcesView />)
    expect(mocks.toolbarProps.onBulkIngestResult).toBeTypeOf("function")
    act(() => mocks.toolbarProps.onBulkIngestResult?.("批量导入完成：3 条"))
    expect(screen.getByText("批量导入完成：3 条")).toBeTruthy()
    act(() => mocks.toolbarProps.onBulkIngestResult?.(null))
    expect(screen.queryByText("批量导入完成：3 条")).toBeNull()
  })

  it("右 Dock：预览 + 拖拽分隔条 + 侧栏聊天；关闭回调收起", async () => {
    mocks.wiki.setState({ chatDockPosition: "right" })
    mocks.outline.setState({ panelOpen: true })
    render(<SourcesView />)
    await waitFor(() => expect(screen.getByText("outline-chat")).toBeTruthy())
    expect(screen.getByText("preview-panel")).toBeTruthy()
    const chatWrap = screen.getByText("outline-chat").parentElement as HTMLElement
    expect(chatWrap.style.width).toBe("360px")

    const divider = document.querySelector('[class*="cursor-col-resize"]') as HTMLElement
    expect(divider).toBeTruthy()
    fireEvent.mouseDown(divider)
    fireEvent.mouseMove(document, { clientX: 500 })
    fireEvent.mouseUp(document)
    // jsdom getBoundingClientRect 全 0 → newWidth 为负 → clampChatWidth 钳到 280
    expect(chatWrap.style.width).toBe("280px")
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")

    act(() => mocks.chatProps.onClose?.())
    await waitFor(() => expect(screen.queryByText("outline-chat")).toBeNull())
  })

  it("底 Dock：拖拽行分隔条改变聊天高度", async () => {
    mocks.outline.setState({ panelOpen: true })
    render(<SourcesView />)
    await waitFor(() => expect(screen.getByText("outline-chat")).toBeTruthy())
    const chatWrap = screen.getByText("outline-chat").parentElement as HTMLElement
    expect(chatWrap.style.height).toBe("300px")

    const divider = document.querySelector('[class*="cursor-row-resize"]') as HTMLElement
    expect(divider).toBeTruthy()
    fireEvent.mouseDown(divider)
    fireEvent.mouseMove(document, { clientY: 100 })
    fireEvent.mouseUp(document)
    // newHeight 为负 → clampChatHeight 钳到 180
    expect(chatWrap.style.height).toBe("180px")
    expect(document.body.style.cursor).toBe("")

    act(() => mocks.chatProps.onClose?.())
    await waitFor(() => expect(screen.queryByText("outline-chat")).toBeNull())
  })

  it("卸载后 mousemove：containerRef 为空提前返回", async () => {
    mocks.wiki.setState({ chatDockPosition: "right" })
    mocks.outline.setState({ panelOpen: true })
    const { unmount } = render(<SourcesView />)
    await waitFor(() => expect(screen.getByText("outline-chat")).toBeTruthy())
    const divider = document.querySelector('[class*="cursor-col-resize"]') as HTMLElement
    fireEvent.mouseDown(divider)
    unmount()
    // 卸载后 containerRef.current 为 null → handler 提前 return，不抛错
    fireEvent.mouseMove(document, { clientX: 400 })
    fireEvent.mouseUp(document)
    expect(mocks.previewCalls).toBeGreaterThanOrEqual(1)
  })

  it("纵向 resize 卸载后 mousemove：containerRef 为空提前返回", async () => {
    mocks.outline.setState({ panelOpen: true })
    const { unmount } = render(<SourcesView />)
    await waitFor(() => expect(screen.getByText("outline-chat")).toBeTruthy())
    const divider = document.querySelector('[class*="cursor-row-resize"]') as HTMLElement
    fireEvent.mouseDown(divider)
    unmount()
    fireEvent.mouseMove(document, { clientY: 200 })
    fireEvent.mouseUp(document)
    expect(mocks.previewCalls).toBeGreaterThanOrEqual(1)
  })

  it("面板关闭时只渲染 PreviewPanel", () => {
    render(<SourcesView />)
    expect(screen.getByText("preview-panel")).toBeTruthy()
    expect(screen.queryByText("outline-chat")).toBeNull()
    expect(screen.queryByText("Loading...")).toBeNull()
  })
})
