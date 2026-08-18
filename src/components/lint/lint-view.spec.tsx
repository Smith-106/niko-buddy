// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/lint/lint-view.tsx.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { LintView } from "./lint-view"
import type { LintResult } from "@/lib/lint"

const ORPHAN: LintResult = {
  type: "orphan",
  severity: "warning",
  page: "pages/foo.md",
  detail: "No incoming links",
}
const BROKEN: LintResult = {
  type: "broken-link",
  severity: "warning",
  page: "bar.md",
  detail: "Broken ref",
  affectedPages: ["bar.md"],
}
const NO_OUT: LintResult = {
  type: "no-outlinks",
  severity: "info",
  page: "baz.md",
  detail: "No outlinks",
}
const SEMANTIC: LintResult = {
  type: "semantic",
  severity: "info",
  page: "qux.md",
  detail: "Semantic issue",
  affectedPages: ["qux.md"],
}

const HISTORY_ENTRY = {
  id: "h1",
  kind: "lint",
  title: "第 5 章 lint",
  chapterNumber: 5,
  sourcePath: "ch1.md",
  results: [ORPHAN, NO_OUT],
  createdAt: "2026-01-02T03:04:05Z",
  filePath: "/p/mybook/.qmai/history/h1.json",
}

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const project = { id: "p1", name: "MyBook", path: "/p/mybook" }
  const state: {
    novelMode: boolean
    project: { id: string; name: string; path: string } | null
    llmConfig: Record<string, unknown>
    selectedFile: string | null
    fileContent: string
    lintRun: {
      runId: string
      running: boolean
      hasRun: boolean
      results: LintResult[]
      error?: string
      filePath?: string
    } | null
    setSelectedFile: ReturnType<typeof vi.fn>
    setFileContent: ReturnType<typeof vi.fn>
    setActiveView: ReturnType<typeof vi.fn>
    setFileTree: ReturnType<typeof vi.fn>
    bumpDataVersion: ReturnType<typeof vi.fn>
    setLintRun: Mock<(lr: typeof state.lintRun) => void>
    finishLintRun: (runId: string, patch: Record<string, unknown>) => void
  } = {
    novelMode: false,
    project,
    llmConfig: { provider: "openai", model: "gpt-4o" },
    selectedFile: "/p/mybook/wiki/ch1.md",
    fileContent: "---\ntitle: ch1\n---\nbody",
    lintRun: null,
    setSelectedFile: vi.fn<() => void>(),
    setFileContent: vi.fn<() => void>(),
    setActiveView: vi.fn<() => void>(),
    setFileTree: vi.fn<() => void>(),
    bumpDataVersion: vi.fn<() => void>(),
    setLintRun: vi.fn<(lr: typeof state.lintRun) => void>((lr) => {
      state.lintRun = lr
    }),
    finishLintRun: (runId, patch) => {
      if (state.lintRun?.runId === runId) {
        state.lintRun = { ...state.lintRun, ...patch }
      }
    },
  }
  const reviewState = { addItem: vi.fn<(item: Record<string, unknown>) => void>() }
  return {
    state,
    project,
    reviewState,
    t: vi.fn<(key: string, opts?: Record<string, unknown>) => string>((key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.chapter === "number" ? `${key}#${opts.chapter}` : key,
    ),
    runStructuralLint: vi.fn<() => Promise<LintResult[]>>(async () => [ORPHAN]),
    runSemanticLint: vi.fn<() => Promise<LintResult[]>>(async () => [SEMANTIC]),
    hasUsableLlm: vi.fn<() => boolean>(() => false),
    readFile: vi.fn<() => Promise<string>>(async () => "content"),
    writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(async () => {}),
    listDirectory: vi.fn<() => Promise<Array<{ name: string; path: string; is_dir: boolean }>>>(async () => [{ name: "wiki", path: "/p/mybook/wiki", is_dir: true }]),
    normalizePath: vi.fn<(p: string) => string>((p: string) => p),
    parseFrontmatter: vi.fn<(content: string) => { frontmatter: Record<string, unknown> | null; body: string; rawBlock: string }>(() => ({ frontmatter: null, body: "body", rawBlock: "" })),
    parseChapterMeta: vi.fn<(frontmatter: Record<string, unknown>) => { chapterNumber: number } | null>(() => null),
    persistRevisionFeedbackForChapter: vi.fn<() => Promise<void>>(async () => {}),
    pickRevisionFeedbackFromLintResults: vi.fn<() => Record<string, unknown>>(() => ({})),
    deleteGenerationHistoryEntry: vi.fn<() => Promise<void>>(async () => {}),
    listGenerationHistory: vi.fn<() => Promise<unknown[]>>(async () => []),
    saveGenerationHistoryEntry: vi.fn<(projectPath: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => ({})),
    cascadeDeleteWikiPagesWithRefs: vi.fn<() => Promise<void>>(async () => {}),
  }
})

