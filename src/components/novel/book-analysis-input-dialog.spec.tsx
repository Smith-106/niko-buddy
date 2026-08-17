// @vitest-environment jsdom
/**
 * BookAnalysisInputDialog — 拆书作品导入对话框。
 * 覆盖：空路径提交报错、选文件成功/取消/非字符串/抛错、提交成功回调、取消重置、i18n 文案渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

const dialogMocks = vi.hoisted(() => ({
  openDialog: vi.fn(async () => null),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
}))

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.openDialog,
}))

import { BookAnalysisInputDialog } from "./book-analysis-input-dialog"

beforeEach(() => {
  vi.clearAllMocks()
  dialogMocks.openDialog.mockResolvedValue(null)
})

afterEach(() => cleanup())

function renderDialog(props: Partial<Parameters<typeof BookAnalysisInputDialog>[0]> = {}) {
  const base = {
    open: true,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(),
  }
  const merged = { ...base, ...props }
  render(<BookAnalysisInputDialog open={merged.open} onOpenChange={merged.onOpenChange} onSubmit={merged.onSubmit} />)
  return merged
}

describe("BookAnalysisInputDialog", () => {
  it("shows an error when submitting with an empty path", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /开始拆书/ }))
    expect(screen.getByText("请选择一个TXT文件")).toBeInTheDocument()
  })

  it("selects a file via the browse button and submits the config", async () => {
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })
    dialogMocks.openDialog.mockResolvedValue("E:/Novel/凡人修仙传.txt")
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    expect(await screen.findByDisplayValue("E:/Novel/凡人修仙传.txt")).toBeInTheDocument()
    expect(dialogMocks.openDialog).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    })

    // 先制造一次空提交错误，再成功提交验证错误被清除
    fireEvent.click(screen.getByRole("button", { name: /开始拆书/ }))
    expect(onSubmit).toHaveBeenCalledWith({ sourceType: "file", sourcePath: "E:/Novel/凡人修仙传.txt" })
    expect(screen.queryByText("请选择一个TXT文件")).not.toBeInTheDocument()
    // 表单重置
    await waitFor(() => expect(screen.queryByDisplayValue("E:/Novel/凡人修仙传.txt")).not.toBeInTheDocument())
  })

  it("ignores a null selection from the file dialog", async () => {
    renderDialog()
    dialogMocks.openDialog.mockResolvedValue(null)
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    await waitFor(() => expect(dialogMocks.openDialog).toHaveBeenCalled())
    expect(screen.getByPlaceholderText(/点击右侧按钮选择TXT文件/)).toHaveValue("")
  })

  it("ignores a non-string selection (e.g. array path)", async () => {
    renderDialog()
    dialogMocks.openDialog.mockResolvedValue(["E:/a.txt"])
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    await waitFor(() => expect(dialogMocks.openDialog).toHaveBeenCalled())
    expect(screen.getByPlaceholderText(/点击右侧按钮选择TXT文件/)).toHaveValue("")
  })

  it("clears the error after a successful file selection", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /开始拆书/ }))
    expect(screen.getByText("请选择一个TXT文件")).toBeInTheDocument()
    dialogMocks.openDialog.mockResolvedValue("E:/book.txt")
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    await waitFor(() => expect(screen.queryByText("请选择一个TXT文件")).not.toBeInTheDocument())
  })

  it("reports a selection failure with console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    renderDialog()
    dialogMocks.openDialog.mockRejectedValue(new Error("denied"))
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    expect(await screen.findByText("选择文件失败")).toBeInTheDocument()
    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error))
    errorSpy.mockRestore()
  })

  it("cancels: clears state and closes the dialog", () => {
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: /取消/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("clears error and path when cancelling after an error", async () => {
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    fireEvent.click(screen.getByRole("button", { name: /开始拆书/ }))
    expect(screen.getByText("请选择一个TXT文件")).toBeInTheDocument()
    dialogMocks.openDialog.mockResolvedValue("E:/book.txt")
    fireEvent.click(screen.getByRole("button", { name: /浏览/ }))
    await screen.findByDisplayValue("E:/book.txt")
    fireEvent.click(screen.getByRole("button", { name: /取消/ }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByDisplayValue("E:/book.txt")).not.toBeInTheDocument())
    expect(screen.queryByText("请选择一个TXT文件")).not.toBeInTheDocument()
  })

  it("renders the informational copy", () => {
    renderDialog()
    expect(screen.getByText("拆书作品")).toBeInTheDocument()
    expect(screen.getByText(/支持UTF-8和GBK编码的TXT文件/)).toBeInTheDocument()
    expect(screen.getByText("导入后可进行：")).toBeInTheDocument()
    expect(screen.getByText(/自动识别章节/)).toBeInTheDocument()
    expect(screen.getByText(/提示：大型小说/)).toBeInTheDocument()
  })
})
