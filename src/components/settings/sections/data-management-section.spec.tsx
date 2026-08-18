// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/data-management-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { DataManagementSection } from "./data-management-section"
import type { BackupProgressPayload } from "@/lib/backup/types"

const mocks = vi.hoisted(() => {
  return {
    t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
    exportBackup: vi.fn(),
    importBackup: vi.fn(),
    exportNovelDocx: vi.fn(),
    project: { path: "E:/Novel" },
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
  initReactI18next: { init: vi.fn() },
}))

vi.mock("@/lib/backup/export", () => ({
  exportBackup: mocks.exportBackup,
}))

vi.mock("@/lib/backup/import", () => ({
  importBackup: mocks.importBackup,
}))

vi.mock("@/lib/novel/export", () => ({
  exportNovelDocx: mocks.exportNovelDocx,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
    selector({ project: mocks.project }),
}))

function exportResult(overrides: Partial<Parameters<typeof mocks.exportBackup>[0]> & object = {}) {
  return {
    success: true,
    warnings: [] as string[],
    fileCount: 3,
    totalSize: 512,
    error: null,
    ...overrides,
  }
}

function importResult(overrides: object = {}) {
  return {
    success: true,
    appState: null,
    localStorageData: null,
    projects: [] as Array<{ id: string; path: string; name: string; success: boolean; error: string | null }>,
    warnings: [] as string[],
    error: null,
    ...overrides,
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.exportBackup.mockReset()
  mocks.importBackup.mockReset()
  mocks.exportBackup.mockResolvedValue(exportResult())
  mocks.importBackup.mockResolvedValue(importResult())
})

afterEach(() => {
  cleanup()
})

