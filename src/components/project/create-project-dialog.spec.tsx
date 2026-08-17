// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — CreateProjectDialog 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 *
 * 已知不可达（详见最终报告）：
 * - effect 内 `setHasInitializedPath(true)` 改变依赖 → React 重跑 effect 前先执行上一
 *   实例 cleanup（`cancelled = true`），该 flush 的微任务先于 `await resolveDefaultParentDir()`
 *   的续体入队，因此 `if (!cancelled)` 的真分支（初始化 setPath）在任何解析延迟下都不可达
 *   （实测 0/2/20/100/300ms 均不填充 path）。handleCreate 的 `path.trim() || await
 *   resolveDefaultParentDir()` 回退掩盖了该缺陷。
 * - guard `hasInitializedPath || path.trim()` 的 path.trim() 真分支：path 非空时
 *   hasInitializedPath 必已为 true（同一 effect 同步置位），短路使其不可达。
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
import { CreateProjectDialog } from "./create-project-dialog"
import type { WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => {
  const wikiState: {
    setOutputLanguage: ReturnType<typeof vi.fn>
  } = {
    setOutputLanguage: vi.fn(),
  }
  const template = {
    id: "general",
    schema: "# schema",
    purpose: "# purpose",
    extraDirs: ["wiki", "raw"],
  }
  return {
    wikiState,
    template,
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
    createProject: vi.fn(async () => ({ id: "proj-1", name: "Novel", path: "C:\\books\\novel" })),
    writeFile: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
    getExecutableDir: vi.fn(async () => "C:\\Program Files\\QMaiWrite"),
    getTemplate: vi.fn(() => template),
    saveOutputLanguage: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => null),
    buildDefaultNovelDir: vi.fn((p: string) => (p.startsWith("C:") ? "C:\\QM-BOOK" : "D:\\QM-BOOK")),
    onCreated: vi.fn(),
    onOpenChange: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", () => ({
  createProject: mocks.createProject,
  writeFile: mocks.writeFile,
  createDirectory: mocks.createDirectory,
  getExecutableDir: mocks.getExecutableDir,
}))

vi.mock("@/lib/templates", () => ({
  getTemplate: mocks.getTemplate,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/lib/project-store", () => ({
  saveOutputLanguage: mocks.saveOutputLanguage,
}))

vi.mock("@/lib/platform", () => ({
  pickDirectory: mocks.pickDirectory,
}))