// Resolved from the hoisted mocks (project object lives inside vi.hoisted).
const PROJECT = mocks.project

vi.mock("@/i18n", () => ({ default: { t: mocks.t } }))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/stores/review-store", () => ({
  useReviewStore: Object.assign(() => ({}), { getState: () => mocks.reviewState }),
}))

vi.mock("@/lib/lint", () => ({
  runStructuralLint: mocks.runStructuralLint,
  runSemanticLint: mocks.runSemanticLint,
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: mocks.hasUsableLlm,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/path-utils", () => ({
  normalizePath: mocks.normalizePath,
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: mocks.parseFrontmatter,
}))

vi.mock("@/lib/novel/chapter-meta", () => ({
  parseChapterMeta: mocks.parseChapterMeta,
}))

vi.mock("@/lib/novel/revision-feedback", () => ({
  persistRevisionFeedbackForChapter: mocks.persistRevisionFeedbackForChapter,
  pickRevisionFeedbackFromLintResults: mocks.pickRevisionFeedbackFromLintResults,
}))

vi.mock("@/lib/novel/generation-history", () => ({
  deleteGenerationHistoryEntry: mocks.deleteGenerationHistoryEntry,
  listGenerationHistory: mocks.listGenerationHistory,
  saveGenerationHistoryEntry: mocks.saveGenerationHistoryEntry,
}))

// The dynamic import inside handleDeleteOrphan is intercepted by vitest too.
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: mocks.cascadeDeleteWikiPagesWithRefs,
}))

