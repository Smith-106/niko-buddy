// @vitest-environment jsdom
/**
 * 写作工具抽屉的**传参**验证（T5 接线验收）。
 *
 * `writing-workspace.spec.tsx` 渲染的是两个面板的**真实组件**（证明入口可达），
 * 但真实组件不把 `title` / `paragraphs` / `targets` 渲染成可读 DOM，因此这里把两个
 * 面板替换成 props 记录桩，直接断言宿主派生出来的值：
 *   - PDF 导出：标题取当前章节标题、段落取去掉标题后的非空段落；
 *   - 批量替换：targets 必须是**项目相对路径**（复用既有 `getRelativePath`），
 *     且展开抽屉本身不触发任何 IPC（面板只在自身按钮被点时调用命令）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { WritingWorkspace } from "./writing-workspace"

const mocks = vi.hoisted(() => {
  const wikiState = {
    chatExpanded: false,
    chatDockPosition: "bottom" as "bottom" | "right",
    project: null as { path: string } | null,
    selectedFile: null as string | null,
    fileContent: "",
  }
  return {
    wikiState,
    t: vi.fn((key: string) => key),
    pdfProps: [] as Array<Record<string, unknown>>,
    batchProps: [] as Array<Record<string, unknown>>,
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

vi.mock("@/components/chat/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel">chat</div>,
}))

vi.mock("@/components/export/PdfExportDialog", () => ({
  PdfExportDialog: (props: Record<string, unknown>) => {
    mocks.pdfProps.push(props)
    return <div data-testid="pdf-export-dialog" />
  },
}))

vi.mock("@/components/tools/BatchReplacePanel", () => ({
  BatchReplacePanel: (props: Record<string, unknown>) => {
    mocks.batchProps.push(props)
    return <div data-testid="batch-replace-panel" />
  },
}))

beforeEach(() => {
  setupDomGlobals()
  mocks.pdfProps.length = 0
  mocks.batchProps.length = 0
  mocks.wikiState.project = { path: "C:/novels/demo" }
  mocks.wikiState.selectedFile = "C:/novels/demo/正文/第01章.md"
  mocks.wikiState.fileContent = "# 第一章 起点\n\n第一段。\n\n第二段。"
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("WritingWorkspace 写作工具抽屉传参", () => {
  it("PDF 导出收到当前章节标题与去标题后的非空段落", () => {
    render(<WritingWorkspace />)
    expect(mocks.pdfProps).toHaveLength(0)

    fireEvent.click(screen.getByTestId("workspace-tools-toggle-pdf"))
    expect(mocks.pdfProps).toHaveLength(1)
    expect(mocks.pdfProps[0]).toEqual({
      projectPath: "C:/novels/demo",
      title: "第一章 起点",
      paragraphs: ["第一段。", "第二段。"],
    })
  })

  it("批量替换收到项目相对路径（绝对路径被裁掉项目根）", () => {
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-batch"))
    expect(mocks.batchProps).toHaveLength(1)
    expect(mocks.batchProps[0]).toEqual({
      projectPath: "C:/novels/demo",
      targets: ["正文/第01章.md"],
    })
  })

  it("未选中文件时批量替换 targets 为空数组（不猜目标）", () => {
    mocks.wikiState.selectedFile = null
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-batch"))
    expect(mocks.batchProps[0]?.targets).toEqual([])
  })

  it("无章节标题时标题回退为文件名", () => {
    mocks.wikiState.selectedFile = "C:/novels/demo/正文/未命名.md"
    mocks.wikiState.fileContent = "没有标题的正文。"
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-pdf"))
    expect(mocks.pdfProps[0]?.title).toBe("未命名")
    expect(mocks.pdfProps[0]?.paragraphs).toEqual(["没有标题的正文。"])
  })

  it("展开/收起抽屉都不调用任何 IPC（面板自身按钮才触发命令）", () => {
    const invokeSpy = vi.fn()
    ;(globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: invokeSpy,
    }
    render(<WritingWorkspace />)
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-pdf"))
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-batch"))
    fireEvent.click(screen.getByTestId("workspace-tools-toggle-batch"))
    expect(invokeSpy).not.toHaveBeenCalled()
  })
})
