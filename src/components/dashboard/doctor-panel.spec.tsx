/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DoctorPanel } from "./doctor-panel"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book" as string | null,
  runDoctor: vi.fn(async () => ({
    verdict: "ok",
    findings: [
      { severity: "ok", name: "status.json", message: "存在" },
      { severity: "warn", name: "fts", message: "索引未就绪" },
    ],
  })),
  collectDoctorExtras: vi.fn(async () => ({
    canonDualWriteEnabled: true,
    ftsIndexReady: true,
    budgetTasks: [{ taskId: "t1" }],
    budgetCompleted: [],
    volumeArc: null,
    fanficMergePending: null,
    translationDraftCount: 0,
    playGraphErrors: 0,
  })),
  safeRebuildFtsIndex: vi.fn(async () => ({ indexed: 1, errors: [] as string[] })),
  safeRunVectorReconcile: vi.fn(async () => ({ ok: true, detail: "deleted=0" })),
  safeTriggerVectorCompaction: vi.fn(async () => ({ ok: true, detail: "ok" })),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string | null } | null }) => unknown) =>
        selector({ project: { path: mocks.projectPath } }),
    
  }
})
vi.mock("@/lib/novel/doctor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/doctor")>()
  return { ...actual, runProjectDoctor: mocks.runDoctor }
})
vi.mock("@/lib/doctor-extras", () => ({
  collectDoctorExtras: mocks.collectDoctorExtras,
  safeRebuildFtsIndex: mocks.safeRebuildFtsIndex,
  safeRunVectorReconcile: mocks.safeRunVectorReconcile,
  safeTriggerVectorCompaction: mocks.safeTriggerVectorCompaction,
}))

describe("DoctorPanel", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("挂载自动跑诊断并渲染报告（formatDoctorReport 契约）", async () => {
    render(<DoctorPanel />)
    expect(await screen.findByTestId("doctor-panel")).toBeTruthy()
    expect(mocks.runDoctor).toHaveBeenCalled()
    expect(await screen.findByText(/status\.json/)).toBeTruthy()
  })

  it("无项目时优雅降级", async () => {
    mocks.projectPath = null
    render(<DoctorPanel />)
    expect(await screen.findByTestId("doctor-panel")).toBeTruthy()
  })

  it("诊断失败时显示错误横幅（含原文）", async () => {
    mocks.projectPath = "/p/book"
    mocks.runDoctor.mockRejectedValueOnce(new Error("读盘炸了"))
    render(<DoctorPanel />)
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("novel.doctor.failed")
    expect(alert.textContent).toContain("读盘炸了")
  })

  it("点击刷新按钮重新跑诊断", async () => {
    mocks.projectPath = "/p/book"
    render(<DoctorPanel />)
    await screen.findByText(/status\.json/)
    const before = mocks.runDoctor.mock.calls.length
    fireEvent.click(screen.getByLabelText("novel.doctor.refresh"))
    await waitFor(() => expect(mocks.runDoctor.mock.calls.length).toBeGreaterThan(before))
  })

  it("verdict 映射：critical→严重，degraded→退化，healthy→健康", async () => {
    mocks.projectPath = "/p/book"
    for (const [verdict, label] of [["critical", "严重"], ["degraded", "退化"], ["healthy", "健康"]] as const) {
      mocks.runDoctor.mockResolvedValueOnce({ verdict, findings: [] })
      const { unmount } = render(<DoctorPanel />)
      expect(await screen.findByText(label)).toBeTruthy()
      // 全空发现：提示无需处理，且不渲染“项正常”计数行
      expect(screen.getByText("没有需要立刻处理的诊断")).toBeTruthy()
      expect(screen.queryByText(/项正常/)).toBeNull()
      unmount()
    }
  })

  it("error 级发现逐条渲染，ok 级发现收进计数行", async () => {
    mocks.projectPath = "/p/book"
    mocks.runDoctor.mockResolvedValueOnce({
      verdict: "critical",
      findings: [
        { severity: "error", name: "fts", message: "索引缺失" },
        { severity: "ok", name: "status.json", message: "存在" },
        { severity: "ok", name: "备份", message: "有" },
      ],
    })
    render(<DoctorPanel />)
    expect(await screen.findByText("fts")).toBeTruthy()
    expect(screen.getByText(/索引缺失/)).toBeTruthy()
    expect(screen.getByText(/2 项正常/)).toBeTruthy()
    // sr-only 保留英文 verdict 供测试定位
    expect(document.body.innerHTML).toContain("（critical）")
  })

  it("一键重建 FTS 索引：调重建、写 healNote、重跑诊断", async () => {
    mocks.projectPath = "/p/book"
    render(<DoctorPanel />)
    await screen.findByText(/status\.json/)
    const runsBefore = mocks.runDoctor.mock.calls.length
    fireEvent.click(screen.getByText("一键重建FTS索引"))
    expect(await screen.findByText("FTS重建 indexed=1 errors=0")).toBeTruthy()
    expect(mocks.safeRebuildFtsIndex).toHaveBeenCalledWith("/p/book")
    await waitFor(() => expect(mocks.runDoctor.mock.calls.length).toBeGreaterThan(runsBefore))
  })

  it("向量压缩与向量对账：各自调对应修复并写 healNote", async () => {
    mocks.projectPath = "/p/book"
    render(<DoctorPanel />)
    await screen.findByText(/status\.json/)
    fireEvent.click(screen.getByText("向量压缩"))
    expect(await screen.findByText("向量压缩 ok=true ok")).toBeTruthy()
    expect(mocks.safeTriggerVectorCompaction).toHaveBeenCalledWith("/p/book")
    fireEvent.click(screen.getByText("向量对账"))
    expect(await screen.findByText("向量对账 ok=true deleted=0")).toBeTruthy()
    expect(mocks.safeRunVectorReconcile).toHaveBeenCalledWith("/p/book")
  })

  it("heal 失败时 healNote 显示错误原文", async () => {
    mocks.projectPath = "/p/book"
    mocks.safeRebuildFtsIndex.mockRejectedValueOnce(new Error("fts 炸了"))
    render(<DoctorPanel />)
    await screen.findByText(/status\.json/)
    fireEvent.click(screen.getByText("一键重建FTS索引"))
    expect(await screen.findByText("fts 炸了")).toBeTruthy()
  })

  it("heal 进行中按钮禁用并显示进度，完成后写 healNote", async () => {
    mocks.projectPath = "/p/book"
    let release!: (v: { indexed: number; errors: string[] }) => void
    mocks.safeRebuildFtsIndex.mockImplementationOnce(
      () => new Promise<{ indexed: number; errors: string[] }>((r) => { release = r }),
    )
    render(<DoctorPanel />)
    await screen.findByText(/status\.json/)
    fireEvent.click(screen.getByText("一键重建FTS索引"))
    // healing 非空：当前按钮显示进度，其余修复按钮禁用（与 heal 首行守卫同一状态机）
    expect(await screen.findByText("重建中…")).toBeTruthy()
    expect((screen.getByText("向量压缩") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText("向量对账") as HTMLButtonElement).disabled).toBe(true)
    release({ indexed: 2, errors: [] })
    expect(await screen.findByText("FTS重建 indexed=2 errors=0")).toBeTruthy()
    expect(mocks.safeRebuildFtsIndex).toHaveBeenCalledTimes(1)
  })
})