vi.mock("@/components/ui/button", () => ({
  // NOTE: `disabled` is intentionally NOT forwarded — jsdom/React never
  // dispatch clicks on disabled buttons, which would make the component's
  // own `if (!project || running) return` guard unreachable. Dropping it
  // in the test double lets us exercise the guard directly.
  Button: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function renderLintView() {
  const utils = render(<LintView />)
  return {
    ...utils,
    /** Re-render so selectors pick up the mutated mock store state. */
    refresh: () => utils.rerender(<LintView />),
  }
}

function runButton(): HTMLButtonElement {
  return screen.getByText("lint.runLint").closest("button") as HTMLButtonElement
}

function setLintRunState(
  runId: string,
  patch: { running?: boolean; hasRun?: boolean; results?: LintResult[]; error?: string },
) {
  mocks.state.lintRun = {
    runId,
    running: patch.running ?? false,
    hasRun: patch.hasRun ?? false,
    results: patch.results ?? [],
    error: patch.error,
  }
}

beforeEach(() => {
  setupDomGlobals()
  Object.assign(mocks.state, {
    novelMode: false,
    project: PROJECT,
    llmConfig: { provider: "openai", model: "gpt-4o" },
    selectedFile: "/p/mybook/wiki/ch1.md",
    fileContent: "---\ntitle: ch1\n---\nbody",
    lintRun: null,
  })
  // clear accumulated calls on the store action spies
  mocks.state.setSelectedFile.mockClear()
  mocks.state.setFileContent.mockClear()
  mocks.state.setActiveView.mockClear()
  mocks.state.setFileTree.mockClear()
  mocks.state.bumpDataVersion.mockClear()
  mocks.state.setLintRun.mockClear()
  mocks.reviewState.addItem.mockClear()
  // mockReset (not mockClear) so queued mockResolvedValueOnce values from
  // a previous test can never leak into this one
  mocks.runStructuralLint.mockReset()
  mocks.runStructuralLint.mockResolvedValue([ORPHAN])
  mocks.runSemanticLint.mockReset()
  mocks.runSemanticLint.mockResolvedValue([SEMANTIC])
  mocks.hasUsableLlm.mockReset()
  mocks.hasUsableLlm.mockReturnValue(false)
  mocks.readFile.mockReset()
  mocks.readFile.mockResolvedValue("content")
  mocks.writeFile.mockReset()
  mocks.listDirectory.mockReset()
  mocks.listDirectory.mockResolvedValue([
    { name: "wiki", path: "/p/mybook/wiki", is_dir: true },
  ])
  mocks.parseFrontmatter.mockReset()
  mocks.parseFrontmatter.mockReturnValue({ frontmatter: null, body: "body", rawBlock: "" })
  mocks.parseChapterMeta.mockReset()
  mocks.parseChapterMeta.mockReturnValue(null)
  mocks.persistRevisionFeedbackForChapter.mockReset()
  mocks.pickRevisionFeedbackFromLintResults.mockReset()
  mocks.listGenerationHistory.mockReset()
  mocks.listGenerationHistory.mockResolvedValue([])
  mocks.saveGenerationHistoryEntry.mockReset()
  mocks.deleteGenerationHistoryEntry.mockReset()
  mocks.cascadeDeleteWikiPagesWithRefs.mockReset()
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── tests ────────────────────────────────────────────────────────────────────

describe("LintView — empty / initial states", () => {
  it("renders the hint state before any run (hasRun=false)", () => {
    renderLintView()
    expect(screen.getByText("lint.title")).toBeInTheDocument()
    expect(screen.getByText("lint.runLintHint")).toBeInTheDocument()
    expect(screen.getByText("lint.runLintDescription")).toBeInTheDocument()
    expect(runButton().disabled).toBe(false)
    expect(screen.queryByText(/lint\.issues/)).not.toBeInTheDocument()
  })

  it("uses novel titles in novel mode", () => {
    mocks.state.novelMode = true
    renderLintView()
    expect(screen.getByText("novel.lint.title")).toBeInTheDocument()
    expect(screen.getByText("novel.lint.runLintHint")).toBeInTheDocument()
    expect(screen.getByText("novel.lint.runLint")).toBeInTheDocument()
  })

  it("guard: no-op without project", async () => {
    mocks.state.project = null
    renderLintView()
    fireEvent.click(runButton())
    expect(mocks.runStructuralLint).not.toHaveBeenCalled()
  })

  it("shows the error banner when lintRun has an error", () => {
    setLintRunState("r1", { hasRun: true, error: "lint exploded" })
    renderLintView()
    expect(screen.getByText("lint exploded")).toBeInTheDocument()
  })

  it("shows all-clear when a run completed with zero results", () => {
    setLintRunState("r1", { hasRun: true, results: [] })
    renderLintView()
    expect(screen.getByText("lint.allClear")).toBeInTheDocument()
    expect(screen.getByText("lint.noIssues")).toBeInTheDocument()
  })

  it("shows all-clear (novel) when a run completed with zero results", () => {
    mocks.state.novelMode = true
    setLintRunState("r1", { hasRun: true, results: [] })
    renderLintView()
    expect(screen.getByText("novel.lint.allClear")).toBeInTheDocument()
  })

  it("renders the issues badge (singular and plural)", () => {
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    const { refresh } = renderLintView()
    expect(screen.getByText("lint.issues")).toBeInTheDocument()
    setLintRunState("r2", { hasRun: true, results: [ORPHAN, BROKEN] })
    refresh()
    expect(screen.getByText("lint.issues_plural")).toBeInTheDocument()
  })
})

describe("LintView — running the lint", () => {
  it("runs structural lint and displays results (warning + info sections)", async () => {
    mocks.runStructuralLint.mockResolvedValue([ORPHAN, NO_OUT])
    const { refresh } = renderLintView()
    fireEvent.click(runButton())
    await waitFor(() => {
      expect(mocks.state.lintRun?.hasRun).toBe(true)
    })
    expect(mocks.parseFrontmatter).toHaveBeenCalledWith(mocks.state.fileContent)
    expect(mocks.runStructuralLint).toHaveBeenCalledWith("/p/mybook")
    refresh()

    // section headers render t("lint.sectionCount") with the label prop
    expect(screen.getAllByText("lint.sectionCount").length).toBe(2)
    expect(screen.getByText("pages/foo.md")).toBeInTheDocument()
    expect(screen.getByText("No incoming links")).toBeInTheDocument()
    expect(screen.getByText("baz.md")).toBeInTheDocument()
    expect(mocks.state.lintRun?.hasRun).toBe(true)
    expect(mocks.state.lintRun?.running).toBe(false)
    // save history only in novel mode
    expect(mocks.saveGenerationHistoryEntry).not.toHaveBeenCalled()
  })

  it("includes semantic results when runSemantic + hasUsableLlm are both true", async () => {
    mocks.state.novelMode = true
    mocks.runStructuralLint.mockResolvedValue([BROKEN])
    mocks.hasUsableLlm.mockReturnValue(true)
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByText("novel.lint.runLint"))
    await waitFor(() => {
      expect(mocks.state.lintRun?.hasRun).toBe(true)
    })
    expect(mocks.runSemanticLint).toHaveBeenCalled()
    expect(mocks.runSemanticLint).toHaveBeenCalledWith("/p/mybook", mocks.state.llmConfig, {
      chapterContent: mocks.state.fileContent,
      chapterNumber: undefined,
    })
    refresh()
    expect(screen.getAllByText("qux.md").length).toBeGreaterThan(0)
  })

  it("skips semantic when runSemantic is true but no usable LLM", async () => {
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(runButton())
    await waitFor(() => {
      expect(mocks.runStructuralLint).toHaveBeenCalled()
    })
    expect(mocks.runSemanticLint).not.toHaveBeenCalled()
    refresh()
    expect(screen.getByText("pages/foo.md")).toBeInTheDocument()
  })

  it("guard: no-op when already running; shows running label", async () => {
    let resolveStructural: (v: LintResult[]) => void = () => {}
    mocks.runStructuralLint.mockImplementation(
      () =>
        new Promise<LintResult[]>((resolve) => {
          resolveStructural = resolve
        }),
    )
    const { refresh } = renderLintView()
    fireEvent.click(runButton())
    refresh()
    // running label after state lands
    expect(screen.getByText("lint.running")).toBeInTheDocument()
    // second click while running → guard returns early (button mock drops disabled)
    fireEvent.click(screen.getByText("lint.running"))
    expect(mocks.runStructuralLint).toHaveBeenCalledTimes(1)
    resolveStructural([ORPHAN])
  })

  it("guard: no-op without project", async () => {
    mocks.state.project = null
    renderLintView()
    fireEvent.click(runButton())
    expect(mocks.runStructuralLint).not.toHaveBeenCalled()
  })

  it("semantic run outside novel mode → chapterContent undefined", async () => {
    mocks.hasUsableLlm.mockReturnValue(true)
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(runButton())
    await waitFor(() => {
      expect(mocks.state.lintRun?.hasRun).toBe(true)
    })
    expect(mocks.runSemanticLint).toHaveBeenCalledWith("/p/mybook", mocks.state.llmConfig, {
      chapterContent: undefined,
      chapterNumber: undefined,
    })
    refresh()
  })

  it("handleRunLint failure with non-Error rejection → String(err)", async () => {
    mocks.runStructuralLint.mockRejectedValue("raw-failure")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { refresh } = renderLintView()
    fireEvent.click(runButton())
    await waitFor(() => {
      expect(mocks.state.lintRun?.error).toBe("lint.messages.runFailed")
    })
    expect(spy).toHaveBeenCalled()
    refresh()
    spy.mockRestore()
  })

  it("handleRunLint failure with an Error rejection → err.message", async () => {
    mocks.runStructuralLint.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { refresh } = renderLintView()
    fireEvent.click(runButton())
    await waitFor(() => {
      expect(mocks.state.lintRun?.error).toBe("lint.messages.runFailed")
    })
    refresh()
    expect(screen.getByText("lint.messages.runFailed")).toBeInTheDocument()
    expect(mocks.state.lintRun?.running).toBe(false)
    spy.mockRestore()
  })

  it("novel mode with selectedFile=null → undefined filePath/sourcePath", async () => {
    mocks.state.novelMode = true
    mocks.state.selectedFile = null
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByText("novel.lint.runLint"))
    await waitFor(() => {
      expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalled()
    })
    const initial = mocks.state.setLintRun.mock.calls[0][0]!
    expect(initial.filePath).toBeUndefined()
    const saved = mocks.saveGenerationHistoryEntry.mock.calls[0][1]
    expect(saved.sourcePath).toBeUndefined()
    refresh()
  })

  it("finally: skips the final finish when lintRun was cleared mid-flight", async () => {
    let resolveStructural: (v: LintResult[]) => void = () => {}
    mocks.runStructuralLint.mockImplementation(
      () =>
        new Promise<LintResult[]>((resolve) => {
          resolveStructural = resolve
        }),
    )
    renderLintView()
    fireEvent.click(runButton())
    expect(mocks.state.lintRun?.running).toBe(true)
    mocks.state.setLintRun(null)
    resolveStructural([ORPHAN])
    await waitFor(() => {
      expect(mocks.state.lintRun).toBeNull()
    })
  })
})

describe("LintView — novel mode + history", () => {
  it("novel mode: saves generation history + revision feedback when meta has chapterNumber", async () => {
    mocks.state.novelMode = true
    mocks.parseFrontmatter.mockReturnValue({
      frontmatter: { chapter: 5 },
      body: "body",
      rawBlock: "---\nchapter: 5\n---",
    })
    mocks.parseChapterMeta.mockReturnValue({ chapterNumber: 5 })
    mocks.listGenerationHistory.mockResolvedValue([HISTORY_ENTRY])
    mocks.pickRevisionFeedbackFromLintResults.mockReturnValue({ mustFix: ["x"] })
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByText("novel.lint.runLint"))
    await waitFor(() => {
      expect(mocks.persistRevisionFeedbackForChapter).toHaveBeenCalled()
    })
    expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalledWith("/p/mybook", {
      kind: "lint",
      title: "novel.lint.historyEntryTitle#5",
      chapterNumber: 5,
      sourcePath: mocks.state.selectedFile,
      results: [ORPHAN],
    })
    expect(mocks.persistRevisionFeedbackForChapter).toHaveBeenCalledWith(
      "/p/mybook",
      5,
      "lint",
      { mustFix: ["x"] },
    )
    refresh()
    expect(screen.getByText("novel.lint.historyTitle")).toBeInTheDocument()
    expect(screen.getByText("第 5 章 lint")).toBeInTheDocument()
  })

  it("novel mode without chapterNumber → NoChapter history title, no revision feedback", async () => {
    mocks.state.novelMode = true
    const { refresh } = renderLintView()
    fireEvent.click(screen.getByText("novel.lint.runLint"))
    await waitFor(() => {
      expect(mocks.saveGenerationHistoryEntry).toHaveBeenCalled()
    })
    const call = mocks.saveGenerationHistoryEntry.mock.calls[0][1]
    expect(call.title).toBe("novel.lint.historyEntryTitleNoChapter")
    expect(mocks.persistRevisionFeedbackForChapter).not.toHaveBeenCalled()
    refresh()
  })

  it("expands a history entry (with results) and collapses it; delete via confirm", async () => {
    mocks.state.novelMode = true
    mocks.listGenerationHistory.mockResolvedValue([HISTORY_ENTRY])
    const { refresh } = renderLintView()
    await waitFor(() => {
      expect(screen.getByText("第 5 章 lint")).toBeInTheDocument()
    })
    expect(screen.getByText(/2026-01-02/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("第 5 章 lint"))
    expect(screen.getByText("pages/foo.md")).toBeInTheDocument()
    expect(screen.getByText("No incoming links")).toBeInTheDocument()
    fireEvent.click(screen.getByText("第 5 章 lint"))
    expect(screen.queryByText("No incoming links")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.history.delete"))
    await waitFor(() => {
      expect(mocks.deleteGenerationHistoryEntry).toHaveBeenCalledWith(
        "/p/mybook",
        HISTORY_ENTRY.filePath,
      )
    })
    refresh()
  })

  it("deleting an EXPANDED history entry resets expandedHistoryId (ternary null branch)", async () => {
    mocks.state.novelMode = true
    mocks.listGenerationHistory.mockResolvedValue([HISTORY_ENTRY])
    const { refresh } = renderLintView()
    await waitFor(() => {
      expect(screen.getByText("第 5 章 lint")).toBeInTheDocument()
    })
    // expand first, then delete while expanded
    fireEvent.click(screen.getByText("第 5 章 lint"))
    expect(screen.getByText("No incoming links")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.history.delete"))
    await waitFor(() => {
      expect(mocks.deleteGenerationHistoryEntry).toHaveBeenCalled()
    })
    refresh()
    expect(screen.queryByText("No incoming links")).not.toBeInTheDocument()
  })

  it("history entry with empty results shows emptyResult; delete confirm=false aborts", async () => {
    mocks.state.novelMode = true
    mocks.listGenerationHistory.mockResolvedValue([{ ...HISTORY_ENTRY, id: "h2", results: [] }])
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    renderLintView()
    await waitFor(() => {
      expect(screen.getByText("第 5 章 lint")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("第 5 章 lint"))
    expect(screen.getByText("novel.history.emptyResult")).toBeInTheDocument()
    fireEvent.click(screen.getByText("novel.history.delete"))
    expect(mocks.deleteGenerationHistoryEntry).not.toHaveBeenCalled()
  })

  it("novel mode with no project → history cleared, no history section", async () => {
    mocks.state.novelMode = true
    mocks.state.project = null
    renderLintView()
    expect(screen.queryByText("novel.lint.historyTitle")).not.toBeInTheDocument()
  })
})

describe("LintView — opening pages", () => {
  it("opens a page found on the first candidate", async () => {
    mocks.readFile.mockResolvedValueOnce("page-content")
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.open")[0])
    await waitFor(() => {
      expect(mocks.readFile).toHaveBeenCalledWith("/p/mybook/wiki/pages/foo.md")
    })
    expect(mocks.state.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/pages/foo.md")
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("page-content")
  })

  it("falls back to the second candidate when the first read fails", async () => {
    mocks.readFile
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce("md-content")
    setLintRunState("r1", { hasRun: true, results: [NO_OUT] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.open")[0])
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/baz.md.md")
    })
    expect(mocks.state.setFileContent).toHaveBeenCalledWith("md-content")
  })

  it("shows unableToLoad when every candidate fails", async () => {
    mocks.readFile.mockRejectedValue(new Error("missing"))
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.open")[0])
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/pages/foo.md")
    })
    expect(mocks.state.setFileContent).toHaveBeenCalledWith(
      mocks.t("lint.messages.unableToLoad", { page: "pages/foo.md" }),
    )
  })

  it("open page no-ops without a project", async () => {
    mocks.state.project = null
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.open")[0])
    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
  })

  it("opens an affected page chip", async () => {
    mocks.readFile.mockResolvedValueOnce("chip-content")
    setLintRunState("r1", { hasRun: true, results: [BROKEN] })
    renderLintView()
    fireEvent.click(screen.getByRole("button", { name: "bar.md" }))
    await waitFor(() => {
      expect(mocks.state.setSelectedFile).toHaveBeenCalledWith("/p/mybook/wiki/bar.md")
    })
  })
})

describe("LintView — fixes", () => {
  it("orphan fix: index.md lacks the entry → appends wikilink + removes result", async () => {
    mocks.readFile.mockResolvedValueOnce("existing index content")
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith(
        "/p/mybook/wiki/index.md",
        expect.stringContaining("- [[foo]]"),
      )
    })
    expect(mocks.listDirectory).toHaveBeenCalledWith("/p/mybook")
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.lintRun?.results).toHaveLength(0)
  })

  it("orphan fix: index.md read fails → fallback title is used as content base", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("no index"))
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith(
        "/p/mybook/wiki/index.md",
        expect.stringContaining("- [[foo]]"),
      )
    })
    const content = mocks.writeFile.mock.calls[0][1] as string
    expect(content).toContain(mocks.t("lint.indexFallbackTitle"))
  })

  it("orphan fix: index.md already contains the entry → no write, still refreshes tree", async () => {
    mocks.readFile.mockResolvedValueOnce("index\n- [[foo]]\n")
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    })
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("broken-link fix → confirm review item + result removed", async () => {
    setLintRunState("r1", { hasRun: true, results: [BROKEN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.reviewState.addItem).toHaveBeenCalled()
    })
    const item = mocks.reviewState.addItem.mock.calls[0][0]
    expect(item.type).toBe("confirm")
    expect(item.affectedPages).toEqual(["bar.md"])
    expect(item.options).toHaveLength(3)
    expect(mocks.state.lintRun?.results).toHaveLength(0)
  })

  it("no-outlinks fix → suggestion review item + result removed", async () => {
    setLintRunState("r1", { hasRun: true, results: [NO_OUT] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.reviewState.addItem).toHaveBeenCalled()
    })
    expect(mocks.reviewState.addItem.mock.calls[0][0].type).toBe("suggestion")
    expect(mocks.state.lintRun?.results).toHaveLength(0)
  })

  it("semantic fix: blank detail → fallback title", async () => {
    setLintRunState("r1", { hasRun: true, results: [{ ...SEMANTIC, detail: "   " }] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.reviewState.addItem).toHaveBeenCalled()
    })
    expect(mocks.reviewState.addItem.mock.calls[0][0].title).toBe(
      mocks.t("lint.reviewFallbacks.semanticTitleFallback"),
    )
    expect(mocks.state.lintRun?.results).toHaveLength(0)
  })

  it("unknown result type → semantic config fallback + default review flow", async () => {
    const weird: LintResult = {
      type: "weird" as unknown as LintResult["type"], // 故意构造非法类型测 fallback
      severity: "warning",
      page: "odd.md",
      detail: "Odd result",
    }
    setLintRunState("r1", { hasRun: true, results: [weird] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.reviewState.addItem).toHaveBeenCalled()
    })
    expect(mocks.reviewState.addItem.mock.calls[0][0].title).toBe("Odd result")
  })

  it("fix failure → console.error, fixing id cleared", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(spy).toHaveBeenCalled()
    })
    spy.mockRestore()
  })

  it("fix shows the fixing (disabled) state while in flight", async () => {
    let resolveRead: ((v: string) => void) | undefined
    mocks.readFile.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(screen.getByText("lint.fixing")).toBeInTheDocument()
    })
    resolveRead?.("index content")
  })

  it("fix no-ops without a project", async () => {
    mocks.state.project = null
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("setResults guard: lintRun cleared mid-fix → early return, tree still refreshed", async () => {
    let resolveRead: ((v: string) => void) | undefined
    mocks.readFile.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getAllByText("lint.fix")[0])
    await waitFor(() => {
      expect(mocks.readFile).toHaveBeenCalled()
    })
    // transient clear between render and fix completion → setResults early-returns
    mocks.state.setLintRun(null)
    resolveRead?.("index content")
    await waitFor(() => {
      expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    })
    expect(mocks.state.lintRun).toBeNull()
  })
})

