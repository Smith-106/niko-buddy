// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors
//
// T34c 项目级备份/恢复/导出视图测试。
// 覆盖：无项目禁用、导出成功/取消/失败、口令透传、恢复确认流（open→ask→invoke）、
// 恢复取消/拒绝/失败、自动备份成功/失败。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import { act, fireEvent, render, screen } from "@/test-helpers/component-test-utils"
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
  listDir: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  listenHandler: null as ((event: { payload: unknown }) => void) | null,
  project: { path: "E:/Novel", name: "Novel" } as { path: string; name: string } | null,
  isTauri: true,
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/lib/platform", () => ({
  // 默认 true（既有用例全是桌面运行时）；浏览器预览降级用例显式改 false。
  isTauri: () => mocks.isTauri,
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDir,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: unknown }) => unknown) => selector({ project: mocks.project }),
    
  }
})

// 接线测试只需要面板的入参契约；面板自身的行为由其 e2e（cloud-backup / timemachine）覆盖。
vi.mock("@/components/backup/CloudBackupPanel", () => ({
  CloudBackupPanel: ({ projectPath, deviceId }: { projectPath: string; deviceId: string }) => (
    <div data-testid="mock-cloud-backup">{`${projectPath}|${deviceId}`}</div>
  ),
}))

