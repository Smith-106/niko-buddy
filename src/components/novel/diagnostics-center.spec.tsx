// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors
//
// J15 诊断中心组件测试（消化 J14-UI-001：用户可见入口）。
// 覆盖：分组渲染（异常优先）/详情展开（证据/错误码）/恢复按钮分级渲染
// （run!=null 才有按钮，forbidden 级无按钮）/历史列表+溯源展开/
// 诊断包预览展示（包含/排除/脱敏/位置）+导出按钮存在。

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"

afterEach(() => cleanup())
import { DiagnosticsCenter } from "./diagnostics-center"
import type { HealthReport } from "@/lib/diagnostics/health-check"
import type { DiagnosticBundlePreview } from "@/lib/diagnostics/diagnostic-bundle"
import type { ExportHistoryViewEntry } from "@/lib/export/export-history-view"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key }),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  ask: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  writeFileAtomic: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { project: null; llmConfig: null }) => unknown) =>
    selector({ project: null, llmConfig: null }),
}))

function makeReport(): HealthReport {
  return {
    checkedAt: "2026-09-23T00:00:00.000Z",
    projectPath: "C:/proj",
    overall: "attention_required",
    items: [
      {
        id: "run",
        status: "attention_required",
        objectName: "写作会话 (Run)",
        evidenceSource: "C:/proj/.novel/status.json",
        checkedAt: "2026-09-23T00:00:00.000Z",
        userImpact: "上次写作会话被中断，可能需要恢复",
        suggestedAction: "打开项目恢复会话",
        autoRecoverable: true,
        errorCode: "RUN_INTERRUPTED",
        technicalDetail: "status=interrupted; session_id=sess-i",
        recoveries: [
          { id: "resume-run", label: "恢复被中断的会话", level: "auto", idempotent: true, reversible: true, run: async () => ({ ok: true, detail: "ok" }) },
        ],
      },
      {
        id: "search_index",
        status: "degraded",
        objectName: "搜索索引 (FTS)",
        evidenceSource: "C:/proj/.niko-buddy/fts-index.json",
        checkedAt: "2026-09-23T00:00:00.000Z",
        userImpact: "搜索索引缺失——回退全量扫描",
        suggestedAction: "重建搜索索引",
        autoRecoverable: true,
        errorCode: "INDEX_STALE_OR_MISSING",
        recoveries: [
          { id: "rebuild-fts", label: "重建搜索索引", level: "auto", idempotent: true, reversible: true, run: async () => ({ ok: true, detail: "indexed=5" }) },
        ],
      },
      {
        id: "project_fs",
        status: "healthy",
        objectName: "项目文件结构",
        evidenceSource: "markers",
        checkedAt: "2026-09-23T00:00:00.000Z",
        userImpact: "项目结构完整",
        suggestedAction: "无需操作",
        autoRecoverable: false,
        recoveries: [],
      },
      {
        id: "version",
        status: "unknown",
        objectName: "应用版本与数据协议",
        evidenceSource: "version",
        checkedAt: "2026-09-23T00:00:00.000Z",
        userImpact: "无法检测版本/协议状态",
        suggestedAction: "重新检测",
        autoRecoverable: false,
        recoveries: [
          // forbidden 级：有说明无 run——组件不得渲染执行按钮。
          { id: "force-migrate", label: "强制迁移数据", level: "forbidden", idempotent: false, reversible: false, run: null },
        ],
      },
    ],
  }
}

function makeHistory(): ExportHistoryViewEntry[] {
  return [
    {
      entry: {
        id: "out/ch.pdf::abc",
        target: "out/ch.pdf",
        chapterPath: "QM/chapters/chapter-001.md",
        contentDigest: "abc",
        confirmedDigest: "abc",
        chapterNumber: 1,
        chapterTitle: "第一章",
        sessionId: "sess-x",
        conversationId: "c1",
        userRequest: "req",
        pages: 3,
        bytesWritten: 100,
        font: "cjk",
        exportedAt: "2026-09-23T00:00:00Z",
      },
      provenance: {
        exportId: "out/ch.pdf::abc",
        confirmedVersion: { confirmedDigest: "abc", contentDigest: "abc" },
        run: { sessionId: "sess-x", conversationId: "c1", userRequest: "req", resolvable: true },
        sourceAsset: { chapterPath: "QM/chapters/chapter-001.md", chapterNumber: 1, existsAtRecordedPath: true, resolvedPath: "QM/chapters/chapter-001.md", reachable: true },
        output: { target: "out/ch.pdf", exists: true, pages: 3, bytesWritten: 100, font: "cjk", exportedAt: "2026-09-23T00:00:00Z" },
        status: "available",
        projectPath: "C:/proj",
      },
      status: "available",
    },
  ]
}

