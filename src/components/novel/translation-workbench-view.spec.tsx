/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TranslationWorkbenchView } from "./translation-workbench-view"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book" as string | null,
  saveGlossary: vi.fn(async () => undefined),
  loadGlossary: vi.fn(async () => ({ entries: [], lastUpdated: "" })),
  runProject: vi.fn(),
  saveDraft: vi.fn(async () => undefined),
  saveHistory: vi.fn(async () => ({ id: "x" })),
  advanceBatch: vi.fn(),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
        selector({
          project: mocks.projectPath === null ? null : { path: mocks.projectPath },
        }),
    
  }
})
vi.mock("@/lib/novel/translation-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/translation-workbench")>()
  return {
    ...actual,
    saveTranslationGlossary: mocks.saveGlossary,
    loadTranslationGlossary: mocks.loadGlossary,
    runTranslationProject: mocks.runProject,
    saveTranslationDraft: mocks.saveDraft,
  }
})
vi.mock("@/lib/novel/budget-resume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/budget-resume")>()
  return {
    ...actual,
    advanceBudgetBatch: mocks.advanceBatch,
  }
})
vi.mock("@/lib/novel/generation-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/generation-history")>()
  return {
    ...actual,
      saveGenerationHistoryEntry: mocks.saveHistory,
    
  }
})
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
  }
})