vi.mock("@/components/timemachine/SnapshotTimeline", () => ({
  SnapshotTimeline: ({ projectPath }: { projectPath: string }) => (
    <div data-testid="mock-snapshot-timeline">{projectPath}</div>
  ),
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
  mocks.listDir.mockReset()
  mocks.listDir.mockResolvedValue([
    { name: "20260102-000000-auto.zip", path: "E:/Novel/backups/auto/20260102-000000-auto.zip" },
  ])
  mocks.listen.mockReset()
  mocks.unlisten.mockReset()
  mocks.listenHandler = null
  mocks.listen.mockImplementation((_event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listenHandler = handler
    return Promise.resolve(mocks.unlisten)
  })
  mocks.project = { path: "E:/Novel", name: "Novel" }
  mocks.isTauri = true
  localStorage.clear()
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

  it("浏览器预览（非 Tauri）→ 不订阅 backup-progress、不读 backups/auto（安全降级）", async () => {
    mocks.isTauri = false
    render(<BackupExportView />)

    // 进度事件通道只在桌面运行时注册：web 模式下 listen 一次都不能调
    expect(mocks.listen).not.toHaveBeenCalled()
    // 备份历史刷新同样早退，不去碰磁盘
    expect(mocks.listDir).not.toHaveBeenCalled()
    // 界面照常渲染三张卡（降级不等于白屏）
    expect(screen.getByText("novel.backupExport.exportTitle")).toBeInTheDocument()
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

describe("接线：云端备份（F-004）与快照时间机器（F-002）", () => {
  it("两个面板均被挂载，且拿到项目路径", () => {
    render(<BackupExportView />)
    expect(screen.getByTestId("mock-cloud-backup")).toHaveTextContent("E:/Novel")
    expect(screen.getByTestId("mock-snapshot-timeline")).toHaveTextContent("E:/Novel")
  })

  it("deviceId 首次渲染即生成并持久化到 niko-buddy.deviceId", () => {
    render(<BackupExportView />)
    const persisted = localStorage.getItem("niko-buddy.deviceId")
    expect(persisted).toMatch(/^dev-[A-Za-z0-9_-]+$/)
    expect(screen.getByTestId("mock-cloud-backup")).toHaveTextContent(`E:/Novel|${persisted}`)
  })

  it("deviceId 可编辑：清洗非法字符并写回 localStorage，同时流向下游面板", () => {
    render(<BackupExportView />)
    const input = screen.getByLabelText("novel.backupExport.deviceIdLabel")
    fireEvent.change(input, { target: { value: "desk top/01" } })
    expect(localStorage.getItem("niko-buddy.deviceId")).toBe("desktop01")
    expect(screen.getByTestId("mock-cloud-backup")).toHaveTextContent("E:/Novel|desktop01")
  })

  it("无打开项目时不给面板，改为提示先打开项目（不伪造环境）", () => {
    mocks.project = null
    render(<BackupExportView />)
    expect(screen.queryByTestId("mock-cloud-backup")).toBeNull()
    expect(screen.queryByTestId("mock-snapshot-timeline")).toBeNull()
    expect(screen.getByText("novel.backupExport.needsProject")).toBeInTheDocument()
  })
})

describe("历史版本一键恢复", () => {
  it("历史行恢复按钮：确认后直接用 entry.path 恢复并显示成功", async () => {
    mocks.ask.mockResolvedValue(true)
    mocks.invoke.mockResolvedValue(restoreResult())
    render(<BackupExportView />)
    const btn = await screen.findByTestId("restore-history-20260102-000000-auto.zip")
    expect(btn).toHaveTextContent("novel.backupExport.restoreHistory")
    expect(btn).toHaveAttribute(
      "aria-label",
      expect.stringContaining("20260102-000000-auto.zip"),
    )
    fireEvent.click(btn)
    await waitFor(() => {
      expect(mocks.ask).toHaveBeenCalled()
    })
    expect(mocks.open).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("canon_restore_project", {
        request: {
          projectPath: "E:/Novel",
          zipPath: "E:/Novel/backups/auto/20260102-000000-auto.zip",
          passphrase: null,
        },
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.restoreSuccess/)).toBeInTheDocument()
    })
  })

  it("历史恢复拒绝确认：无 invoke", async () => {
    mocks.ask.mockResolvedValue(false)
    render(<BackupExportView />)
    const btn = await screen.findByTestId("restore-history-20260102-000000-auto.zip")
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelled")).toBeInTheDocument()
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})

describe("增补：恢复前校验（canon_verify_export）", () => {
  function verifyResult(overrides: Record<string, unknown> = {}) {
    return {
      success: true,
      containerChecksumMatches: true,
      computedChecksum: "c".repeat(64),
      manifestFound: true,
      fileCount: 7,
      contentDigestVerified: true,
      warnings: [],
      error: null,
      ...overrides,
    }
  }

  it("校验取消：open 返回 null → 取消文案，无 invoke", async () => {
    mocks.open.mockResolvedValue(null)
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.verifyButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelled")).toBeInTheDocument()
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("校验成功：展示内容摘要校验与 SHA", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.invoke.mockResolvedValue(verifyResult())
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.verifyButton"))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("canon_verify_export", {
        request: { zipPath: "E:/backup.zip", passphrase: null },
      })
    })
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.verifySuccess/)).toBeInTheDocument()
    })
    expect(screen.getByText(/SHA-256: c{64}/)).toBeInTheDocument()
  })

  it("校验成功但无 sidecar：提示只做了包内完整性检查", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.invoke.mockResolvedValue(verifyResult({ containerChecksumMatches: null }))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.verifyButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.verifyShaMissing")).toBeInTheDocument()
    })
  })

  it("校验返回失败：展示后端错误", async () => {
    mocks.open.mockResolvedValue("E:/bad.zip")
    mocks.invoke.mockResolvedValue(
      verifyResult({ success: false, error: "manifest 缺失：不是有效的备份包" }),
    )
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.verifyButton"))
    await waitFor(() => {
      expect(screen.getByText("manifest 缺失：不是有效的备份包")).toBeInTheDocument()
    })
  })

  it("校验 invoke 抛错：展示错误", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.invoke.mockRejectedValue(new Error("校验通道炸了"))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.verifyButton"))
    await waitFor(() => {
      expect(screen.getByText("Error: 校验通道炸了")).toBeInTheDocument()
    })
  })

  it("恢复 invoke 抛错：展示错误", async () => {
    mocks.open.mockResolvedValue("E:/backup.zip")
    mocks.ask.mockResolvedValue(true)
    mocks.invoke.mockRejectedValue(new Error("恢复通道炸了"))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.restoreButton"))
    await waitFor(() => {
      expect(screen.getByText("Error: 恢复通道炸了")).toBeInTheDocument()
    })
  })

  it("历史恢复 invoke 抛错：展示错误", async () => {
    mocks.ask.mockResolvedValue(true)
    mocks.invoke.mockRejectedValue(new Error("历史恢复炸了"))
    render(<BackupExportView />)
    const btn = await screen.findByTestId("restore-history-20260102-000000-auto.zip")
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByText("Error: 历史恢复炸了")).toBeInTheDocument()
    })
  })
})

