// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors
//
// T34c 项目级备份/恢复/导出视图测试。
// 覆盖：无项目禁用、导出成功/取消/失败、口令透传、恢复确认流（open→ask→invoke）、
// 恢复取消/拒绝/失败、自动备份成功/失败。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import {
  BackupExportView,
  defaultExportName,
  type CanonExportResult,
  type CanonRestoreResult,
  type CanonAutoBackupResult,
} from "./backup-export-view"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _opts?: Record<string, unknown>) => key),
  invoke: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  ask: vi.fn(),
  project: { path: "E:/Novel", name: "Novel" } as { path: string; name: string } | null,
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
  open: mocks.open,
  ask: mocks.ask,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { project: unknown }) => unknown) => selector({ project: mocks.project }),
}))

function exportResult(overrides: Partial<CanonExportResult> = {}): CanonExportResult {
  return {
    success: true,
    warnings: [],
    fileCount: 5,
    totalSize: 2048,
    checksumSha256: "a".repeat(64),
    sidecarPath: "E:/out.zip.sha256",
    error: null,
    ...overrides,
  }
}

function restoreResult(overrides: Partial<CanonRestoreResult> = {}): CanonRestoreResult {
  return {
    success: true,
    restoredStatus: true,
    restoredDrafts: true,
    restoredCanonLancedb: true,
    restoredFiles: 5,
    checksumVerified: true,
    autoBackupPath: "E:/Novel/backups/auto/pre-restore-x.zip",
    warnings: [],
    error: null,
    ...overrides,
  }
}

function autoResult(overrides: Partial<CanonAutoBackupResult> = {}): CanonAutoBackupResult {
  return {
    success: true,
    backupPath: "E:/Novel/backups/auto/20260101-000000-pre-supersede-manual.zip",
    checksumSha256: "b".repeat(64),
    warnings: [],
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.invoke.mockReset()
  mocks.save.mockReset()
  mocks.open.mockReset()
  mocks.ask.mockReset()
  mocks.project = { path: "E:/Novel", name: "Novel" }
})

afterEach(() => {
  cleanup()
})

describe("defaultExportName", () => {
  it("formats timestamped zip name", () => {
    expect(defaultExportName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "niko-buddy-project-backup-20260102-030405.zip",
    )
  })
})

describe("BackupExportView", () => {
  it("renders three cards and disables actions without an open project", () => {
    mocks.project = null
    render(<BackupExportView />)
    expect(screen.getByText("novel.backupExport.title")).toBeInTheDocument()
    expect(screen.getByText("novel.backupExport.exportTitle")).toBeInTheDocument()
    expect(screen.getByText("novel.backupExport.restoreTitle")).toBeInTheDocument()
    expect(screen.getByText("novel.backupExport.autoTitle")).toBeInTheDocument()
    expect(screen.getByText("novel.backupExport.exportButton")).toBeDisabled()
    expect(screen.getByText("novel.backupExport.restoreButton")).toBeDisabled()
    expect(screen.getByText("novel.backupExport.autoButton")).toBeDisabled()
  })

  it("export success: invokes canon_export_project, shows checksum + sidecar", async () => {
    mocks.save.mockResolvedValue("E:/out.zip")
    mocks.invoke.mockResolvedValue(exportResult())
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalled()
    })
    expect(mocks.invoke).toHaveBeenCalledWith("canon_export_project", {
      request: { projectPath: "E:/Novel", outputZipPath: "E:/out.zip", passphrase: null },
    })
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.exportSuccess/)).toBeInTheDocument()
    })
    expect(screen.getByText(/SHA-256: a{64}/)).toBeInTheDocument()
    expect(screen.getByText(/out\.zip\.sha256/)).toBeInTheDocument()
  })

  it("export passes non-empty passphrase through", async () => {
    mocks.save.mockResolvedValue("E:/enc.zip")
    mocks.invoke.mockResolvedValue(exportResult())
    render(<BackupExportView />)
    const input = screen.getByLabelText("novel.backupExport.passphraseLabel")
    fireEvent.change(input, { target: { value: "  secret  " } })
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("canon_export_project", {
        request: { projectPath: "E:/Novel", outputZipPath: "E:/enc.zip", passphrase: "secret" },
      })
    })
  })

  it("export dialog cancel: no invoke, cancelled message", async () => {
    mocks.save.mockResolvedValue(null)
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelled")).toBeInTheDocument()
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("export invoke rejection surfaces error", async () => {
    mocks.save.mockResolvedValue("E:/out.zip")
    mocks.invoke.mockRejectedValue(new Error("boom"))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText("Error: boom")).toBeInTheDocument()
    })
  })

  it("restore happy path: open → ask confirmed → canon_restore_project invoked", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.ask.mockResolvedValue(true)
    mocks.invoke.mockResolvedValue(restoreResult())
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.restoreButton"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("canon_restore_project", {
        request: { projectPath: "E:/Novel", zipPath: "E:/backup.zip", passphrase: null },
      })
    })
    expect(mocks.ask).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.restoreSuccess/)).toBeInTheDocument()
    })
    expect(screen.getByText(/pre-restore-x\.zip/)).toBeInTheDocument()
  })

  it("restore declined at confirm: no invoke", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.ask.mockResolvedValue(false)
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.restoreButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelled")).toBeInTheDocument()
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("restore dialog cancel: no invoke", async () => {
    mocks.open.mockResolvedValue(null)
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.restoreButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelled")).toBeInTheDocument()
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("restore verification failure surfaces backend error", async () => {
    mocks.open.mockResolvedValue("E:/bad.zip")
    mocks.ask.mockResolvedValue(true)
    mocks.invoke.mockResolvedValue(
      restoreResult({
        success: false,
        restoredStatus: false,
        restoredDrafts: false,
        restoredCanonLancedb: false,
        restoredFiles: 0,
        checksumVerified: null,
        autoBackupPath: null,
        error: "SHA-256 校验和不匹配：备份文件可能已被篡改或损坏，已中止恢复",
      }),
    )
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.restoreButton"))
    await waitFor(() => {
      expect(screen.getByText(/SHA-256 校验和不匹配/)).toBeInTheDocument()
    })
  })

  it("auto backup success shows backup path", async () => {
    mocks.invoke.mockResolvedValue(autoResult())
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.autoButton"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("canon_auto_backup", {
        request: { projectPath: "E:/Novel", reason: "pre-supersede-manual" },
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.autoSuccess/)).toBeInTheDocument()
    })
    expect(screen.getByText(/pre-supersede-manual\.zip/)).toBeInTheDocument()
  })

  it("auto backup failure surfaces error", async () => {
    mocks.invoke.mockRejectedValue("nope")
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.autoButton"))
    await waitFor(() => {
      expect(screen.getByText("nope")).toBeInTheDocument()
    })
  })
})