vi.mock("@/lib/default-paths", () => ({
  buildDefaultNovelDir: mocks.buildDefaultNovelDir,
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderDialog(open = true): ReturnType<typeof render> {
  return render(
    <CreateProjectDialog
      open={open}
      onOpenChange={mocks.onOpenChange}
      onCreated={mocks.onCreated}
    />,
  )
}

/** Base UI Dialog 渲染在 portal 中，form 不在 RTL container 内。 */
function formOf(): HTMLFormElement {
  const form = document.querySelector("form") as HTMLFormElement
  if (!form) throw new Error("form not found")
  return form
}

function pathInput(): HTMLInputElement {
  return screen.getByLabelText("project.parentDir") as HTMLInputElement
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("project.name") as HTMLInputElement
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.getExecutableDir.mockResolvedValue("C:\\Program Files\\QMaiWrite")
  mocks.buildDefaultNovelDir.mockImplementation((p: string) =>
    p.startsWith("C:") ? "C:\\QM-BOOK" : "D:\\QM-BOOK",
  )
})

describe("CreateProjectDialog", () => {
  it("关闭状态：不渲染表单内容", () => {
    const { container } = renderDialog(false)
    expect(container.querySelector("form")).toBeNull()
    expect(screen.queryByLabelText("project.name")).not.toBeInTheDocument()
  })

  it("打开后触发默认目录初始化（getExecutableDir 被调用）", async () => {
    renderDialog(true)
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)
    // cancelled 竞态：effect cleanup 先于续体执行，path 保持为空（见文件头注释）
    expect(pathInput()).toHaveValue("")
  })

  it("getExecutableDir 失败时 catch 分支不抛错", async () => {
    mocks.getExecutableDir.mockRejectedValue(new Error("no-exec"))
    renderDialog(true)
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)
    expect(pathInput()).toHaveValue("")
  })

  it("初始化挂起期间卸载 → cancelled=true，续体不写 path（!cancelled 假分支）", async () => {
    const { unmount } = renderDialog(true)
    unmount()
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)
  })

  it("浏览目录：pickDirectory 返回目录 → 更新 path；取消 → 不变", async () => {
    renderDialog(true)
    await flushAsync()
    const browseBtn = pathInput().nextElementSibling as HTMLElement

    mocks.pickDirectory.mockResolvedValue("E:\\picked")
    fireEvent.click(browseBtn)
    await waitFor(() => {
      expect(pathInput()).toHaveValue("E:\\picked")
    })

    mocks.pickDirectory.mockResolvedValue(null)
    fireEvent.click(browseBtn)
    await flushAsync()
    expect(pathInput()).toHaveValue("E:\\picked")
  })

  it("提交空名称 → 错误提示，不调用创建", async () => {
    renderDialog(true)
    fireEvent.submit(formOf())
    await flushAsync()
    expect(screen.getByText("project.errorNameRequired")).toBeInTheDocument()
    expect(mocks.createProject).not.toHaveBeenCalled()
  })

  it("提交空白名称（仅空格）→ 同样报错", async () => {
    renderDialog(true)
    fireEvent.change(nameInput(), { target: { value: "   " } })
    fireEvent.submit(formOf())
    await flushAsync()
    expect(screen.getByText("project.errorNameRequired")).toBeInTheDocument()
    expect(mocks.createProject).not.toHaveBeenCalled()
  })

  it("创建成功：完整链路（parentDir 为空 → resolveDefaultParentDir fallback）", async () => {
    renderDialog(true)
    await flushAsync()
    // path 为空 → handleCreate 走 fallback（第二次 getExecutableDir）
    fireEvent.change(nameInput(), { target: { value: "MyBook" } })
    fireEvent.submit(formOf())
    await flushAsync()

    expect(mocks.createDirectory).toHaveBeenCalledWith("C:/QM-BOOK")
    expect(mocks.createProject).toHaveBeenCalledWith("MyBook", "C:/QM-BOOK")
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/books/novel/schema.md", "# schema")
    expect(mocks.writeFile).toHaveBeenCalledWith("C:/books/novel/purpose.md", "# purpose")
    expect(mocks.createDirectory).toHaveBeenCalledWith("C:/books/novel/wiki")
    expect(mocks.createDirectory).toHaveBeenCalledWith("C:/books/novel/raw")
    expect(mocks.wikiState.setOutputLanguage).toHaveBeenCalledWith("Chinese")
    expect(mocks.saveOutputLanguage).toHaveBeenCalledWith("Chinese", "proj-1")
    expect(mocks.onCreated).toHaveBeenCalledWith({
      id: "proj-1",
      name: "Novel",
      path: "C:\\books\\novel",
    })
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => {
      expect(nameInput()).toHaveValue("")
    })
    expect(pathInput()).toHaveValue("")
  })

  it("创建成功：显式输入 parentDir 时直接使用（path.trim() 真分支）", async () => {
    renderDialog(true)
    fireEvent.change(pathInput(), { target: { value: "E:\\books" } })
    fireEvent.change(nameInput(), { target: { value: "Novel2" } })
    fireEvent.submit(formOf())
    await flushAsync()
    expect(mocks.createProject).toHaveBeenCalledWith("Novel2", "E:/books")
    expect(mocks.createDirectory).toHaveBeenCalledWith("E:/books")
  })

  it("resolveDefaultParentDir 返回空 → parentDir 为空时报错", async () => {
    renderDialog(true)
    await flushAsync()
    // getExecutableDir 失败 → 保留 fallback 初值；buildDefaultNovelDir 返回空 → parentDir 为空
    mocks.getExecutableDir.mockRejectedValue(new Error("no-exec"))
    mocks.buildDefaultNovelDir.mockReturnValue("")
    fireEvent.change(nameInput(), { target: { value: "MyBook" } })
    fireEvent.submit(formOf())
    await flushAsync()
    expect(screen.getByText("project.errorNameRequired")).toBeInTheDocument()
    expect(mocks.createProject).not.toHaveBeenCalled()
  })

  it("创建失败：错误写入 error 状态并展示", async () => {
    renderDialog(true)
    mocks.createProject.mockRejectedValueOnce(new Error("disk full"))
    fireEvent.change(nameInput(), { target: { value: "MyBook" } })
    fireEvent.submit(formOf())
    await waitFor(() => {
      // String(err) → "Error: disk full"
      expect(screen.getByText(/disk full/)).toBeInTheDocument()
    })
    expect(mocks.onCreated).not.toHaveBeenCalled()
  })

  it("创建中重复提交被阻止（creating guard）", async () => {
    renderDialog(true)
    mocks.createProject.mockReturnValueOnce(new Promise<WikiProject>(() => {}))
    fireEvent.change(nameInput(), { target: { value: "MyBook" } })
    fireEvent.submit(formOf())
    await flushAsync()
    const submitBtn = screen.getByRole("button", { name: "project.creating" })
    expect(submitBtn).toBeDisabled()
    fireEvent.submit(formOf())
    await flushAsync()
    expect(mocks.createProject).toHaveBeenCalledTimes(1)
  })

  it("取消按钮 → onOpenChange(false)", async () => {
    renderDialog(true)
    fireEvent.click(screen.getByRole("button", { name: "project.cancel" }))
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("关闭后再打开会重新触发初始化（isOpen 假分支 + 状态重置）", async () => {
    const { rerender } = renderDialog(true)
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)

    rerender(
      <CreateProjectDialog
        open={false}
        onOpenChange={mocks.onOpenChange}
        onCreated={mocks.onCreated}
      />,
    )
    await flushAsync()

    rerender(
      <CreateProjectDialog
        open={true}
        onOpenChange={mocks.onOpenChange}
        onCreated={mocks.onCreated}
      />,
    )
    await flushAsync()
    expect(mocks.getExecutableDir.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