describe("增补：formatSize 全档位 / Warnings / 历史排序与容错 / 分页", () => {
  it("导出 B 档：500 B 原样展示", async () => {
    mocks.save.mockResolvedValue("E:/small.zip")
    mocks.invoke.mockResolvedValue(exportResult({ totalSize: 500, checksumSha256: null }))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText(/novel\.backupExport\.exportSuccess/)).toBeInTheDocument()
    })
    expect(screen.getByText(/500 B/)).toBeInTheDocument()
  })

  it("导出 MB 档：5.0 MB", async () => {
    mocks.save.mockResolvedValue("E:/mid.zip")
    mocks.invoke.mockResolvedValue(exportResult({ totalSize: 5 * 1024 * 1024 }))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument()
    })
  })

  it("导出 GB 档：2.0 GB", async () => {
    mocks.save.mockResolvedValue("E:/big.zip")
    mocks.invoke.mockResolvedValue(exportResult({ totalSize: 2 * 1024 * 1024 * 1024 }))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText(/2\.0 GB/)).toBeInTheDocument()
    })
  })

  it("导出 warnings 非空：逐条渲染告警", async () => {
    mocks.save.mockResolvedValue("E:/out.zip")
    mocks.invoke.mockResolvedValue(exportResult({ warnings: ["磁盘空间不足"] }))
    render(<BackupExportView />)
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(screen.getByText(/磁盘空间不足/)).toBeInTheDocument()
    })
  })

  it("历史列表：过滤非 zip、按名称倒序", async () => {
    mocks.listDir.mockResolvedValue([
      { name: "notes.txt", path: "E:/Novel/backups/auto/notes.txt" },
      { name: "20260101-000000-auto.zip", path: "E:/Novel/backups/auto/20260101-000000-auto.zip" },
      { name: "20260103-000000-auto.zip", path: "E:/Novel/backups/auto/20260103-000000-auto.zip" },
    ])
    render(<BackupExportView />)
    await waitFor(() => {
      expect(screen.getByTestId("restore-history-20260103-000000-auto.zip")).toBeInTheDocument()
    })
    expect(screen.getByTestId("restore-history-20260101-000000-auto.zip")).toBeInTheDocument()
    expect(screen.queryByText("notes.txt")).toBeNull()
    const items = screen.getAllByRole("listitem")
    expect(items[0].textContent).toContain("20260103-000000-auto.zip")
  })

  it("历史读取失败（目录尚不存在）：展示空态，不打扰用户", async () => {
    mocks.listDir.mockRejectedValue(new Error("no dir"))
    render(<BackupExportView />)
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.historyEmpty")).toBeInTheDocument()
    })
  })

  it("历史分页：21 条分两页，可前后翻", async () => {
    const entries = Array.from({ length: 21 }, (_, i) => {
      const name = `202601${String(i + 1).padStart(2, "0")}-000000-auto.zip`
      return { name, path: `E:/Novel/backups/auto/${name}` }
    })
    mocks.listDir.mockResolvedValue(entries)
    render(<BackupExportView />)
    await waitFor(() => {
      expect(screen.getByTestId("pagination")).toBeInTheDocument()
    })
    // 第一页：最新的 20 条在，最后一页的老条目不在
    expect(screen.getByTestId("restore-history-20260121-000000-auto.zip")).toBeInTheDocument()
    expect(screen.queryByTestId("restore-history-20260101-000000-auto.zip")).toBeNull()
    fireEvent.click(screen.getByTestId("pagination-next"))
    await waitFor(() => {
      expect(screen.getByTestId("restore-history-20260101-000000-auto.zip")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("restore-history-20260121-000000-auto.zip")).toBeNull()
    fireEvent.click(screen.getByTestId("pagination-prev"))
    await waitFor(() => {
      expect(screen.getByTestId("restore-history-20260121-000000-auto.zip")).toBeInTheDocument()
    })
  })
})

