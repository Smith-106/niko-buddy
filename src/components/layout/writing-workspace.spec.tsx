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
import type { ForeshadowingStore } from "@/lib/novel"

const mocks = vi.hoisted(() => {
  const wikiState: {
    chatExpanded: boolean
    chatDockPosition: "bottom" | "right"
    project: { path: string } | null
    novelConfig: { preWriteGateMode: "warn" }
    focusMode: boolean
    setFocusMode: (v: boolean) => void
    selectedFile: string | null
    fileContent: string
    finalChapterSave: {
      filePath: string
      projectPath: string
      saving: boolean
      phase: "saving" | "saved" | "ingested" | null
    } | null
  } = {
    chatExpanded: false,
    chatDockPosition: "bottom",
    // 写作工具抽屉（PDF 导出 / 批量替换）读取这三项，mock 形状需与真实 store 一致
    project: null,
    novelConfig: { preWriteGateMode: "warn" },
    focusMode: false,
    setFocusMode: vi.fn((v: boolean) => {
      mocks.wikiState.focusMode = v
    }),
    selectedFile: null,
    fileContent: "",
    finalChapterSave: null,
  }
  return {
    wikiState,
    t: vi.fn((key: string) => key),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: Object.assign(
        (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
        { getState: () => mocks.wikiState },
      ),
    
  }
})

vi.mock("./preview-panel", () => ({
  PreviewPanel: () => <div data-testid="preview-panel">preview</div>,
}))

vi.mock("@/components/novel/export-center-view", () => ({
  ExportCenterView: () => <div data-testid="export-center-view">export</div>,
}))

vi.mock("@/components/novel/foreshadowing-panel", () => ({
  ForeshadowingPanel: () => <div data-testid="foreshadowing-panel">foreshadow</div>,
}))

vi.mock("@/components/sources/sources-view", () => ({
  SourcesView: () => <div data-testid="sources-view">sources</div>,
}))

vi.mock("@/components/search/search-view", () => ({
  SearchView: () => <div data-testid="search-view">search</div>,
}))

// The lazy ChatPanel is loaded via `await import("@/components/chat/chat-panel")`.
vi.mock("@/components/chat/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel">chat</div>,
}))

const fsMocks = vi.hoisted(() => ({ getFileModifiedTime: vi.fn(async (_path: string) => 0) }))
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, getFileModifiedTime: fsMocks.getFileModifiedTime }
})

const novelMocks = vi.hoisted(() => ({
  loadForeshadowingTracker: vi.fn(async (_path: string): Promise<ForeshadowingStore> => {
    throw new Error("not mocked")
  }),
}))
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, loadForeshadowingTracker: novelMocks.loadForeshadowingTracker }
})

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
  mocks.wikiState.project = null
  mocks.wikiState.focusMode = false
  mocks.wikiState.selectedFile = null
  mocks.wikiState.fileContent = ""
  mocks.wikiState.finalChapterSave = null
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

describe("WritingWorkspace — 专注模式最小 AI", () => {
  it("专注模式收起工具按钮与章节侧柜，保留底部状态条", async () => {
    mocks.wikiState.project = { path: "/proj" }
    mocks.wikiState.focusMode = true
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "bottom"
    render(<WritingWorkspace />)
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument()
    expect(screen.getByTestId("focus-ai-strip")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-tools-toggle-pdf")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-chapter-dock")).not.toBeInTheDocument()
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("focus-ai-toggle"))
    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
    })
  })

  it("Zen 开关常驻工具条，点击切换 focusMode", async () => {
    mocks.wikiState.project = { path: "/proj" }
    mocks.wikiState.focusMode = false
    const setFocusMode = mocks.wikiState.setFocusMode as unknown as ReturnType<typeof vi.fn>
    setFocusMode.mockClear()
    render(<WritingWorkspace />)
    const zen = screen.getByTestId("workspace-zen-toggle")
    expect(zen.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(zen)
    expect(setFocusMode).toHaveBeenCalledWith(true)
  })

  it("专注模式正文居中 max-w-4xl 阅读版心", () => {
    mocks.wikiState.project = { path: "/proj" }
    mocks.wikiState.focusMode = true
    render(<WritingWorkspace />)
    const centered = document.querySelector(".max-w-4xl")
    expect(centered).toBeTruthy()
    expect(screen.getByTestId("workspace-zen-toggle").getAttribute("aria-pressed")).toBe("true")
  })
})

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
    // 懒加载解析后 ChatPanel 挂载（挂起回退仅过渡一帧，不做同步断言）
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

