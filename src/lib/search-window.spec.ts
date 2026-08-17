import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SEARCH_CONTEXT_EVENT,
  SEARCH_WINDOW_LABEL,
  getSearchWindowContextFromLocation,
  openSearchWindow,
  type SearchWindowContext,
} from "./search-window"

interface WindowLike {
  __TAURI_INTERNALS__?: unknown
  location: { search: string }
}

const tauri = vi.hoisted(() => {
  const state: {
    createdCb: ((...args: never[]) => unknown) | null
    errorCb: ((event: { payload: unknown }) => void) | null
    instances: Array<{ label: string; options: unknown }>
  } = { createdCb: null, errorCb: null, instances: [] }

  class MockWebviewWindow {
    static getByLabel = vi.fn<() => Promise<MockWebviewWindow | null>>()
    label: string
    options: unknown
    emit = vi.fn(() => Promise.resolve())
    setFocus = vi.fn(() => Promise.resolve())
    show = vi.fn(() => Promise.resolve())
    once = vi.fn((event: string, cb: (...args: never[]) => unknown) => {
      if (event === "tauri://created") state.createdCb = cb
      if (event === "tauri://error") state.errorCb = cb as (event: { payload: unknown }) => void
      // Reject so the source's `.catch(() => {})` handlers run (covered).
      return Promise.reject(new Error("mock window never created"))
    })
    constructor(label: string, options?: unknown) {
      this.label = label
      this.options = options
      state.instances.push(this)
    }
  }

  return { MockWebviewWindow, state }
})

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: tauri.MockWebviewWindow,
}))

const ctx: SearchWindowContext = {
  projectId: "proj-1",
  projectName: "我的项目",
  projectPath: "/P",
  novelMode: true,
}

function stubWindow(win: WindowLike): void {
  vi.stubGlobal("window", win)
}

function urlWithContext(): string {
  return `?searchContext=${encodeURIComponent(JSON.stringify(ctx))}`
}

beforeEach(() => {
  vi.clearAllMocks()
  tauri.MockWebviewWindow.getByLabel.mockReset()
  tauri.state.createdCb = null
  tauri.state.errorCb = null
  tauri.state.instances.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("getSearchWindowContextFromLocation", () => {
  it("returns null when window is undefined (non-browser environment)", () => {
    expect(getSearchWindowContextFromLocation()).toBeNull()
  })

  it("returns null when the searchContext param is absent", () => {
    stubWindow({ location: { search: "?other=1" } })
    expect(getSearchWindowContextFromLocation()).toBeNull()
  })

  it("returns null when the param is not valid JSON", () => {
    stubWindow({ location: { search: "?searchContext=not-json%7B" } })
    expect(getSearchWindowContextFromLocation()).toBeNull()
  })

  it("returns null when a field has the wrong type", () => {
    const bad = [
      { projectId: 1, projectName: "n", projectPath: "/P", novelMode: true },
      { projectId: "id", projectName: 2, projectPath: "/P", novelMode: true },
      { projectId: "id", projectName: "n", projectPath: 3, novelMode: true },
      { projectId: "id", projectName: "n", projectPath: "/P", novelMode: "yes" as unknown as boolean },
    ]
    for (const partial of bad) {
      stubWindow({
        location: { search: `?searchContext=${encodeURIComponent(JSON.stringify(partial))}` },
      })
      expect(getSearchWindowContextFromLocation()).toBeNull()
    }
  })

  it("returns the parsed context for valid input", () => {
    stubWindow({ location: { search: urlWithContext() } })
    expect(getSearchWindowContextFromLocation()).toEqual(ctx)
  })
})

describe("openSearchWindow", () => {
  it("returns false outside Tauri", async () => {
    expect(await openSearchWindow(ctx)).toBe(false)
  })

  it("reuses the existing search window and emits the context", async () => {
    stubWindow({ __TAURI_INTERNALS__: {}, location: { search: "" } })
    const existing = {
      emit: vi.fn(() => Promise.resolve()),
      setFocus: vi.fn(() => Promise.resolve()),
      show: vi.fn(() => Promise.resolve()),
    }
    tauri.MockWebviewWindow.getByLabel.mockResolvedValue(existing as never)

    expect(await openSearchWindow(ctx)).toBe(true)
    expect(tauri.MockWebviewWindow.getByLabel).toHaveBeenCalledWith(SEARCH_WINDOW_LABEL)
    expect(existing.emit).toHaveBeenCalledWith(SEARCH_CONTEXT_EVENT, ctx)
    expect(existing.setFocus).toHaveBeenCalled()
    expect(existing.show).toHaveBeenCalled()
    expect(tauri.state.instances).toHaveLength(0)
  })

  it("creates a new search window when none exists and emits context on creation", async () => {
    stubWindow({ __TAURI_INTERNALS__: {}, location: { search: "" } })
    tauri.MockWebviewWindow.getByLabel.mockResolvedValue(null)

    expect(await openSearchWindow(ctx)).toBe(true)

    expect(tauri.state.instances).toHaveLength(1)
    const instance = tauri.state.instances[0]
    expect(instance.label).toBe(SEARCH_WINDOW_LABEL)
    const options = instance.options as {
      title: string
      url: string
      width: number
      height: number
    }
    expect(options.title).toBe("搜索")
    expect(options.url).toBe(`/?searchContext=${encodeURIComponent(JSON.stringify(ctx))}`)
    expect(options.width).toBe(760)
    expect(options.height).toBe(860)

    // The tauri://created handler fires and emits the context into the new window.
    expect(tauri.state.createdCb).not.toBeNull()
    await tauri.state.createdCb!()
    expect(instance.emit).toHaveBeenCalledWith(SEARCH_CONTEXT_EVENT, ctx)
  })

  it("logs an error payload when the window fails to be created", async () => {
    stubWindow({ __TAURI_INTERNALS__: {}, location: { search: "" } })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    tauri.MockWebviewWindow.getByLabel.mockResolvedValue(null)

    await openSearchWindow(ctx)
    expect(tauri.state.errorCb).not.toBeNull()
    tauri.state.errorCb!({ payload: "boom" })
    expect(errorSpy).toHaveBeenCalledWith("创建搜索窗口失败:", "boom")
    errorSpy.mockRestore()
  })
})