describe("增补：backup-progress 订阅与取消", () => {
  function emitProgress(payload: Record<string, unknown>) {
    expect(mocks.listenHandler).not.toBeNull()
    act(() => {
      mocks.listenHandler?.({ payload })
    })
  }

  // 进度区只在有进行中的操作（isBusy !== null）时渲染：让 save 对话框挂起，
  // 使导出停在 isBusy === "export"，再推进度事件。
  async function startHangingExport() {
    mocks.save.mockImplementationOnce(() => new Promise(() => {}))
    render(<BackupExportView />)
    await waitFor(() => {
      expect(mocks.listen).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByText("novel.backupExport.exportButton"))
    await waitFor(() => {
      expect(mocks.save).toHaveBeenCalled()
    })
  }

  it("订阅 backup-progress 通道：进度条按 current/total 渲染", async () => {
    await startHangingExport()
    expect(mocks.listen).toHaveBeenCalledWith("backup-progress", expect.any(Function))
    emitProgress({ stage: "导出中", current: 3, total: 10, message: "" })
    await waitFor(() => {
      expect(screen.getByTestId("backup-progress-area")).toBeInTheDocument()
    })
    expect(screen.getByText(/3\/10/)).toBeInTheDocument()
    expect(screen.getByText(/30%/)).toBeInTheDocument()
  })

  it("取消进行中的导出：透传 cancel_backup", async () => {
    await startHangingExport()
    emitProgress({ stage: "导出中", current: 1, total: 4, message: "" })
    const cancelBtn = await screen.findByText("novel.backupExport.cancelButton")
    fireEvent.click(cancelBtn)
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_backup")
    })
  })

  it("取消中重复点击：第二次直接返回（防重入）", async () => {
    let releaseCancel!: () => void
    mocks.invoke.mockImplementationOnce(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "cancel_backup") {
            releaseCancel = () => resolve(undefined)
          } else {
            resolve(undefined)
          }
        }),
    )
    await startHangingExport()
    emitProgress({ stage: "导出中", current: 1, total: 4, message: "" })
    const cancelBtn = await screen.findByText("novel.backupExport.cancelButton")
    fireEvent.click(cancelBtn)
    await waitFor(() => {
      expect(screen.getByText("novel.backupExport.cancelling")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("novel.backupExport.cancelling"))
    expect(
      mocks.invoke.mock.calls.filter((c) => (c as unknown[])[0] === "cancel_backup"),
    ).toHaveLength(1)
    releaseCancel()
    await waitFor(() => {
      expect(screen.queryByText("novel.backupExport.cancelling")).toBeNull()
    })
  })

  it("取消失败：进度区保留并提示取消失败", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("取消通道炸了"))
    await startHangingExport()
    emitProgress({ stage: "", current: 2, total: 4, message: "导出中" })
    const cancelBtn = await screen.findByText("novel.backupExport.cancelButton")
    fireEvent.click(cancelBtn)
    await waitFor(() => {
      expect(screen.getByText(/取消失败/)).toBeInTheDocument()
    })
    expect(screen.getByTestId("backup-progress-area")).toBeInTheDocument()
  })

  it("卸载时退订：unlisten 被调用", async () => {
    const { unmount } = render(<BackupExportView />)
    await waitFor(() => {
      expect(mocks.listen).toHaveBeenCalled()
    })
    unmount()
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
  })
})