/** 写作工具接线（F-008 PDF 导出 / F-007 事务式批量替换）：两个面板此前无壳层入口。 */
describe("WritingWorkspace — 写作工具抽屉接线", () => {
  it("未打开项目时不渲染工具条（不伪造环境）", () => {
    render(<WritingWorkspace />)
    expect(screen.queryByTestId("workspace-tools-bar")).toBeNull()
    expect(screen.queryByTestId("pdf-export-section")).toBeNull()
    expect(screen.queryByTestId("batch-replace-section")).toBeNull()
  })

  it("打开项目后可展开 PDF 导出（标题/段落取当前章节）与批量替换（targets 相对化）", async () => {
    mocks.wikiState.project = { path: "C:/novels/demo" }
    mocks.wikiState.selectedFile = "C:/novels/demo/正文/第01章.md"
    mocks.wikiState.fileContent = "# 第一章 起点\n\n第一段。\n\n第二段。"
    render(<WritingWorkspace />)

    const pdfToggle = screen.getByTestId("workspace-tools-toggle-pdf")
    const batchToggle = screen.getByTestId("workspace-tools-toggle-batch")
    // 展开前不渲染任何面板（不误触发 IPC）
    expect(screen.queryByTestId("pdf-export-section")).toBeNull()
    expect(screen.queryByTestId("batch-replace-section")).toBeNull()

    fireEvent.click(pdfToggle)
    expect(screen.getByTestId("pdf-export-dialog")).toBeInTheDocument()
    await waitFor(() => {
      // 段落 = 去掉标题后的非空段落数（2），标题 = 章节标题
      expect(screen.getByTestId("pdfexport-paragraphs").textContent).toContain("2")
    })
    const title = screen.getByTestId("workspace-tools-target").textContent ?? ""
    expect(title).toContain("第一章 起点")
    expect(title).toContain("第01章.md")

    fireEvent.click(batchToggle)
    expect(screen.queryByTestId("pdf-export-section")).toBeNull()
    expect(screen.getByTestId("batch-replace-section")).toBeInTheDocument()
    expect(screen.getByTestId("batchreplace-find")).toBeInTheDocument()
    // 面板已挂载但尚未预览/提交：不产生任何写入（submit 前置预览按钮存在且未点）
    expect(screen.getByTestId("batchreplace-preview")).toBeInTheDocument()
    expect(title).toContain("8字")
    expect(title).toContain("草稿")
    expect(screen.getByTestId("batch-replace-section").className).toContain("max-h-[40%]")
  })

  it("选中文件时显示本地快照 mtime（时间机器指示）", async () => {
    fsMocks.getFileModifiedTime.mockResolvedValueOnce(1720000000000)
    mocks.wikiState.project = { path: "C:/novels/demo" }
    mocks.wikiState.selectedFile = "C:/novels/demo/正文/第01章.md"
    mocks.wikiState.fileContent = "# 第一章 起点\n\n第一段。"
    render(<WritingWorkspace />)
    await waitFor(() => expect(fsMocks.getFileModifiedTime).toHaveBeenCalledWith("C:/novels/demo/正文/第01章.md"))
    expect(screen.getByTestId("workspace-tools-target").textContent).toContain("本地快照")
  })

  it("伏笔逾期注入：critical 徽标出现，点击打开伏笔抽屉", async () => {
    novelMocks.loadForeshadowingTracker.mockResolvedValue({
      lastUpdated: "2026-01-01T00:00:00.000Z",
      items: [
        { id: "o1", name: "玉佩", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        { id: "o2", name: "密信", description: "", status: "planted", plantedChapter: 8, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
    })
    mocks.wikiState.project = { path: "C:/novels/demo" }
    render(<WritingWorkspace />)
    // 水位 8：第 1 章 planted 逾期 7 章 → critical
    const alert = await screen.findByTestId("workspace-foreshadow-alert")
    expect(alert.textContent).toContain("伏笔逾期 1")
    expect(alert.textContent).toContain("严重1")
    fireEvent.click(alert)
    expect(await screen.findByTestId("foreshadowing-panel")).toBeInTheDocument()
  })

  it("伏笔无逾期 → 不显示徽标（零打扰）", async () => {
    novelMocks.loadForeshadowingTracker.mockResolvedValue({
      lastUpdated: "2026-01-01T00:00:00.000Z",
      items: [
        { id: "o2", name: "密信", description: "", status: "planted", plantedChapter: 8, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
    })
    mocks.wikiState.project = { path: "C:/novels/demo" }
    render(<WritingWorkspace />)
    await waitFor(() => expect(novelMocks.loadForeshadowingTracker).toHaveBeenCalled())
    expect(screen.queryByTestId("workspace-foreshadow-alert")).not.toBeInTheDocument()
  })

  it("Q14-A Dock 呼吸灯：critical 逾期时 dock 头出现脉冲点，无逾期时整条不渲染", async () => {
    novelMocks.loadForeshadowingTracker.mockResolvedValue({
      lastUpdated: "2026-01-01T00:00:00.000Z",
      items: [
        { id: "o1", name: "玉佩", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        { id: "o2", name: "密信", description: "", status: "planted", plantedChapter: 8, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
    })
    mocks.wikiState.project = { path: "C:/novels/demo" }
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-desk-drafts"))
    const dot = await screen.findByTestId("workspace-dock-continuity-dot")
    expect(dot.getAttribute("data-severity")).toBe("critical")
    expect(dot.textContent).toContain("严重1")
    // 脉冲点：critical 用 destructive + animate-pulse
    const pulse = dot.querySelector("span[aria-hidden='true']")
    expect(pulse?.className).toContain("animate-pulse")
    expect(pulse?.className).toContain("bg-destructive")
  })

  it("Q14-A 无逾期 → dock 呼吸灯不渲染（零打扰）", async () => {
    novelMocks.loadForeshadowingTracker.mockResolvedValue({
      lastUpdated: "2026-01-01T00:00:00.000Z",
      items: [
        { id: "o2", name: "密信", description: "", status: "planted", plantedChapter: 8, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
    })
    mocks.wikiState.project = { path: "C:/novels/demo" }
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-desk-drafts"))
    await screen.findByTestId("chapter-draft-dock")
    expect(screen.queryByTestId("workspace-dock-continuity-dot")).not.toBeInTheDocument()
  })

  it("当前章正在保存时，章节行显示保存态", () => {
    mocks.wikiState.project = { path: "C:/novels/demo" }
    mocks.wikiState.selectedFile = "C:/novels/demo/正文/第01章.md"
    mocks.wikiState.fileContent = "# 第一章 起点\n\n第一段。"
    mocks.wikiState.finalChapterSave = {
      filePath: "C:/novels/demo/正文/第01章.md",
      projectPath: "C:/novels/demo",
      saving: true,
      phase: "saving",
    }
    render(<WritingWorkspace />)
    expect(screen.getByTestId("workspace-tools-target").textContent).toContain("novel.chapter.savingAsFinal")
  })

  it("大纲、搜索、本章伏笔和书稿导出停在正文旁，不另开页面", async () => {
    mocks.wikiState.project = { path: "C:/novels/demo" }
    mocks.wikiState.chatExpanded = true
    mocks.wikiState.chatDockPosition = "right"
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-desk-outline"))
    expect(await screen.findByTestId("sources-view")).toBeTruthy()
    expect(screen.getByTestId("workspace-chapter-dock")).toBeTruthy()
    expect(screen.getByTestId("preview-panel")).toBeTruthy()
    fireEvent.click(screen.getByTestId("workspace-desk-search"))
    expect(await screen.findByTestId("search-view")).toBeTruthy()
    expect(screen.queryByTestId("sources-view")).toBeNull()
    fireEvent.click(screen.getByTestId("workspace-desk-foreshadow"))
    expect(await screen.findByTestId("foreshadowing-panel")).toBeTruthy()
    expect(screen.getByTestId("workspace-desk-drafts")).toBeTruthy()
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-manuscript"))
    expect(await screen.findByTestId("export-center-view")).toBeTruthy()
    expect(screen.getByTestId("manuscript-export-section").className).toContain("max-h-[40%]")
    expect(screen.getByTestId("chat-panel")).toBeTruthy()
  })

})