describe("LintView — orphan deletion", () => {
  it("deletes an orphan after confirm: cascade + tree refresh + result removed", async () => {
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getByText("lint.delete"))
    await waitFor(() => {
      expect(mocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalledWith("/p/mybook", [
        "/p/mybook/wiki/pages/foo.md",
      ])
    })
    expect(mocks.state.setFileTree).toHaveBeenCalled()
    expect(mocks.state.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.state.lintRun?.results).toHaveLength(0)
  })

  it("confirm=false aborts the deletion", async () => {
    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getByText("lint.delete"))
    expect(mocks.cascadeDeleteWikiPagesWithRefs).not.toHaveBeenCalled()
  })

  it("deletion failure → console.error", async () => {
    mocks.cascadeDeleteWikiPagesWithRefs.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getByText("lint.delete"))
    await waitFor(() => {
      expect(spy).toHaveBeenCalled()
    })
    spy.mockRestore()
  })

  it("delete button only renders for orphan results; info-card orphan also gets it", () => {
    setLintRunState("r1", { hasRun: true, results: [BROKEN] })
    renderLintView()
    expect(screen.queryByText("lint.delete")).not.toBeInTheDocument()
  })

  it("an orphan-typed INFO result renders the delete button in the info section", async () => {
    const infoOrphan: LintResult = {
      type: "orphan",
      severity: "info",
      page: "info-orphan.md",
      detail: "info orphan",
    }
    setLintRunState("r1", { hasRun: true, results: [infoOrphan] })
    renderLintView()
    // info section header + delete button reachable via the info-card onDelete
    expect(screen.getAllByText("lint.sectionCount").length).toBeGreaterThan(0)
    expect(screen.getByText("lint.delete")).toBeInTheDocument()
  })

  it("orphan delete no-ops without a project (handleDeleteOrphan guard)", () => {
    mocks.state.project = null
    setLintRunState("r1", { hasRun: true, results: [ORPHAN] })
    renderLintView()
    fireEvent.click(screen.getByText("lint.delete"))
    expect(mocks.cascadeDeleteWikiPagesWithRefs).not.toHaveBeenCalled()
  })
})