describe("TranslationWorkbenchView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => cleanup())

  it("未注入 port 时优雅降级（按钮禁用 + 提示）", () => {
    render(<TranslationWorkbenchView />)
    expect(screen.getByTestId("translation-workbench-view")).toBeTruthy()
    expect(screen.getByText("novel.translation.noPort")).toBeTruthy()
  })

  it("添加术语条目（upsertGlossaryEntry 接线）", async () => {
    render(<TranslationWorkbenchView />)
    const inputs = screen.getAllByPlaceholderText("novel.translation.sourcePh")
    fireEvent.change(inputs[0], { target: { value: "青龙" } })
    fireEvent.change(screen.getByPlaceholderText("novel.translation.targetPh"), { target: { value: "Azure Dragon" } })
    fireEvent.click(screen.getByText("novel.translation.addEntry"))
    await screen.findByText("novel.translation.glossarySaved")
    expect(mocks.saveGlossary).toHaveBeenCalled()
  })

  it("空术语拒绝写入并提示 emptyEntry（addEntry 守卫）", async () => {
    mocks.saveGlossary.mockClear()
    render(<TranslationWorkbenchView />)
    // 源/译均为空直接点击添加
    fireEvent.click(screen.getByText("novel.translation.addEntry"))
    expect(await screen.findByText("novel.translation.emptyEntry")).toBeTruthy()
    expect(mocks.saveGlossary).not.toHaveBeenCalled()
    // 仅填一边同样拒绝
    fireEvent.change(screen.getByPlaceholderText("novel.translation.sourcePh"), {
      target: { value: "青龙" },
    })
    fireEvent.click(screen.getByText("novel.translation.addEntry"))
    expect(await screen.findByText("novel.translation.emptyEntry")).toBeTruthy()
    expect(mocks.saveGlossary).not.toHaveBeenCalled()
  })

  it("保存术语表按钮落盘当前表并提示（172-173 行）", async () => {
    mocks.saveGlossary.mockClear()
    render(<TranslationWorkbenchView />)
    fireEvent.click(screen.getByText("novel.translation.saveGlossary"))
    await screen.findByText("novel.translation.glossarySaved")
    expect(mocks.saveGlossary).toHaveBeenCalledWith("/p/book", expect.objectContaining({ entries: [] }))
  })

  it("无 projectPath 时 run 直接返回且 effect 跳过加载（39 行守卫）", async () => {
    const prev = mocks.projectPath
    mocks.projectPath = null
    try {
      mocks.runProject.mockClear()
      const port = { translate: async () => "x" }
      const { unmount } = render(<TranslationWorkbenchView port={port as never} />)
      // loadTranslationGlossary 不应被调用（effect 内 if (!projectPath) return）
      expect(mocks.loadGlossary).not.toHaveBeenCalled()
      // run 按钮因 !projectPath 禁用；即使直接触发也不会调用 runProject
      const runButtons = screen.getAllByText("novel.translation.runCount")
      expect((runButtons[0] as HTMLButtonElement).disabled).toBe(true)
      unmount()
    } finally {
      mocks.projectPath = prev
    }
  })

  it("无 port 时 run 守卫直接返回（70 行）", async () => {
    mocks.runProject.mockClear()
    // 不传 port：按钮禁用，但强制放行后触发，守卫应拦截且不调 runProject
    render(<TranslationWorkbenchView />)
    const btn = screen.getAllByText("novel.translation.runCount")[0] as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    btn.disabled = false
    fireEvent.click(btn)
    // 给 effect 一次 tick，确认 runProject 始终未被调用
    await waitFor(() => {
      expect(mocks.runProject).not.toHaveBeenCalled()
    })
  })

  it("预算预扣被拦截时提示 budgetBlocked 且不跑翻译（78-80 行）", async () => {
    const port = { translate: async () => "should-not-run" }
    mocks.advanceBatch.mockReturnValue({
      state: { completedTaskIds: [], remainingBudget: 0 },
      completed: 0,
      stoppedBy: "budget",
    })
    mocks.runProject.mockClear()
    mocks.saveDraft.mockClear()
    mocks.saveHistory.mockClear()
    render(<TranslationWorkbenchView port={port as never} />)
    const runButtons = screen.getAllByText("novel.translation.runCount")
    fireEvent.click(runButtons[0])
    expect(await screen.findByText("novel.translation.budgetBlocked")).toBeTruthy()
    expect(mocks.runProject).not.toHaveBeenCalled()
    expect(mocks.saveDraft).not.toHaveBeenCalled()
    expect(mocks.saveHistory).not.toHaveBeenCalled()
  })

  it("run 成功无违规：落 draft + 记 snapshot + done 提示 + 进度汇总（91-120/130-133 行）", async () => {
    const port = { translate: async () => "clean translation" }
    mocks.advanceBatch.mockReturnValue({
      state: { completedTaskIds: ["translate-1"], remainingBudget: 9 },
      completed: 1,
      stoppedBy: "exhausted",
    })
    mocks.runProject.mockImplementation(async (_p: unknown, _proj: unknown, loadSource: (c: number) => Promise<string>) => {
      // 真实调用组件传入的 loadSource（94 行示例加载器），断言其行为
      const src = await loadSource(1)
      expect(src).toContain("1")
      return {
        project: {
          version: 1,
          sourceLang: "zh",
          targetLang: "en",
          chapterNumbers: [1, 2],
          glossary: { entries: [], lastUpdated: "" },
          progress: { chapterStatuses: { 1: "drafted", 2: "drafted" }, lastUpdated: "" },
          budgetRunId: "translation-run",
        },
        artifacts: [
          { chapter: 1, targetText: "t1", violations: [], status: "drafted" },
          { chapter: 2, targetText: "t2", violations: [], status: "drafted" },
        ],
        budget: { remainingBudget: 8 },
        stopped: "done",
      }
    })
    mocks.saveDraft.mockClear()
    mocks.saveHistory.mockClear()
    render(<TranslationWorkbenchView port={port as never} chapterNumbers={[1, 2]} />)
    fireEvent.click(screen.getAllByText("novel.translation.runCount")[0])
    // done 提示（无 violations 走 done 分支 117-119）
    expect(await screen.findByText("novel.translation.done")).toBeTruthy()
    await waitFor(() => {
      expect(mocks.saveDraft).toHaveBeenCalledTimes(2)
    })
    expect(mocks.saveDraft).toHaveBeenCalledWith("/p/book", expect.objectContaining({ chapter: 1 }))
    expect(mocks.saveHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "snapshot-translation" }),
    )
    // 进度汇总 145-149：2 drafted / total 2
    expect(await screen.findByText(/2\/2 drafted/)).toBeTruthy()
  })

  it("run 成功有违规：提示 glossaryWarn（114-117 行）", async () => {
    const port = { translate: async () => "青龙未翻译" }
    mocks.advanceBatch.mockReturnValue({
      state: { completedTaskIds: ["translate-1"], remainingBudget: 9 },
      completed: 1,
      stoppedBy: "exhausted",
    })
    mocks.runProject.mockImplementation(async () => ({
      project: {
        version: 1,
        sourceLang: "zh",
        targetLang: "en",
        chapterNumbers: [1],
        glossary: { entries: [], lastUpdated: "" },
        progress: { chapterStatuses: { 1: "drafted" }, lastUpdated: "" },
        budgetRunId: "translation-run",
      },
      artifacts: [
        {
          chapter: 1,
          targetText: "青龙",
          violations: [{ source: "青龙", expectedTarget: "Azure Dragon", severity: "warn", message: "x" }],
          status: "drafted",
        },
      ],
      budget: { remainingBudget: 9 },
      stopped: "done",
    }))
    mocks.saveDraft.mockClear()
    render(<TranslationWorkbenchView port={port as never} chapterNumbers={[1]} />)
    fireEvent.click(screen.getAllByText("novel.translation.runCount")[0])
    expect(await screen.findByText("novel.translation.glossaryWarn")).toBeTruthy()
    await waitFor(() => {
      expect(mocks.saveDraft).toHaveBeenCalledTimes(1)
    })
  })

  it("run 抛错时提示 failed 并复位 running（121-125 行）", async () => {
    const port = { translate: async () => "x" }
    mocks.advanceBatch.mockReturnValue({
      state: { completedTaskIds: ["translate-1"], remainingBudget: 9 },
      completed: 1,
      stoppedBy: "exhausted",
    })
    mocks.runProject.mockRejectedValueOnce(new Error("boom"))
    render(<TranslationWorkbenchView port={port as never} />)
    fireEvent.click(screen.getAllByText("novel.translation.runCount")[0])
    expect(await screen.findByText(/novel\.translation\.failed/)).toBeTruthy()
    // finally 复位：按钮恢复可用
    await waitFor(() => {
      const btn = screen.getAllByText("novel.translation.runCount")[0] as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
  })
})
