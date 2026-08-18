// @vitest-environment jsdom
/**
 * FileTree — 项目空态 / 目录展开折叠 / 文件选中 / 打开项目文件夹（Tauri 与非 Tauri）全分支覆盖。
 * vi.hoisted 可写 store state（App.spec.tsx 模式）；外部依赖全部 vi.mock。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cleanup as rtlCleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    project: null,
    fileTree: [],
    selectedFile: null,
    setSelectedFile: vi.fn((v: unknown) => { state.selectedFile = v }),
  }
  return {
    state,
    tauri: { value: false },
    openProjectFolder: vi.fn(),
    dialogMessage: vi.fn(),
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: Record<string, any>) => unknown) => selector(mocks.state),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", () => ({
  openProjectFolder: mocks.openProjectFolder,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: () => mocks.tauri.value,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mocks.dialogMessage,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: (props: Record<string, any>) => <div data-testid="scroll-area">{props.children}</div>,
}))

import { FileTree } from "./file-tree"

const PROJECT = { id: "p1", name: "我的书", path: "/proj" }

function node(name: string, path: string, is_dir: boolean, children?: FileNode[]): FileNode {
  return { name, path, is_dir, children }
}

beforeEach(() => {
  vi.clearAllMocks()
  setupDomGlobals()
  mocks.state.project = null
  mocks.state.fileTree = []
  mocks.state.selectedFile = null
  mocks.tauri.value = false
  mocks.openProjectFolder.mockResolvedValue(undefined)
  mocks.dialogMessage.mockResolvedValue(undefined)
})

afterEach(() => {
  rtlCleanup()
  vi.restoreAllMocks()
})

describe("FileTree 空态与项目头", () => {
  it("无项目 → 空态文案", () => {
    render(<FileTree />)
    expect(screen.getByText("fileTree.noProject")).toBeInTheDocument()
  })

  it("有项目且空树 → 项目名 + 打开文件夹按钮", () => {
    mocks.state.project = PROJECT
    render(<FileTree />)
    expect(screen.getByText("我的书")).toBeInTheDocument()
    expect(screen.getByText("Open project folder")).toBeInTheDocument()
  })
})

describe("FileTree 目录与文件节点", () => {
  const tree: FileNode[] = [
    node("wiki", "/proj/wiki", true, [
      node("chapters", "/proj/wiki/chapters", true, [
        node("第1章.md", "/proj/wiki/chapters/第1章.md", false),
      ]),
      node("笔记.md", "/proj/wiki/笔记.md", false),
    ]),
    node("assets", "/proj/assets", true), // 无 children 的目录
    node("README.md", "/proj/README.md", false),
  ]

  it("根级目录默认展开 + 文件点击选中（qm-selected）", () => {
    mocks.state.project = PROJECT
    mocks.state.fileTree = tree
    const view = render(<FileTree />)
    // 根目录 wiki 默认展开 → 子文件可见
    expect(screen.getByText("笔记.md")).toBeInTheDocument()
    fireEvent.click(screen.getByText("笔记.md"))
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/proj/wiki/笔记.md")
    // mock store 无订阅，rerender 后重新求值 isSelected
    view.rerender(<FileTree />)
    expect(screen.getByText("笔记.md").closest("button")).toHaveClass("qm-selected")
  })

  it("目录折叠/展开切换（ChevronDown ↔ ChevronRight）", () => {
    mocks.state.project = PROJECT
    mocks.state.fileTree = tree
    render(<FileTree />)
    // wiki 展开态：子节点可见
    expect(screen.getByText("笔记.md")).toBeInTheDocument()
    fireEvent.click(screen.getByText("wiki"))
    // 折叠后子节点隐藏
    expect(screen.queryByText("笔记.md")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("wiki"))
    expect(screen.getByText("笔记.md")).toBeInTheDocument()
  })

  it("嵌套目录 depth>=1 默认折叠，展开后显示孙节点", () => {
    mocks.state.project = PROJECT
    mocks.state.fileTree = tree
    render(<FileTree />)
    // chapters 为 depth1 → 默认折叠 → 孙节点不可见
    expect(screen.queryByText("第1章.md")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("chapters"))
    expect(screen.getByText("第1章.md")).toBeInTheDocument()
  })

  it("无 children 的目录展开后无子节点；文件保持 qm-hover 样式", () => {
    mocks.state.project = PROJECT
    mocks.state.fileTree = tree
    render(<FileTree />)
    // assets 无 children：展开后不崩溃
    fireEvent.click(screen.getByText("assets"))
    expect(screen.getByText("assets")).toBeInTheDocument()
    // 未选中文件 → qm-hover
    const fileBtn = screen.getByText("README.md").closest("button") as HTMLButtonElement
    expect(fileBtn.className).toContain("qm-hover")
    expect(fileBtn.className).not.toContain("qm-selected")
  })
})

describe("FileTree 打开项目文件夹", () => {
  it("成功 → openProjectFolder(project.path)", async () => {
    mocks.state.project = PROJECT
    render(<FileTree />)
    fireEvent.click(screen.getByText("Open project folder"))
    await waitFor(() => expect(mocks.openProjectFolder).toHaveBeenCalledWith("/proj"))
  })

  it("失败且非 Tauri → window.alert 中文提示", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {})
    mocks.state.project = PROJECT
    mocks.openProjectFolder.mockRejectedValue(new Error("boom"))
    render(<FileTree />)
    fireEvent.click(screen.getByText("Open project folder"))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("无法打开项目文件夹"))
    alertSpy.mockRestore()
  })

  it("失败且 Tauri → 动态导入 plugin-dialog message 弹窗", async () => {
    mocks.tauri.value = true
    mocks.state.project = PROJECT
    mocks.openProjectFolder.mockRejectedValue(new Error("boom"))
    render(<FileTree />)
    fireEvent.click(screen.getByText("Open project folder"))
    await waitFor(() => expect(mocks.dialogMessage).toHaveBeenCalledWith(
      "Failed to open the project folder.",
      expect.objectContaining({ kind: "error" }),
    ))
    expect(mocks.t).toHaveBeenCalledWith("fileTree.openProjectFolderFailed", expect.anything())
  })

  it("失败日志 console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.project = PROJECT
    mocks.openProjectFolder.mockRejectedValue(new Error("boom"))
    render(<FileTree />)
    fireEvent.click(screen.getByText("Open project folder"))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(String(errSpy.mock.calls[0][0])).toContain("[FileTree] open project folder failed")
    errSpy.mockRestore()
  })

  it("无项目时按钮不渲染（handleOpenProjectFolder 守卫不可达）", () => {
    render(<FileTree />)
    expect(screen.queryByText("Open project folder")).not.toBeInTheDocument()
  })
})