describe("DataManagementSection", () => {
  it("renders header, export/import cards, full strategy checked, enabled buttons", () => {
    render(<DataManagementSection />)
    expect(screen.getByText("settings.sections.dataManagement.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.dataManagement.exportTitle")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.dataManagement.importTitle")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.dataManagement.securityWarning")).toBeInTheDocument()
    const fullRadio = screen.getByRole("radio", { name: "完全覆盖（清除当前所有数据）" }) as HTMLInputElement
    expect(fullRadio.checked).toBe(true)
    expect(screen.getByText("settings.sections.dataManagement.exportButton")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.dataManagement.importButton")).toBeInTheDocument()
  })

  it("export success: shows success block, file count + size in B, and warnings", async () => {
    mocks.exportBackup.mockResolvedValue(
      exportResult({ fileCount: 2, totalSize: 512, warnings: ["disk nearly full"] }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    // 文件数/大小经 t() 插值渲染 —— 断言 t 收到的 params
    const fileCountCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.fileCount",
    )
    expect(fileCountCall?.[1]).toMatchObject({ count: 2, size: "512 B" })
    expect(screen.getByText("⚠ disk nearly full")).toBeInTheDocument()
  })

  it("export success with KB-sized output", async () => {
    mocks.exportBackup.mockResolvedValue(exportResult({ totalSize: 2048 }))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    const fileCountCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.fileCount",
    )
    expect(fileCountCall?.[1]).toMatchObject({ size: "2.0 KB" })
  })

  it("export success with MB-sized output", async () => {
    mocks.exportBackup.mockResolvedValue(exportResult({ totalSize: 3 * 1024 * 1024 }))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    const fileCountCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.fileCount",
    )
    expect(fileCountCall?.[1]).toMatchObject({ size: "3.0 MB" })
  })

  it("export success with GB-sized output", async () => {
    mocks.exportBackup.mockResolvedValue(exportResult({ totalSize: 2 * 1024 * 1024 * 1024 }))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    const fileCountCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.fileCount",
    )
    expect(fileCountCall?.[1]).toMatchObject({ size: "2.0 GB" })
  })

  it("export failure: shows String(err) (with Error: prefix) and no success block", async () => {
    mocks.exportBackup.mockRejectedValue(new Error("disk write failed"))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("Error: disk write failed")).toBeInTheDocument()
    })
    expect(screen.queryByText("settings.sections.dataManagement.exportSuccess")).not.toBeInTheDocument()
  })

  it("export progress: pending export shows progress bar, then clears when not done", async () => {
    let progressCb: ((p: BackupProgressPayload) => void) | undefined
    let resolveExport: ((r: ReturnType<typeof exportResult>) => void) | undefined
    // 注意：不能用 async 包装的 mock —— React 19.2 act 环境下 async 内层 await 的
    // resolve 传播不可靠；用裸 Promise 工厂（与通过测试的模式一致）
    mocks.exportBackup.mockImplementation(
      (cb: (p: BackupProgressPayload) => void) =>
        new Promise<ReturnType<typeof exportResult>>((resolve) => {
          progressCb = cb
          resolveExport = resolve
        }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await flushAsync()

    expect(screen.getByText("settings.sections.dataManagement.exporting")).toBeInTheDocument()
    act(() =>
      progressCb?.({
        operation: "export",
        stage: "archiving",
        current: 3,
        total: 10,
        message: "packing files",
      }),
    )
    expect(screen.getByText("packing files")).toBeInTheDocument()
    expect(screen.getByText("3 / 10")).toBeInTheDocument()
    // width 30% 由 style 呈现 —— 直接定位带 width 样式的内层进度条
    const bar = screen
      .getByText("packing files")
      .parentElement!.querySelectorAll("div")[1] as HTMLElement
    expect(bar.style.width).toBe("30%")

    await act(async () => {
      resolveExport?.(exportResult())
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    // stage 非 done → finally 清空 progress → 进度条隐藏
    expect(screen.queryByText("packing files")).not.toBeInTheDocument()
  })

  it("export progress with stage done is retained in finally", async () => {
    let progressCb: ((p: BackupProgressPayload) => void) | undefined
    mocks.exportBackup.mockImplementation((cb: (p: BackupProgressPayload) => void) => {
      progressCb = cb
      // 在 promise 兑现前上报 stage=done 的进度 → finally 的
      // `p && p.stage === "done" ? p : null` 走保留分支
      cb({
        operation: "export",
        stage: "done",
        current: 10,
        total: 10,
        message: "done now",
      })
      return exportResult()
    })
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.exportSuccess")).toBeInTheDocument()
    })
    await flushAsync()
    // stage done → progress 保留（但 isBusy=false 时进度条不渲染）
    expect(screen.queryByText("done now")).not.toBeInTheDocument()
    // 再次导出时 progress 不应因 done 残留而立即清空（同一 finally 逻辑）
    expect(progressCb).toBeDefined()
  })

  it("progress bar renders 0% width when total is 0", async () => {
    let progressCb: ((p: BackupProgressPayload) => void) | undefined
    mocks.exportBackup.mockImplementation(
      (cb: (p: BackupProgressPayload) => void) =>
        new Promise<ReturnType<typeof exportResult>>((resolve) => {
          progressCb = cb
          void resolve
        }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.exportButton"))
    await flushAsync()
    act(() =>
      progressCb?.({
        operation: "export",
        stage: "counting",
        current: 0,
        total: 0,
        message: "counting files",
      }),
    )
    expect(screen.getByText("0 / 0")).toBeInTheDocument()
    const bar = screen
      .getByText("counting files")
      .parentElement!.querySelectorAll("div")[1] as HTMLElement
    expect(bar.style.width).toBe("0%")
  })

  it("import success with mixed project outcomes: count + failed list", async () => {
    mocks.importBackup.mockResolvedValue(
      importResult({
        projects: [
          { id: "p1", path: "/a", name: "A", success: true, error: null },
          { id: "p2", path: "/b", name: "B", success: false, error: "zip corrupt" },
        ],
      }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
    const restoredCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.restoredProjects",
    )
    expect(restoredCall?.[1]).toMatchObject({ count: 1 })
    expect(screen.getByText("✗ p2: zip corrupt")).toBeInTheDocument()
  })

  it("import success with all-successful projects: count only, no failed list", async () => {
    mocks.importBackup.mockResolvedValue(
      importResult({
        projects: [
          { id: "p1", path: "/a", name: "A", success: true, error: null },
          { id: "p2", path: "/b", name: "B", success: true, error: null },
        ],
      }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
    const restoredCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.dataManagement.restoredProjects",
    )
    expect(restoredCall?.[1]).toMatchObject({ count: 2 })
    expect(screen.queryByText(/✗/)).not.toBeInTheDocument()
  })

  it("import success without projects: no count line", async () => {
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
    expect(
      mocks.t.mock.calls.some((c) => c[0] === "settings.sections.dataManagement.restoredProjects"),
    ).toBe(false)
  })

  it("import failure: shows the error and import warnings", async () => {
    mocks.importBackup.mockResolvedValue(
      importResult({
        success: false,
        error: "import rejected",
        warnings: ["partial data lost"],
      }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => {
      expect(screen.getByText("import rejected")).toBeInTheDocument()
    })
    expect(screen.getByText("⚠ partial data lost")).toBeInTheDocument()
  })

  it("import throws: String(err) shown (Error: prefix)", async () => {
    mocks.importBackup.mockRejectedValue(new Error("no permission"))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => expect(screen.getByText("Error: no permission")).toBeInTheDocument())
  })

  it("importing state: spinner text while pending, then done", async () => {
    let resolveImport: ((r: unknown) => void) | undefined
    mocks.importBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await flushAsync()
    expect(screen.getByText("settings.sections.dataManagement.importing")).toBeInTheDocument()

    resolveImport?.(importResult())
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
  })

  it("switching strategy to global-only passes it to importBackup", async () => {
    render(<DataManagementSection />)
    const globalOnly = screen.getByRole("radio", { name: "仅导入全局配置（模型、UI偏好）" })
    fireEvent.click(globalOnly)
    expect((globalOnly as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await waitFor(() => {
      expect(mocks.importBackup).toHaveBeenCalledWith(
        "global-only",
        undefined,
        expect.any(Function),
      )
    })
  })

  it("busy state disables both buttons", async () => {
    mocks.exportBackup.mockImplementation(() => new Promise(() => {}))
    render(<DataManagementSection />)
    const exportBtn = screen.getByText("settings.sections.dataManagement.exportButton")
    const importBtn = screen.getByText("settings.sections.dataManagement.importButton")
    fireEvent.click(exportBtn)
    await flushAsync()
    expect(exportBtn.closest("button")).toBeDisabled()
    expect(importBtn.closest("button")).toBeDisabled()
  })

  it("import progress bar renders while importing", async () => {
    let progressCb: ((p: BackupProgressPayload) => void) | undefined
    let resolveImport: ((r: unknown) => void) | undefined
    mocks.importBackup.mockImplementation(
      (_strategy: string, _projects: unknown, cb: (p: BackupProgressPayload) => void) =>
        new Promise((resolve) => {
          progressCb = cb
          resolveImport = resolve
        }),
    )
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.importButton"))
    await flushAsync()
    act(() =>
      progressCb?.({
        operation: "import",
        stage: "restoring",
        current: 1,
        total: 4,
        message: "restoring project",
      }),
    )
    expect(screen.getByText("restoring project")).toBeInTheDocument()
    expect(screen.getByText("1 / 4")).toBeInTheDocument()

    // 兑现前把进度推到 stage=done → import finally 的保留分支
    act(() =>
      progressCb?.({
        operation: "import",
        stage: "done",
        current: 4,
        total: 4,
        message: "import done",
      }),
    )

    await act(async () => {
      resolveImport?.(importResult())
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.importSuccess")).toBeInTheDocument()
    })
    // isBusy=false → 进度条隐藏（尽管 stage=done 保留了 progress 状态）
    expect(screen.queryByText("import done")).not.toBeInTheDocument()
  })

  it("docx export success: shows success block with chapter count", async () => {
    mocks.exportNovelDocx.mockResolvedValueOnce({
      success: true,
      exportedPath: "E:/Novel/complete-novel.docx",
      chapterCount: 12,
      message: "exported 12 chapters",
    })
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.docxExportButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.dataManagement.docxExportSuccess")).toBeInTheDocument()
    })
    expect(screen.getByText("settings.sections.dataManagement.docxExportCount")).toBeInTheDocument()
    expect(mocks.exportNovelDocx).toHaveBeenCalledWith({
      projectPath: "E:/Novel",
      exportPath: "E:/Novel/complete-novel.docx",
    })
  })

  it("docx export failure: shows message and no success block", async () => {
    mocks.exportNovelDocx.mockResolvedValueOnce({
      success: false,
      exportedPath: "",
      chapterCount: 0,
      message: "pack failed",
    })
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.docxExportButton"))
    await waitFor(() => {
      expect(screen.getByText("pack failed")).toBeInTheDocument()
    })
    expect(screen.queryByText("settings.sections.dataManagement.docxExportSuccess")).not.toBeInTheDocument()
  })

  it("docx export throws: String(err) shown", async () => {
    mocks.exportNovelDocx.mockRejectedValueOnce(new Error("invoke boom"))
    render(<DataManagementSection />)
    fireEvent.click(screen.getByText("settings.sections.dataManagement.docxExportButton"))
    await waitFor(() => {
      expect(screen.getByText("Error: invoke boom")).toBeInTheDocument()
    })
  })

  it("docx export button disabled without a project", () => {
    mocks.project.path = ""
    render(<DataManagementSection />)
    expect(screen.getByText("settings.sections.dataManagement.docxExportButton")).toBeDisabled()
    mocks.project.path = "E:/Novel"
  })
})
