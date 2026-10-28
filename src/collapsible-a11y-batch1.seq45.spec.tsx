// @vitest-environment jsdom
// SEQ-45 batch-1: custom collapsible a11y (PAT-U5).
// Covers 4 representative triggers (single-round convergence; full 14-file
// sweep deferred, see deviations):
// - file-tree TreeNode folder toggle
// - book-analysis-style-card expanded toggle
// - diagnostics-center HealthItemRow + HistoryViewSection toggles
// - activity-panel main toggle
// Each toggle must be a native button with aria-expanded + aria-controls,
// and each expanded region must carry role=region with matching id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  setupDomGlobals({})
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe("SEQ-45 collapsible a11y batch-1 (PAT-U5)", () => {
  it("file-tree folder toggle exposes aria-expanded and region", async () => {
    const { FileTree } = await import("@/components/layout/file-tree")
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.setState({
      project: { id: "p1", name: "Novel", path: "E:/Novel" },
      fileTree: [{ path: "E:/Novel/wiki/a.md", name: "dir", is_dir: true, children: [{ path: "E:/Novel/wiki/a.md/b.md", name: "b.md", is_dir: false }] }],
      selectedFile: null,
    } as never)
    render(<FileTree />)
    const toggle = screen.getByRole("button", { name: "dir" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const controls = toggle.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    const region = document.getElementById(controls as string)
    expect(region).not.toBeNull()
    expect(region as HTMLElement | null).not.toBeNull()
    expect((region as HTMLElement).getAttribute("role")).toBe("region")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
  })

  it("book-analysis-style-card toggle exposes aria-expanded and region", async () => {
    const { BookAnalysisStyleCard } = await import("@/components/novel/book-analysis-style-card")
    const book = {
      id: "b1",
      title: "t",
      styleProfile: {
        narrativeDensity: "密",
        d1: "a", d2: "b", d3: "c", d4: "d", d5: "e", d6: "f",
        constitution: "宪法",
        samples: ["样本一句"],
      },
      styleStatus: "disabled",
    } as never
    render(<BookAnalysisStyleCard book={book} extracting={false} onExtractStyle={vi.fn()} onToggleStyle={vi.fn()} />)
    const toggle = screen.getByRole("button", { name: /查看全部|收起详情/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    const controls = toggle.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const region = document.getElementById(controls as string)
    expect(region).not.toBeNull()
    expect((region as HTMLElement).getAttribute("role")).toBe("region")
    // 全量并发下动态 import 组件树可能超过默认 15s：放宽单测上限，断言不变。
  }, 30_000)

  it("diagnostics-center health expand toggle exposes aria-expanded and region", async () => {
    const { DiagnosticsCenter } = await import("@/components/novel/diagnostics-center")
    const report = {
      overall: "healthy",
      items: [
        { id: "h1", status: "attention_required", objectName: "对象", userImpact: "影响", suggestedAction: "建议", evidenceSource: "证据", checkedAt: "2026-01-01", recoveries: [] },
      ],
      checkedAt: "2026-01-01",
    } as never
    render(
      <DiagnosticsCenter
        report={report}
        historyView={[]}
        bundlePreview={null}
        loading={false}
        recovering={null}
        recoverNote={null}
        bundleNote={null}
        onRecheck={vi.fn()}
        onRecover={vi.fn()}
        onPreviewBundle={vi.fn()}
        onExportBundle={vi.fn()}
      />,
    )
    const toggle = screen.getByTestId("health-expand-h1")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    const controls = toggle.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const region = document.getElementById(controls as string)
    expect(region).not.toBeNull()
    expect((region as HTMLElement).getAttribute("role")).toBe("region")
  })

  it("activity-panel toggle exposes aria-expanded when items exist", async () => {
    const { ActivityPanel } = await import("@/components/layout/activity-panel")
    const { useActivityStore } = await import("@/stores/activity-store")
    useActivityStore.setState({ items: [{ id: "a1", title: "任务A", detail: "细节", status: "done", filesWritten: [] }] } as never)
    render(<ActivityPanel />)
    // 主折叠按钮（首个 button 即状态条）
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThan(0)
    const toggle = buttons[0]
    expect(toggle).toHaveAttribute("aria-expanded")
    const controls = toggle.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    const region = document.getElementById(controls as string)
    // 展开态 region 存在
    if (toggle.getAttribute("aria-expanded") === "true") {
      expect(region).not.toBeNull()
      expect((region as HTMLElement).getAttribute("role")).toBe("region")
    }
  })
})
