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
  createDirectory: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: { project: null; llmConfig: null }) => unknown) =>
      selector({ project: null, llmConfig: null }),
  }
})

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


describe("观测面板挂载（审查回归：删掉挂载必须变红）", () => {
  afterEach(cleanup)

  it("六个只读审计面板都挂载在诊断中心里（删任一个即红）", async () => {
    render(
      <DiagnosticsCenter
        report={makeReport()}
        historyView={[]}
        bundlePreview={null}
        loading={false}
        recovering={null}
        recoverNote={null}
        bundleNote={null}
        onRecheck={() => undefined}
        onRecover={() => undefined}
        onPreviewBundle={() => undefined}
        onExportBundle={() => undefined}
      />,
    )
    for (const testId of [
      "prompt-registry-panel",
      "methodology-panel",
      "workflow-template-panel",
      "skill-prompt-coverage-panel",
      "closure-panel",
      "agent-studio-panel",
    ]) {
      expect(screen.getByTestId(testId)).toBeTruthy()
    }
  })
})

describe("信息架构：健康结论在审计之前（审查回归 2）", () => {
  afterEach(cleanup)

  it("审计区默认折叠，且 DOM 顺序在总体健康结论之后", () => {
    render(
      <DiagnosticsCenter
        report={makeReport()}
        historyView={[]}
        bundlePreview={null}
        loading={false}
        recovering={null}
        recoverNote={null}
        bundleNote={null}
        onRecheck={() => undefined}
        onRecover={() => undefined}
        onPreviewBundle={() => undefined}
        onExportBundle={() => undefined}
      />,
    )
    const audit = screen.getByTestId("diagnostics-audit-section")
    expect(audit.tagName).toBe("DETAILS")
    expect((audit as HTMLDetailsElement).open).toBe(false)
    const overall = screen.getByTestId("diagnostics-overall")
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 → overall 在 audit 之前
    expect(overall.compareDocumentPosition(audit) & 4).toBe(4)
    // audit 不得被 overall 包住（位与 4 在"被包含"时也会过，审查点）
    expect(overall.contains(audit)).toBe(false)
    // 静态声明口径必须真的渲染出来（删掉那行文案即红）
    expect(screen.getByTestId("agent-studio-static-scope").textContent).toContain("未")
  })
})

// ── 覆盖率加深（增补：原有用例保留不动）───────────────────────────────────────
// 目标：状态徽标全分支（unavailable）、历史全状态+溯源分支、恢复按钮分级/
// busy/空动作分支、Bundle 稀疏预览、提示条/加载态、kbMetrics 面板、
// DiagnosticsCenterView 容器（刷新/恢复确认/取消/失败/预览导出）全链路。
import { waitFor } from "@testing-library/react"
import { ask, save } from "@tauri-apps/plugin-dialog"
import { writeFileAtomic } from "@/commands/fs"
import { DiagnosticsCenterView } from "./diagnostics-center"
import type { HealthItem } from "@/lib/diagnostics/health-check"
import type { KbMetrics } from "@/lib/novel"

const diagStubs = vi.hoisted(() => ({
  collectHealthReport: vi.fn(),
  collectKbMetricsLive: vi.fn(),
  loadExportHistoryView: vi.fn(),
  loadNovelSessionStatus: vi.fn(),
}))

vi.mock("@/lib/diagnostics/health-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/diagnostics/health-check")>()
  return { ...actual, collectHealthReport: diagStubs.collectHealthReport }
})

vi.mock("@/lib/export/export-history-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/export-history-view")>()
  return { ...actual, loadExportHistoryView: diagStubs.loadExportHistoryView }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    collectKbMetricsLive: diagStubs.collectKbMetricsLive,
    loadNovelSessionStatus: diagStubs.loadNovelSessionStatus,
  }
})

