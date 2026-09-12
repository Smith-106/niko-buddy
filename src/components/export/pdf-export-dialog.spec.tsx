// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors
//
// F-008 PDF 导出对话框的禁用/进行态测试。
// 覆盖：正文为空时的禁用原因提示（不静默禁用）、导出中 busy 文案、完成后报告回填。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { PdfExportDialog } from "./PdfExportDialog"
import type { PdfExportReport } from "@/lib/export/pdf-client"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _opts?: Record<string, unknown>) => key),
  exportPdf: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

// 只替换 IPC 调用；`validateExportTarget` 等本地判据走真实实现（禁用态依赖它）。
vi.mock("@/lib/export/pdf-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/pdf-client")>()
  return { ...actual, exportPdf: mocks.exportPdf }
})

const REPORT: PdfExportReport = {
  target: "exports/book.pdf",
  pages: 3,
  paragraphs: 2,
  font: "NotoSerifCJKsc-Regular.otf",
  line_height_ratio: 1.5,
  bytes_written: 2048,
}

beforeEach(() => {
  mocks.exportPdf.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("PdfExportDialog 空正文与进行态", () => {
  it("正文为空时自述禁用原因，且不触发导出", () => {
    render(<PdfExportDialog projectPath="E:/Novel" title="第一章" paragraphs={[]} />)

    expect(screen.getByTestId("pdfexport-target")).toHaveValue("exports/book.pdf")
    expect(screen.getByTestId("pdfexport-empty-hint")).toHaveTextContent("pdfexport.empty.body")
    expect(screen.getByTestId("pdfexport-paragraphs")).toHaveTextContent("0")

    const submit = screen.getByTestId("pdfexport-submit")
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(mocks.exportPdf).not.toHaveBeenCalled()
  })

  it("有正文时可导出：导出中显示 busy，完成后回填报告", async () => {
    let settle: (report: PdfExportReport) => void = () => {}
    mocks.exportPdf.mockImplementation(
      () => new Promise<PdfExportReport>((resolve) => (settle = resolve)),
    )

    render(<PdfExportDialog projectPath="E:/Novel" title="第一章" paragraphs={["a", "b"]} />)

    expect(screen.queryByTestId("pdfexport-empty-hint")).toBeNull()
    const submit = screen.getByTestId("pdfexport-submit")
    expect(submit).toBeEnabled()

    fireEvent.click(submit)
    await waitFor(() => expect(submit).toHaveTextContent("pdfexport.submit.busy"))
    expect(submit).toBeDisabled()

    settle(REPORT)
    await waitFor(() => expect(screen.getByTestId("pdfexport-report")).toBeInTheDocument())
    expect(screen.getByTestId("pdfexport-report")).toHaveTextContent("pdfexport.report")
    expect(submit).toHaveTextContent("pdfexport.submit")
    expect(submit).toBeEnabled()
    expect(mocks.exportPdf).toHaveBeenCalledWith("E:/Novel", "exports/book.pdf", "第一章", [
      "a",
      "b",
    ])
  })
})