function makePreview(): DiagnosticBundlePreview {
  return {
    included: ["应用版本", "Run 状态摘要"],
    excluded: ["API Key / 凭据", "项目与章节正文全文"],
    sanitizedFields: ["URL 端点", "文件系统用户名与绝对路径"],
    targetPath: "diagnostic-bundle.json（由保存对话框确认）",
    approxBytes: 1234,
    bundle: {
      schema: "niko-buddy/diagnostic-bundle@1",
      generatedAt: "2026-09-23T00:00:00.000Z",
      appVersion: "2.11.1",
      platform: "test",
      project: { present: true, markers: ["QM/"] },
      health: [],
      run: null,
      historyCounts: {},
      exportEntryCount: 1,
    },
  }
}

const baseProps = {
  historyView: makeHistory(),
  bundlePreview: makePreview(),
  loading: false,
  recovering: null,
  recoverNote: null,
  bundleNote: null,
  onRecheck: vi.fn(),
  onRecover: vi.fn(),
  onPreviewBundle: vi.fn(),
  onExportBundle: vi.fn(),
}

describe("DiagnosticsCenter — 统一健康视图", () => {
  it("总体横幅 + 异常分组优先 + 健康项影响文案", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} />)
    expect(screen.getByTestId("diagnostics-center")).toBeTruthy()
    expect(screen.getByTestId("diagnostics-overall").textContent).toContain("需要处理")
    expect(screen.getByTestId("health-status-run").textContent).toBe("需要处理")
    expect(screen.getByTestId("health-impact-run").textContent).toContain("中断")
  })

  it("详情展开显示证据来源/错误码/检测时间", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} />)
    fireEvent.click(screen.getByTestId("health-expand-run"))
    expect(screen.getByTestId("health-evidence-run").textContent).toContain("status.json")
    expect(screen.getByTestId("health-error-run").textContent).toContain("RUN_INTERRUPTED")
  })

  it("恢复按钮：auto 级可执行；forbidden 级不渲染按钮只显示手动文字", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} />)
    expect(screen.getByTestId("recover-run-resume-run")).toBeTruthy()
    expect(screen.getByTestId("recover-search_index-rebuild-fts")).toBeTruthy()
    // forbidden 级动作无执行按钮
    expect(screen.queryByTestId("recover-version-force-migrate")).toBeNull()
  })

  it("恢复按钮点击透传 itemId/actionId", () => {
    const onRecover = vi.fn()
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} onRecover={onRecover} />)
    fireEvent.click(screen.getByTestId("recover-search_index-rebuild-fts"))
    expect(onRecover).toHaveBeenCalledWith("search_index", "rebuild-fts")
  })

  it("重新检测按钮透传", () => {
    const onRecheck = vi.fn()
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} onRecheck={onRecheck} />)
    fireEvent.click(screen.getByTestId("diagnostics-recheck"))
    expect(onRecheck).toHaveBeenCalled()
  })
})

describe("DiagnosticsCenter — J14 反查用户入口（J14-UI-001）", () => {
  it("历史列表渲染 + 点击溯源展开 provenance", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} />)
    expect(screen.getByTestId("history-view-list")).toBeTruthy()
    expect(screen.getByTestId("export-entry-out/ch.pdf::abc")).toBeTruthy()
    expect(screen.getByTestId("export-status-out/ch.pdf::abc").textContent).toBe("可用")
    fireEvent.click(screen.getByTestId("export-open-out/ch.pdf::abc"))
    const prov = screen.getByTestId("export-provenance-out/ch.pdf::abc")
    expect(prov.textContent).toContain("sess-x")
    expect(prov.textContent).toContain("chapter-001")
  })

  it("空历史显示空态（非崩溃）", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} historyView={[]} />)
    expect(screen.getByTestId("history-view-empty")).toBeTruthy()
  })
})

describe("DiagnosticsCenter — 诊断包预览（门禁 11）", () => {
  it("预览展示包含/排除/脱敏/保存位置 + 导出按钮", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} />)
    const preview = screen.getByTestId("bundle-preview")
    expect(preview.textContent).toContain("将包含")
    expect(preview.textContent).toContain("将排除")
    expect(preview.textContent).toContain("已脱敏")
    expect(preview.textContent).toContain("保存位置")
    expect(screen.getByTestId("bundle-export-btn")).toBeTruthy()
  })

  it("无预览时只显示说明（不直接给导出按钮）", () => {
    render(<DiagnosticsCenter report={makeReport()} {...baseProps} bundlePreview={null} />)
    expect(screen.queryByTestId("bundle-preview")).toBeNull()
    expect(screen.queryByTestId("bundle-export-btn")).toBeNull()
  })
})