// 注意：本文件顶部已有 @/stores/wiki-store 的空壳 mock（project=null）。
// 此处按同一默认行为重声明（末次 mock 生效），并追加 getState + 可写的
// wikiState，使容器测试能注入项目路径；既有用例行为保持 project=null 不变。
const wikiState = vi.hoisted(() => ({
  project: null as null | { id: string; name: string; path: string },
  llmConfig: null as null,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const useWikiStore = Object.assign(
    (selector: (s: { project: unknown; llmConfig: unknown }) => unknown) =>
      selector({ project: wikiState.project, llmConfig: wikiState.llmConfig }),
    { getState: () => ({ project: wikiState.project, llmConfig: wikiState.llmConfig }) },
  )
  return { ...actual, useWikiStore }
})

function makeItem(partial: Partial<HealthItem> & { id: string }): HealthItem {
  return {
    status: "healthy",
    objectName: `对象-${partial.id}`,
    evidenceSource: "证据源",
    checkedAt: "2026-09-23T00:00:00.000Z",
    userImpact: "影响",
    suggestedAction: "建议",
    autoRecoverable: false,
    recoveries: [],
    ...partial,
  } as HealthItem
}

function makeReportWith(items: HealthItem[]): HealthReport {
  return {
    checkedAt: "2026-09-23T00:00:00.000Z",
    projectPath: "C:/proj",
    overall: "attention_required",
    items,
  }
}

const nullMetrics: KbMetrics = {
  canon_violation_rate: { value: null, unavailableReason: "seed-missing" },
  obligation_coverage: { value: null, unavailableReason: "seed-missing" },
  hard_injection_budget_usage: { value: null, unavailableReason: "no-hard-inject" },
  promotion_replay_success: { value: null, unavailableReason: "no-promotion" },
  truth_fold_drift: { value: null, unavailableReason: "no-truth" },
  gap_report_rate: { value: null, unavailableReason: "no-gaps" },
}

describe("DiagnosticsCenter — 状态/恢复/历史分支（增补）", () => {
  afterEach(cleanup)

  function baseProps(overrides: Record<string, unknown> = {}) {
    return {
      report: makeReport(),
      historyView: [],
      bundlePreview: null,
      loading: false,
      recovering: null,
      recoverNote: null,
      bundleNote: null,
      onRecheck: () => undefined,
      onRecover: () => undefined,
      onPreviewBundle: () => undefined,
      onExportBundle: () => undefined,
      ...overrides,
    }
  }

  it("unavailable 状态徽标（与 unknown 同色不同分支）", () => {
    render(
      <DiagnosticsCenter
        {...baseProps({ report: makeReportWith([makeItem({ id: "net", status: "unavailable", objectName: "远端服务" })]) })}
      />,
    )
    expect(screen.getByTestId("health-status-net").textContent).toBe("不可用")
    expect(screen.getByTestId("diagnostics-overall").textContent).toContain("1 项")
  })

  it("历史溯源分支：重命名→新路径 / 不可关联 / 缺失 / 空摘要", () => {
    const renamed = {
      entry: {
        id: "renamed::d1",
        target: "out/renamed.pdf",
        chapterPath: "QM/chapters/old.md",
        contentDigest: "d1",
        confirmedDigest: "d1",
        chapterNumber: 5,
        chapterTitle: "第五章",
        sessionId: "sess-r",
        conversationId: "c-r",
        userRequest: "req",
        pages: 2,
        bytesWritten: 50,
        font: "cjk",
        exportedAt: "2026-09-23T00:00:00Z",
      },
      provenance: {
        exportId: "renamed::d1",
        confirmedVersion: { confirmedDigest: "d1", contentDigest: "d1" },
        run: { sessionId: "sess-r", conversationId: "c-r", userRequest: "req", resolvable: true },
        sourceAsset: {
          chapterPath: "QM/chapters/old.md",
          chapterNumber: 5,
          existsAtRecordedPath: false,
          resolvedPath: "QM/chapters/new.md",
          reachable: true,
        },
        output: {
          target: "out/renamed.pdf",
          exists: true,
          pages: 2,
          bytesWritten: 50,
          font: "cjk",
          exportedAt: "2026-09-23T00:00:00Z",
        },
        status: "available",
        projectPath: "C:/proj",
      },
      status: "available",
    }
    const missing = {
      entry: {
        id: "missing::d2",
        target: "",
        chapterPath: "",
        contentDigest: "d2",
        confirmedDigest: "",
        chapterNumber: 6,
        chapterTitle: "第六章",
        sessionId: "",
        conversationId: "",
        userRequest: "",
        pages: 0,
        bytesWritten: 0,
        font: "",
        exportedAt: "2026-09-23T00:00:00Z",
      },
      provenance: {
        exportId: "missing::d2",
        confirmedVersion: { confirmedDigest: "", contentDigest: "d2" },
        run: { sessionId: "", conversationId: "", userRequest: "", resolvable: false },
        sourceAsset: {
          chapterPath: "",
          chapterNumber: 6,
          existsAtRecordedPath: false,
          resolvedPath: "",
          reachable: false,
        },
        output: { target: "", exists: false, pages: 0, bytesWritten: 0, font: "", exportedAt: "" },
        status: "source_missing",
        projectPath: "C:/proj",
      },
      status: "source_missing",
    }
    render(<DiagnosticsCenter {...baseProps({ historyView: [renamed, missing] })} />)
    fireEvent.click(screen.getByTestId("export-open-renamed::d1"))
    const provRenamed = screen.getByTestId("export-provenance-renamed::d1")
    expect(provRenamed.textContent).toContain("已重命名→QM/chapters/new.md")
    expect(provRenamed.textContent).toContain("sess-r / c-r")
    fireEvent.click(screen.getByTestId("export-open-missing::d2"))
    const provMissing = screen.getByTestId("export-provenance-missing::d2")
    expect(provMissing.textContent).toContain("不可关联")
    expect(provMissing.textContent).toContain("无会话")
    expect(provMissing.textContent).toContain("无）")
    expect(provMissing.textContent).toContain("缺失")
    expect(screen.getByTestId("export-status-missing::d2").textContent).toBe("源缺失")
  })

  it.each([
    ["output_missing", "产物缺失"],
    ["partially_available", "部分可用"],
    ["invalid", "记录损坏"],
  ] as const)("历史状态 %s 显示为 %s", (status, zh) => {
    const base = makeHistory()[0]
    const entry = { ...base, status, provenance: { ...base.provenance, status } }
    render(<DiagnosticsCenter {...baseProps({ historyView: [entry] })} />)
    expect(screen.getByTestId(`export-status-${base.entry.id}`).textContent).toBe(zh)
    cleanup()
  })

  it("confirm 级恢复按钮带需确认后缀 + 二次确认标题", () => {
    render(
      <DiagnosticsCenter
        {...baseProps({
          report: makeReportWith([
            makeItem({
              id: "migrate",
              status: "degraded",
              recoveries: [
                { id: "do-it", label: "执行迁移", level: "confirm", idempotent: false, reversible: false, run: async () => ({ ok: true, detail: "ok" }) },
              ],
            }),
          ]),
        })}
      />,
    )
    const btn = screen.getByTestId("recover-migrate-do-it")
    expect(btn.textContent).toContain("需确认")
    expect(btn.getAttribute("title")).toContain("二次确认")
  })

  it("recovering 忙：当前按钮显示执行中，其余禁用", () => {
    const onRecover = vi.fn()
    render(
      <DiagnosticsCenter {...baseProps({ recovering: "search_index:rebuild-fts", onRecover })} />,
    )
    const busy = screen.getByTestId("recover-search_index-rebuild-fts")
    expect(busy.textContent).toContain("执行中")
    expect(busy.hasAttribute("disabled")).toBe(true)
    expect(screen.getByTestId("recover-run-resume-run").hasAttribute("disabled")).toBe(true)
  })

  it("详情展开：技术详情+可自动恢复；无错误码时不渲染错误行", () => {
    render(
      <DiagnosticsCenter
        {...baseProps({
          report: makeReportWith([
            makeItem({ id: "idx", status: "degraded", autoRecoverable: true, technicalDetail: "stale; docs=3" }),
          ]),
        })}
      />,
    )
    fireEvent.click(screen.getByTestId("health-expand-idx"))
    expect(screen.getByTestId("health-evidence-idx")).toBeTruthy()
    expect(screen.queryByTestId("health-error-idx")).toBeNull()
    const region = screen.getByRole("region", { name: "对象-idx详情" })
    expect(region.textContent).toContain("可自动恢复：是")
    expect(region.textContent).toContain("stale; docs=3")
  })

  it("空恢复列表：无执行按钮、无手动文字（非崩溃）", () => {
    const { container } = render(
      <DiagnosticsCenter {...baseProps({ report: makeReportWith([makeItem({ id: "bare", recoveries: [] })]) })} />,
    )
    expect(container.querySelector('[data-testid^="recover-"]')).toBeNull()
    expect(screen.getByTestId("health-item-bare").textContent).not.toContain("需手动处理")
  })

  it("稀疏预览（未定义数组）渲染不崩且保留导出按钮", () => {
    const sparse = { ...makePreview(), included: undefined, excluded: undefined, sanitizedFields: undefined }
    render(<DiagnosticsCenter {...baseProps({ bundlePreview: sparse })} />)
    expect(screen.getByTestId("bundle-preview")).toBeTruthy()
    expect(screen.getByTestId("bundle-export-btn")).toBeTruthy()
  })

  it("提示条/加载态/回调透传：recoverNote + bundleNote + 生成预览/导出回调", () => {
    const onPreviewBundle = vi.fn()
    const onExportBundle = vi.fn()
    render(
      <DiagnosticsCenter
        {...baseProps({
          bundlePreview: makePreview(),
          loading: true,
          recoverNote: "恢复成功：indexed=5",
          bundleNote: "诊断包已导出：C:/out.json",
          onPreviewBundle,
          onExportBundle,
        })}
      />,
    )
    expect(screen.getByTestId("recover-note").textContent).toContain("indexed=5")
    expect(screen.getByTestId("bundle-note").textContent).toContain("C:/out.json")
    const recheck = screen.getByTestId("diagnostics-recheck")
    expect(recheck.hasAttribute("disabled")).toBe(true)
    expect(recheck.textContent).toContain("检测中")
    fireEvent.click(screen.getByTestId("bundle-preview-btn"))
    expect(onPreviewBundle).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("bundle-export-btn"))
    expect(onExportBundle).toHaveBeenCalledTimes(1)
  })

  it("kbMetrics 缺省不渲染面板；传入则渲染 6 指标 N/A", () => {
    const { unmount } = render(<DiagnosticsCenter {...baseProps()} />)
    expect(screen.queryByTestId("kb-health-view")).toBeNull()
    unmount()
    render(<DiagnosticsCenter {...baseProps({ kbMetrics: nullMetrics })} />)
    expect(screen.getByTestId("kb-health-view")).toBeTruthy()
    expect(screen.getByTestId("kb-metric-truth_fold_drift-na")).toBeTruthy()
  })
})

