// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — CreateProjectDialog 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 *
 * 已修复（R3，三模型共识轮）：旧版本 effect 内 `setHasInitializedPath(true)` 置位自身依赖
 * → React 重跑 effect 前先执行上一实例 cleanup（`cancelled = true`），该 flush 的微任务先于
 * `await resolveDefaultParentDir()` 的续体入队，因此 `if (!cancelled)` 的真分支（初始化
 * setPath）在当时任何解析延迟（0/2/20/100/300ms）下都不可达——默认父目录永远填不进去。
 * 现删除该 latch 状态（仅 `path.trim()` 守位），默认目录初始化重新可达，并由下列断言覆盖。
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
    getExecutableDir: vi.fn(async () => "C:\\Program Files\\Niko Buddy"),
    getTemplate: vi.fn(() => template),
    saveOutputLanguage: vi.fn(async () => {}),
    pickDirectory: vi.fn<(dir?: string) => Promise<string | null>>(async () => null),
    buildDefaultNovelDir: vi.fn<(p: string) => string>((p: string) => (p.startsWith("C:") ? "C:\\QM-BOOK" : "D:\\QM-BOOK")),
    onCreated: vi.fn(),
    onOpenChange: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      createProject: mocks.createProject,
      writeFile: mocks.writeFile,
      createDirectory: mocks.createDirectory,
      getExecutableDir: mocks.getExecutableDir,
    
  }
})

vi.mock("@/lib/templates", () => ({
  getTemplate: mocks.getTemplate,
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

vi.mock("@/lib/project-store", () => ({
  saveOutputLanguage: mocks.saveOutputLanguage,
}))

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual,
      pickDirectory: mocks.pickDirectory,
    
  }
})

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
  mocks.getExecutableDir.mockResolvedValue("C:\\Program Files\\Niko Buddy")
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

  it("打开后填充默认父目录（默认目录初始化可达）", async () => {
    renderDialog(true)
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)
    // 旧版本此处为 ""（自取消缺陷）；修复后默认目录真正落到 path。
    expect(pathInput()).toHaveValue("C:\\QM-BOOK")
  })

  it("getExecutableDir 失败时回落到兜底默认目录，不抛错", async () => {
    mocks.getExecutableDir.mockRejectedValue(new Error("no-exec"))
    renderDialog(true)
    await flushAsync()
    expect(mocks.getExecutableDir).toHaveBeenCalledTimes(1)
    // buildDefaultNovelDir("") → mock 返回 D:\\QM-BOOK（兜底路径仍写入 path）
    expect(pathInput()).toHaveValue("D:\\QM-BOOK")
  })

  it("浏览目录失败 → 显示本地化引导 + 原始诊断，不静默", async () => {
    mocks.pickDirectory.mockRejectedValue(new Error("dialog-boom"))
    renderDialog(true)
    await flushAsync()
    const browseBtn = pathInput().nextElementSibling as HTMLElement
    fireEvent.click(browseBtn)
    await flushAsync()
    expect(mocks.pickDirectory).toHaveBeenCalled()
    expect(screen.getByText(/dialog-boom/)).toBeInTheDocument()
  })

  it("浏览目录按钮有可访问名称", async () => {
    renderDialog(true)
    expect(screen.getByLabelText("project.browseParentDir")).toBeInTheDocument()
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

  it("创建成功：完整链路（默认父目录预填）", async () => {
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
    // handleCreate 成功后 setPath("")；本用例 onOpenChange 为 mock（对话框仍 open），
    // 于是默认目录初始化 effect 再次触发并重新填入默认父目录。真实链路里 open 变 false，
    // effect 走 !isOpen 分支清空 path。
    expect(pathInput()).toHaveValue("C:\\QM-BOOK")
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

  it("resolveDefaultParentDir 返回空 → parentDir 为空时报错（父目录专用提示）", async () => {
    renderDialog(true)
    await flushAsync()
    // getExecutableDir 失败 → 保留 fallback 初值；buildDefaultNovelDir 返回空 → parentDir 为空
    mocks.getExecutableDir.mockRejectedValue(new Error("no-exec"))
    mocks.buildDefaultNovelDir.mockReturnValue("")
    // 预填修复后 path 非空，需显式清空才能走到 fallback 分支
    fireEvent.change(pathInput(), { target: { value: "" } })
    fireEvent.change(nameInput(), { target: { value: "MyBook" } })
    fireEvent.submit(formOf())
    await flushAsync()
    // 旧版本此处误用「项目名称必填」提示；现使用父目录专用文案。
    expect(screen.getByText("project.errorParentDirRequired")).toBeInTheDocument()
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
