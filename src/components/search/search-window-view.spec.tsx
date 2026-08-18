// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SearchWindowView } from "./search-window-view"

const mocks = vi.hoisted(() => {
  const state = {
    isTauri: false,
    setProject: vi.fn(),
    setNovelMode: vi.fn(),
    searchViewOpenFile: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
    close: vi.fn(),
    emitTo: vi.fn(),
    invoke: vi.fn(async () => undefined),
    transformCallback: vi.fn((callback: (event: { payload: unknown }) => void) => {
      state.listener = callback
      return 1
    }),
    unregisterCallback: vi.fn(),
    listener: null as ((event: { payload: unknown }) => void) | null,
  }
  const currentWindow = {
    listen: state.listen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      state.listener = handler
      return state.unlisten
    }),
    close: state.close,
  }
  return { state, currentWindow }
})

vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.state.isTauri,
}))

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => mocks.currentWindow,
}))

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ emitTo: mocks.state.emitTo }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setProject: mocks.state.setProject,
    setNovelMode: mocks.state.setNovelMode,
  }),
}))

vi.mock("@/components/search/search-view", () => ({
  SearchView: (props: { onOpenFile: (payload: { path: string; scrollImageSrc?: string | null }) => void }) => (
    <div data-testid="search-view">
      <button
        data-testid="open-file"
        onClick={() => void props.onOpenFile({ path: "/project/wiki/page.md", scrollImageSrc: "media/page.png" })}
      >
        open
      </button>
    </div>
  ),
}))

const CONTEXT = {
  projectId: "p1",
  projectName: "Novel",
  projectPath: "/project",
  novelMode: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.isTauri = false
  mocks.state.listener = null
  mocks.state.invoke.mockClear()
  mocks.state.transformCallback.mockClear()
  mocks.state.unregisterCallback.mockClear()
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "search" },
      currentWebview: { label: "search" },
    },
    invoke: mocks.state.invoke,
    transformCallback: mocks.state.transformCallback,
    unregisterCallback: mocks.state.unregisterCallback,
  } as unknown as Record<string, unknown>
})

afterEach(() => {
  cleanup()
})

describe("SearchWindowView", () => {
  it("renders the loading state without a context", () => {
    render(<SearchWindowView initialContext={null} />)
    expect(screen.getByText("独立搜索")).toBeTruthy()
    expect(screen.getByText("正在加载搜索上下文...")).toBeTruthy()
    expect(screen.queryByTestId("search-view")).toBeNull()
    expect(mocks.state.setProject).not.toHaveBeenCalled()
    expect(mocks.state.setNovelMode).not.toHaveBeenCalled()
  })

  it("hydrates the wiki store and renders SearchView for an initial context", async () => {
    render(<SearchWindowView initialContext={CONTEXT} />)
    expect(screen.getByText("当前项目：Novel")).toBeTruthy()
    expect(screen.getByTestId("search-view")).toBeTruthy()
    await waitFor(() => {
      expect(mocks.state.setProject).toHaveBeenCalledWith({
        id: "p1",
        name: "Novel",
        path: "/project",
      })
      expect(mocks.state.setNovelMode).toHaveBeenCalledWith(true)
    })
    fireEvent.click(screen.getByTestId("open-file"))
    expect(mocks.state.emitTo).not.toHaveBeenCalled()
  })

  it("ignores open-file requests in browser mode", () => {
    const emitTo = mocks.state.emitTo
    render(<SearchWindowView initialContext={CONTEXT} />)
    fireEvent.click(screen.getByTestId("open-file"))
    expect(emitTo).not.toHaveBeenCalled()
    expect(mocks.state.close).not.toHaveBeenCalled()
  })

  it("listens for Tauri context updates and cleans up the listener", async () => {
    mocks.state.isTauri = true
    const { unmount } = render(<SearchWindowView initialContext={null} />)
    await waitFor(() => {
      expect(mocks.state.listen).toHaveBeenCalledWith("qmai://search-window-context", expect.any(Function))
    })
    mocks.state.listener?.({ payload: { ...CONTEXT, projectName: "Updated", novelMode: false } })
    expect(await screen.findByText("当前项目：Updated")).toBeTruthy()
    await waitFor(() => {
      expect(mocks.state.setProject).toHaveBeenCalledWith({
        id: "p1",
        name: "Updated",
        path: "/project",
      })
      expect(mocks.state.setNovelMode).toHaveBeenCalledWith(false)
    })
    unmount()
    expect(mocks.state.unlisten).toHaveBeenCalledTimes(1)
  })

  it("does not update context after the Tauri listener is cleaned up", async () => {
    mocks.state.isTauri = true
    const { unmount } = render(<SearchWindowView initialContext={null} />)
    await waitFor(() => expect(mocks.state.listener).toBeTypeOf("function"))
    const listener = mocks.state.listener
    unmount()
    listener?.({ payload: CONTEXT })
    expect(mocks.state.setProject).not.toHaveBeenCalled()
  })

  it("emits an open-file request to the main window and closes in Tauri", async () => {
    mocks.state.isTauri = true
    render(<SearchWindowView initialContext={CONTEXT} />)
    // 等 effect 的动态导入链完成（listener 就绪）再点击，避免与 handleOpenFile 的并行导入竞争
    await waitFor(() => expect(mocks.state.listener).toBeTypeOf("function"))
    fireEvent.click(screen.getByTestId("open-file"))
    await waitFor(() => {
      expect(mocks.state.emitTo).toHaveBeenCalledWith("main", "qmai://search-open-file", {
        path: "/project/wiki/page.md",
        scrollImageSrc: "media/page.png",
      })
      expect(mocks.state.close).toHaveBeenCalledTimes(1)
    })
  })

  it("swallows Tauri listener import failures", async () => {
    mocks.state.isTauri = true
    mocks.state.listen.mockRejectedValueOnce(new Error("listen failed"))
    render(<SearchWindowView initialContext={null} />)
    await waitFor(() => expect(mocks.state.listen).toHaveBeenCalled())
    expect(screen.getByText("正在加载搜索上下文...")).toBeTruthy()
  })
})