/**
 * 宿主容器用例要穿过动态 import + 异步采集链路，默认 1000ms 在 4-worker 并发争抢下
 * 会假红（项目已记录的 A 类 flaky，见 vite.config.ts poolOptions 注释与
 * testTimeout=15000 的取值理由）。这里显式放宽到 5s，仍远小于 testTimeout，
 * 真回归（元素永不出现）依旧会红。
 */
const waitForHost = (fn: () => void) => waitFor(fn, { timeout: 5000 })

describe("DiagnosticsCenterView — 宿主容器（增补）", () => {
  afterEach(cleanup)

  function resetAll() {
    wikiState.project = null
    diagStubs.collectHealthReport.mockReset()
    diagStubs.collectKbMetricsLive.mockReset()
    diagStubs.loadExportHistoryView.mockReset()
    diagStubs.loadNovelSessionStatus.mockReset()
    vi.mocked(ask).mockReset()
    vi.mocked(save).mockReset()
    vi.mocked(writeFileAtomic).mockReset()
  }

  function withProject() {
    wikiState.project = { id: "p1", name: "p", path: "C:/proj" }
  }

  const liveMetrics: KbMetrics = {
    ...nullMetrics,
    hard_injection_budget_usage: { value: 0.2 },
  }

  it("无项目 → 空态（不触发采集）", () => {
    resetAll()
    render(<DiagnosticsCenterView />)
    expect(screen.getByTestId("diagnostics-center-empty")).toBeTruthy()
    expect(diagStubs.collectHealthReport).not.toHaveBeenCalled()
  })

  it("采集中 → 加载态", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockReturnValue(new Promise(() => {}))
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    const { unmount } = render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center-loading")).toBeTruthy())
    unmount()
  })

  it("采集成功 → 主视图 + KB 面板 + 重新检测透传", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue(makeHistory())
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center")).toBeTruthy())
    expect(screen.getByTestId("kb-health-view")).toBeTruthy()
    expect(diagStubs.collectHealthReport).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("diagnostics-recheck"))
    await waitForHost(() => expect(diagStubs.collectHealthReport).toHaveBeenCalledTimes(2))
  })

  it("KB 采集失败 → 诚实降级（主视图照常、无 KB 面板）", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockRejectedValue(new Error("no bridge"))
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center")).toBeTruthy())
    expect(screen.queryByTestId("kb-health-view")).toBeNull()
  })

  it("auto 恢复成功 → 成功提示并重刷报告", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("recover-search_index-rebuild-fts")).toBeTruthy())
    fireEvent.click(screen.getByTestId("recover-search_index-rebuild-fts"))
    await waitForHost(() => expect(screen.getByTestId("recover-note")).toBeTruthy())
    expect(screen.getByTestId("recover-note").textContent).toContain("恢复成功")
    await waitForHost(() => expect(diagStubs.collectHealthReport.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("confirm 恢复：默认 ask 未确认 → 不执行；确认后执行并提示", async () => {
    const run = vi.fn(async () => ({ ok: true, detail: "migrated" }))
    const confirmReport = makeReportWith([
      makeItem({
        id: "migrate",
        status: "degraded",
        recoveries: [{ id: "do-it", label: "执行迁移", level: "confirm", idempotent: false, reversible: false, run }],
      }),
    ])
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(confirmReport)
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("recover-migrate-do-it")).toBeTruthy())
    // 默认 ask 返回 undefined（假值）→ 不执行
    fireEvent.click(screen.getByTestId("recover-migrate-do-it"))
    await waitForHost(() => expect(vi.mocked(ask)).toHaveBeenCalledTimes(1))
    expect(run).not.toHaveBeenCalled()
    // 确认后执行
    vi.mocked(ask).mockResolvedValueOnce(true)
    fireEvent.click(screen.getByTestId("recover-migrate-do-it"))
    await waitForHost(() => expect(run).toHaveBeenCalledTimes(1))
    await waitForHost(() => expect(screen.getByTestId("recover-note").textContent).toContain("migrated"))
  })

  it("恢复未完成（ok=false）与抛错 → 分级提示", async () => {
    const failReport = makeReportWith([
      makeItem({
        id: "a",
        status: "degraded",
        recoveries: [{ id: "no", label: "不行", level: "auto", idempotent: true, reversible: true, run: async () => ({ ok: false, detail: "skip" }) }],
      }),
      makeItem({
        id: "b",
        status: "degraded",
        recoveries: [{ id: "boom", label: "炸", level: "auto", idempotent: true, reversible: true, run: async () => { throw new Error("EIO") } }],
      }),
    ])
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(failReport)
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("recover-a-no")).toBeTruthy())
    fireEvent.click(screen.getByTestId("recover-a-no"))
    await waitForHost(() => expect(screen.getByTestId("recover-note").textContent).toContain("恢复未完成"))
    fireEvent.click(screen.getByTestId("recover-b-boom"))
    await waitForHost(() => expect(screen.getByTestId("recover-note").textContent).toContain("恢复失败"))
    expect(screen.getByTestId("recover-note").textContent).toContain("EIO")
  })

  it("诊断包：生成预览（含会话）→ 确认导出写盘并更新位置", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue(makeHistory())
    diagStubs.loadNovelSessionStatus.mockResolvedValue({
      status: "interrupted",
      session_id: "sess-i",
      current_task: null,
    })
    vi.mocked(save).mockResolvedValueOnce("C:/out/diagnostic-bundle.json")
    vi.mocked(writeFileAtomic).mockResolvedValueOnce(undefined as never)
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bundle-preview-btn"))
    await waitForHost(() => expect(screen.getByTestId("bundle-preview")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bundle-export-btn"))
    await waitForHost(() => expect(screen.getByTestId("bundle-note")).toBeTruthy())
    expect(screen.getByTestId("bundle-note").textContent).toContain("诊断包已导出")
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("bundle-preview").textContent).toContain("C:/out/diagnostic-bundle.json")
  })

  it("诊断包：会话缺失（null）仍可预览；取消保存 → 已取消导出", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    diagStubs.loadNovelSessionStatus.mockResolvedValue(null)
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bundle-preview-btn"))
    await waitForHost(() => expect(screen.getByTestId("bundle-preview")).toBeTruthy())
    // save 默认返回 undefined（取消）
    fireEvent.click(screen.getByTestId("bundle-export-btn"))
    await waitForHost(() => expect(screen.getByTestId("bundle-note").textContent).toContain("已取消导出"))
    expect(vi.mocked(writeFileAtomic)).not.toHaveBeenCalled()
  })

  it("诊断包：会话读取抛错 → 降级为无会话预览", async () => {
    resetAll()
    withProject()
    diagStubs.collectHealthReport.mockResolvedValue(makeReport())
    diagStubs.collectKbMetricsLive.mockResolvedValue(liveMetrics)
    diagStubs.loadExportHistoryView.mockResolvedValue([])
    diagStubs.loadNovelSessionStatus.mockRejectedValue(new Error("no status"))
    render(<DiagnosticsCenterView />)
    await waitForHost(() => expect(screen.getByTestId("diagnostics-center")).toBeTruthy())
    fireEvent.click(screen.getByTestId("bundle-preview-btn"))
    await waitForHost(() => expect(screen.getByTestId("bundle-preview")).toBeTruthy())
  })
})
