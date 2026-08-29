// @vitest-environment jsdom
/**
 * W4 / CP-100: outline-generator-dialog.tsx 全口径覆盖 spec
 * （目标 statements/branches/functions/lines 100%）。
 *
 * 策略（与 App.spec.tsx / chat-panel.spec.tsx 同模式）：
 * - vi.hoisted 提供全部可写 mock state（wiki / outline 双 store 用可调用函数 +
 *   getState），runOutline* 等异步任务 mock 直接变更 store 状态，配合 rerender
 *   取最新快照（store 非响应式）。
 * - lib 层（outline-generation / commands/fs / react-i18next）与 UI 原语
 *   （Dialog / Button / Label）全部轻量 mock，保留 props 布线。
 * - 断言全部对照源文件实现：守卫分支、createTask/updateTask 入参、错误回退、
 *   refine 的文件读取/选择逻辑、writeMode 等。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  userEvent,
  waitFor,
  within,
} from "@/test-helpers/component-test-utils"
import { OutlineGeneratorDialog, type OutlineGeneratorMode } from "./outline-generator-dialog"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

const PROJECT = { id: "p1", name: "Novel", path: "E:/Novel" }

const mocks = vi.hoisted(() => {
  const llmConfig = { provider: "openai", model: "gpt-4o", apiKey: "k", endpoint: "https://x", temperature: 1 }
  const wikiState: any = {
    project: null,
    llmConfig,
    dataVersion: 0,
    selectedFile: null,
  }

  const outlineState: any = {
    tasks: [],
  }
  const seq = { n: 0 }

  const createTask = vi.fn((input: any) => {
    const id = `outline-task-${++seq.n}`
    const now = Date.now()
    const task = {
      id,
      projectPath: input.projectPath,
      kind: input.kind ?? "outline",
      genre: input.genre ?? "",
      scale: input.scale ?? "",
      premise: input.premise ?? "",
      prompt: input.prompt ?? "",
      userRequest: input.userRequest ?? "",
      selectedSectionKey: input.selectedSectionKey ?? null,
      displayTitle: input.displayTitle ?? null,
      writeMode: input.writeMode ?? null,
      targetPath: input.targetPath ?? null,
      outlinePath: input.outlinePath ?? null,
      status: input.status ?? "generating",
      message: input.message ?? "",
      error: input.error ?? null,
      createdAt: now,
      updatedAt: now,
    }
    outlineState.tasks = [task, ...outlineState.tasks]
    return id
  })
  const updateTask = vi.fn((id: string, patch: any) => {
    outlineState.tasks = outlineState.tasks.map((t: any) =>
      t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
    )
  })
  // 组件通过 selector `s.createTask / s.updateTask` 读取，需挂在 state 对象上
  outlineState.createTask = createTask
  outlineState.updateTask = updateTask

  return {
    llmConfig,
    seq,
    wikiState,
    outlineState,
    createTask,
    updateTask,
    t: vi.fn(),
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    buildOutlineGenerationPrompt: vi.fn(),
    hasOutlineForRefinement: vi.fn(),
    runOutlineGenerationTask: vi.fn(),
    runOutlineRefinementTask: vi.fn(),
    runOutlineIngestTask: vi.fn(),
    openGeneratedOutline: vi.fn(),
    addOutlineTaskToSourceList: vi.fn(),
  }
})

function setupDefaults(): void {
  mocks.t.mockImplementation((key: string) => key)
  mocks.listDirectory.mockImplementation(async () => [] as FileNode[])
  mocks.readFile.mockImplementation(async () => "file content")
  mocks.buildOutlineGenerationPrompt.mockImplementation(async () => "built-prompt")
  mocks.hasOutlineForRefinement.mockImplementation(async () => true)
  mocks.runOutlineGenerationTask.mockImplementation(async (taskId: string) => {
    // 用新对象替换任务，使 latestTask 引用变化触发最新任务 effect
    mocks.outlineState.tasks = mocks.outlineState.tasks.map((t: any) =>
      t.id === taskId
        ? { ...t, status: "generated", outlinePath: "E:/Novel/wiki/outlines/总大纲.md", message: "生成完成", error: null, updatedAt: Date.now() }
        : t,
    )
  })
  mocks.runOutlineRefinementTask.mockImplementation(async (taskId: string) => {
    mocks.outlineState.tasks = mocks.outlineState.tasks.map((t: any) =>
      t.id === taskId
        ? { ...t, status: "generated", outlinePath: "E:/Novel/wiki/outlines/章节细纲.md", message: "细化完成", error: null, updatedAt: Date.now() }
        : t,
    )
  })
  mocks.runOutlineIngestTask.mockImplementation(async (taskId: string) => {
    mocks.outlineState.tasks = mocks.outlineState.tasks.map((t: any) =>
      t.id === taskId
        ? { ...t, status: "done", message: "已摄取", error: null, updatedAt: Date.now() }
        : t,
    )
  })
  mocks.openGeneratedOutline.mockImplementation(async () => {})
  mocks.addOutlineTaskToSourceList.mockImplementation(async () => "E:/Novel/raw/sources/总大纲.md")
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
}))

vi.mock("@/lib/novel/outline-generation", () => ({
  OUTLINE_SECTION_GENERATION_CONFIGS: [
    { key: "chapterOutlines", title: "章节细纲", englishTitle: "Chapter Outlines", englishFileName: "chapter-outlines.md", requestHint: "hint" },
    { key: "characterBriefs", title: "人物小传", englishTitle: "Character Briefs", englishFileName: "character-briefs.md", requestHint: "hint" },
    { key: "organizationsOutline", title: "组织势力设定", englishTitle: "Faction Notes", englishFileName: "organizations.md", requestHint: "hint" },
    { key: "powerSystem", title: "金手指与能力体系", englishTitle: "Power System", englishFileName: "power-system.md", requestHint: "hint" },
    { key: "foreshadowingPlan", title: "伏笔计划", englishTitle: "Foreshadowing Plan", englishFileName: "foreshadowing-plan.md", requestHint: "hint" },
    { key: "locationsOutline", title: "地点设定", englishTitle: "Location Notes", englishFileName: "locations.md", requestHint: "hint" },
  ],
  buildOutlineGenerationPrompt: mocks.buildOutlineGenerationPrompt,
  hasOutlineForRefinement: mocks.hasOutlineForRefinement,
  runOutlineGenerationTask: mocks.runOutlineGenerationTask,
  runOutlineRefinementTask: mocks.runOutlineRefinementTask,
  runOutlineIngestTask: mocks.runOutlineIngestTask,
  openGeneratedOutline: mocks.openGeneratedOutline,
  addOutlineTaskToSourceList: mocks.addOutlineTaskToSourceList,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: any) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/outline-generation-store", () => ({
  useOutlineGenerationStore: Object.assign(
    (selector: any) => selector(mocks.outlineState),
    { getState: () => mocks.outlineState },
  ),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, className }: any) => <label className={className}>{children}</label>,
}))

function seedTask(overrides: any = {}): any {
  return {
    id: "seed-1",
    projectPath: PROJECT.path,
    kind: "outline",
    genre: "general",
    scale: "medium",
    premise: "",
    prompt: "",
    userRequest: "",
    selectedSectionKey: null,
    displayTitle: null,
    writeMode: null,
    targetPath: null,
    outlinePath: null,
    status: "error",
    message: "",
    error: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

/**
 * 直接调用 React fiber props 上的 onClick（绕过 DOM disabled 门控），
 * 用于覆盖防御性守卫分支（按钮在对应状态下必然 disabled，DOM 事件无法触发）。
 */
function invokeButtonHandler(button: HTMLElement): void {
  const key = Object.keys(button).find((k) => k.startsWith("__reactProps"))
  if (!key) throw new Error("button has no react props")
  const props = (button as any)[key]
  props.onClick?.()
}

describe("OutlineGeneratorDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.seq.n = 0
    mocks.wikiState.project = null
    mocks.wikiState.llmConfig = mocks.llmConfig
    mocks.wikiState.dataVersion = 0
    mocks.wikiState.selectedFile = null
    mocks.outlineState.tasks = []
    setupDefaults()
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  function renderDialog(mode: OutlineGeneratorMode, open = true) {
    const onOpenChange = vi.fn()
    const utils = render(
      <OutlineGeneratorDialog open={open} onOpenChange={onOpenChange} mode={mode} />,
    )
    return { ...utils, onOpenChange }
  }

  describe("outline mode", () => {
    it("renders the form and disables generate until premise is typed", async () => {
      mocks.wikiState.project = PROJECT
      const { onOpenChange } = renderDialog("outline")

      // 标题 div 与底部生成按钮共用同一 t(key)，因此用 getAllByText
      expect(screen.getAllByText("novel.outlineGenerator.title").length).toBeGreaterThan(0)
      expect(screen.getByText("novel.outlineGenerator.premisePlaceholder")).toBeInTheDocument()

      // genre has all 9 keys; scale has all 4 keys
      const [genre, scale] = screen.getAllByRole("combobox")
      expect(within(genre).getAllByRole("option")).toHaveLength(9)
      expect(within(scale).getAllByRole("option")).toHaveLength(4)

      const generate = screen.getByRole("button", { name: "novel.outlineGenerator.title" })
      expect(generate).toBeDisabled()

      // cancel button calls onOpenChange(false)
      await userEvent.click(screen.getByRole("button", { name: "project.cancel" }))
      expect(onOpenChange).toHaveBeenCalledWith(false)

      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "一个侦探故事",
      )
      expect(generate).toBeEnabled()
    })

    it("lets genre/scale be changed", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("outline")
      const [genre, scale] = screen.getAllByRole("combobox")
      await userEvent.selectOptions(genre, "scifi")
      await userEvent.selectOptions(scale, "epic")
      expect((genre as HTMLSelectElement).value).toBe("scifi")
      expect((scale as HTMLSelectElement).value).toBe("epic")
    })

    it("runs the full generate flow and shows the ready panel", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("outline")

      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      expect(mocks.buildOutlineGenerationPrompt).toHaveBeenCalledWith(
        "E:/Novel",
        "novel.outlineGenerator.genres.general",
        "novel.outlineGenerator.scales.medium",
        "故事",
      )
      expect(mocks.createTask).toHaveBeenCalledWith({
        projectPath: "E:/Novel",
        genre: "general",
        scale: "medium",
        premise: "故事",
        prompt: "built-prompt",
      })
      expect(mocks.updateTask).toHaveBeenCalledWith(expect.any(String), {
        status: "generating",
        message: "novel.outlineGenerator.generationMayTakeLong",
        error: null,
      })
      expect(mocks.runOutlineGenerationTask).toHaveBeenCalledWith(expect.any(String), mocks.llmConfig, { multiAgent: false })

      // run mock mutated the task to "generated" → ready panel
      expect(screen.getByText("novel.outlineGenerator.ready")).toBeInTheDocument()
      expect(screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" }).length).toBe(2)
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.openOutline" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" })).toBeInTheDocument()
    })

    it("shows generating then taskGenerating states with deferred mocks", async () => {
      mocks.wikiState.project = PROJECT
      let resolvePrompt!: (v: string | PromiseLike<string>) => void
      let resolveRun!: (v: void | PromiseLike<void>) => void
      mocks.buildOutlineGenerationPrompt.mockReturnValueOnce(new Promise((r) => { resolvePrompt = r }))
      mocks.runOutlineGenerationTask.mockReturnValueOnce(new Promise((r) => { resolveRun = r }))

      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      const generate = screen.getByRole("button", { name: "novel.outlineGenerator.title" })
      fireEvent.click(generate)

      // generating=true (prompt pending): footer label + disabled selects
      expect(screen.getByText("novel.outlineGenerator.generating")).toBeInTheDocument()
      const [genre, scale] = screen.getAllByRole("combobox")
      expect(genre).toBeDisabled()
      expect(scale).toBeDisabled()
      // generating guard: second click is a no-op
      fireEvent.click(generate)
      expect(mocks.buildOutlineGenerationPrompt).toHaveBeenCalledTimes(1)

      await act(async () => { resolvePrompt("prompt") })

      // taskGenerating=true (run pending): generating panel + hideAndContinue + disabled inputs
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.generatingTitle")).toBeInTheDocument(),
      )
      expect(screen.getByText("novel.outlineGenerator.generationMayTakeLong")).toBeInTheDocument()
      expect(screen.getByText("novel.outlineGenerator.hideAndContinue")).toBeInTheDocument()
      expect(screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder")).toBeDisabled()
      expect(mocks.updateTask).toHaveBeenCalledWith(expect.any(String), {
        status: "generating",
        message: "novel.outlineGenerator.generationMayTakeLong",
        error: null,
      })

      await act(async () => { resolveRun() })
    })

    it("shows error banner when prompt build fails without a previous task", async () => {
      mocks.wikiState.project = PROJECT
      mocks.buildOutlineGenerationPrompt.mockRejectedValueOnce(new Error("prompt-fail"))

      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.error：prompt-fail")).toBeInTheDocument(),
      )
      // createTask never ran → no failedTask → updateTask untouched
      expect(mocks.createTask).not.toHaveBeenCalled()
      expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("marks the latest matching task as error when prompt build fails", async () => {
      mocks.wikiState.project = PROJECT
      mocks.outlineState.tasks = [
        seedTask({ id: "seed-1", updatedAt: 100 }),
        seedTask({ id: "seed-2", status: "generated", updatedAt: 200 }),
      ]
      mocks.buildOutlineGenerationPrompt.mockRejectedValueOnce(new Error("prompt-fail-2"))

      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      // 两个任务 → failedTask 排序比较器执行 → 取 updatedAt 最新者
      await waitFor(() =>
        expect(mocks.updateTask).toHaveBeenCalledWith(
          "seed-2",
          expect.objectContaining({ status: "error", error: "prompt-fail-2", message: "prompt-fail-2" }),
        ),
      )
      expect(screen.getByText(/prompt-fail-2/)).toBeInTheDocument()
    })

    it("falls back to String(err) when the prompt build rejects with a plain value", async () => {
      mocks.wikiState.project = PROJECT
      mocks.buildOutlineGenerationPrompt.mockRejectedValueOnce("prompt-str-fail")

      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.error：prompt-str-fail")).toBeInTheDocument(),
      )
    })

    it("falls back to String(err) when ingest fails with a plain value", async () => {
      mocks.wikiState.project = PROJECT
      mocks.runOutlineIngestTask.mockRejectedValueOnce("ingest-str-fail")
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" })[0])
      await waitFor(() => expect(screen.getByText("ingest-str-fail")).toBeInTheDocument())
      expect(mocks.updateTask).toHaveBeenCalledWith(
        "outline-task-1",
        expect.objectContaining({ status: "error", error: "ingest-str-fail", message: "ingest-str-fail" }),
      )
    })

    it("falls back to String(err) when addToList fails with a plain value", async () => {
      mocks.wikiState.project = PROJECT
      mocks.addOutlineTaskToSourceList.mockRejectedValueOnce("add-str-fail")
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" }))
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.error：add-str-fail")).toBeInTheDocument(),
      )
    })

    it("guards handleGenerate without project and while generating/taskGenerating", async () => {
      // !project：无项目但填了 premise → 点击命中守卫
      const r1 = renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))
      expect(mocks.buildOutlineGenerationPrompt).not.toHaveBeenCalled()
      r1.unmount()

      // generating：prompt 挂起期间再次触发 handler
      mocks.wikiState.project = PROJECT
      let resolvePrompt!: (v: string | PromiseLike<string>) => void
      let resolveRun!: (v: void | PromiseLike<void>) => void
      mocks.buildOutlineGenerationPrompt.mockReturnValueOnce(new Promise((r) => { resolvePrompt = r }))
      mocks.runOutlineGenerationTask.mockReturnValueOnce(new Promise((r) => { resolveRun = r }))
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))
      const generateBtn = screen.getByRole("button", { name: "novel.outlineGenerator.generating" })
      await act(async () => { invokeButtonHandler(generateBtn) })
      expect(mocks.buildOutlineGenerationPrompt).toHaveBeenCalledTimes(1)

      // taskGenerating：任务已创建但仍在运行期间再次触发 handler
      await act(async () => { resolvePrompt("prompt") })
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.generatingTitle")).toBeInTheDocument(),
      )
      const generatingBtn = screen.getByRole("button", { name: "novel.outlineGenerator.title" })
      await act(async () => { invokeButtonHandler(generatingBtn) })
      expect(mocks.createTask).toHaveBeenCalledTimes(1)
      await act(async () => { resolveRun() })
    })

    it("seeds ingestResult from a done task via the latestTask effect", async () => {
      mocks.wikiState.project = PROJECT
      mocks.outlineState.tasks = [
        seedTask({ status: "done", message: "摄取完成", outlinePath: null }),
      ]
      renderDialog("outline")

      await waitFor(() => expect(screen.getByText("摄取完成")).toBeInTheDocument())
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.title" })).toBeInTheDocument()
    })

    it("seeds error from an error task via the latestTask effect", async () => {
      mocks.wikiState.project = PROJECT
      const { rerender } = renderDialog("outline")

      // 任务在挂载后才转为 error → latestTask 引用变化 → effect 写入错误（挂载时的 reset effect 会先清空）
      await act(async () => {
        mocks.outlineState.tasks = [
          seedTask({ status: "error", error: "旧错误", message: "旧错误" }),
        ]
      })
      rerender(<OutlineGeneratorDialog open mode="outline" onOpenChange={vi.fn()} />)

      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.error：旧错误")).toBeInTheDocument(),
      )
    })

    it("picks the latest task matching project + kind (sort + filter)", async () => {
      mocks.wikiState.project = PROJECT
      mocks.outlineState.tasks = [
        seedTask({ id: "old", status: "error", error: "旧错", message: "旧错", updatedAt: 100 }),
        seedTask({ id: "new", status: "done", message: "新完成", updatedAt: 200 }),
        seedTask({ id: "other-proj", projectPath: "E:/Other", status: "done", message: "别家", updatedAt: 999 }),
        seedTask({ id: "ingest-kind", kind: "ingest", status: "done", message: "摄取类", updatedAt: 999 }),
      ]
      renderDialog("outline")

      await waitFor(() => expect(screen.getByText("新完成")).toBeInTheDocument())
      expect(screen.queryByText("旧错")).not.toBeInTheDocument()
    })

    it("opens the generated outline and closes the dialog", async () => {
      mocks.wikiState.project = PROJECT
      const { onOpenChange } = renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.openOutline" }))
      expect(mocks.openGeneratedOutline).toHaveBeenCalledWith("outline-task-1")
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("adds the outline to the source list", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" }))
      expect(mocks.addOutlineTaskToSourceList).toHaveBeenCalledWith("outline-task-1")
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.addedToOutlineList")).toBeInTheDocument(),
      )
    })

    it("does not set ingestResult when addToList resolves null", async () => {
      mocks.wikiState.project = PROJECT
      mocks.addOutlineTaskToSourceList.mockResolvedValueOnce(null)
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" }))
      expect(screen.queryByText("novel.outlineGenerator.addedToOutlineList")).not.toBeInTheDocument()
    })

    it("shows error banner when addToList fails", async () => {
      mocks.wikiState.project = PROJECT
      mocks.addOutlineTaskToSourceList.mockRejectedValueOnce(new Error("add-fail"))
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" }))
      await waitFor(() => expect(screen.getByText(/add-fail/)).toBeInTheDocument())
    })

    it("ingests the outline and shows the refreshed message", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" })[0])
      expect(mocks.runOutlineIngestTask).toHaveBeenCalledWith("outline-task-1")
      await waitFor(() => expect(screen.getByText("已摄取")).toBeInTheDocument())
    })

    it("falls back to ingestFailed when the task is gone after ingest", async () => {
      mocks.wikiState.project = PROJECT
      mocks.runOutlineIngestTask.mockImplementationOnce(async (taskId: string) => {
        mocks.outlineState.tasks = mocks.outlineState.tasks.filter((t: any) => t.id !== taskId)
      })
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" })[0])
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.ingestFailed")).toBeInTheDocument(),
      )
    })

    it("shows ingest error message and marks the task error", async () => {
      mocks.wikiState.project = PROJECT
      mocks.runOutlineIngestTask.mockRejectedValueOnce(new Error("ingest-fail"))
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      await userEvent.click(screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" })[0])
      await waitFor(() => expect(screen.getByText("ingest-fail")).toBeInTheDocument())
      expect(mocks.updateTask).toHaveBeenCalledWith(
        "outline-task-1",
        expect.objectContaining({ status: "error", error: "ingest-fail", message: "ingest-fail" }),
      )
    })

    it("guards the ingest handler while ingesting", async () => {
      mocks.wikiState.project = PROJECT
      let resolveIngest!: (v: void | PromiseLike<void>) => void
      mocks.runOutlineIngestTask.mockReturnValueOnce(new Promise((r) => { resolveIngest = r }))
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      const ingestBtn = screen.getAllByRole("button", { name: "novel.outlineGenerator.ingest" })[0]
      await userEvent.click(ingestBtn)
      // ingesting=true → "摄取中..." labels + cancel disabled
      expect(screen.getAllByText("novel.outlineGenerator.ingesting").length).toBeGreaterThan(0)
      expect(screen.getByRole("button", { name: "project.cancel" })).toBeDisabled()
      // ingesting 守卫：直接调用 handler 命中 `ingesting` 分支
      await act(async () => { invokeButtonHandler(ingestBtn) })
      expect(mocks.runOutlineIngestTask).toHaveBeenCalledTimes(1)

      await act(async () => { resolveIngest() })
    })

    it("guards the addToList handler while addingToList", async () => {
      mocks.wikiState.project = PROJECT
      let resolveAdd!: (p: string) => void
      mocks.addOutlineTaskToSourceList.mockReturnValueOnce(new Promise((r) => { resolveAdd = r }))
      renderDialog("outline")
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.premisePlaceholder"),
        "故事",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.title" }))

      const addBtn = screen.getByRole("button", { name: "novel.outlineGenerator.addToOutlineList" })
      await userEvent.click(addBtn)
      // addingToList=true → 文案切换
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.addingToOutlineList" })).toBeDisabled()
      // addingToList 守卫：直接调用 handler 命中守卫分支
      await act(async () => { invokeButtonHandler(addBtn) })
      expect(mocks.addOutlineTaskToSourceList).toHaveBeenCalledTimes(1)
      await act(async () => { resolveAdd("E:/Novel/raw/sources/总大纲.md") })
    })

    it("renders nothing when closed", () => {
      mocks.wikiState.project = PROJECT
      renderDialog("outline", false)
      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
      expect(screen.queryByText("novel.outlineGenerator.title")).not.toBeInTheDocument()
    })
  })

  describe("refine mode", () => {
    it("shows missing-outline warning and disables actions when no outline exists", async () => {
      mocks.wikiState.project = PROJECT
      mocks.hasOutlineForRefinement.mockResolvedValueOnce(false)
      renderDialog("refine")

      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.refineMissingOutline")).toBeInTheDocument(),
      )
      expect(screen.getByText("novel.outlineGenerator.refineMissingOutlineHint")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "章节细纲" })).toBeDisabled()
    })

    it("shows the checking panel while hasOutlineForRefinement is pending", async () => {
      mocks.wikiState.project = PROJECT
      let resolveCheck!: (v: boolean) => void
      mocks.hasOutlineForRefinement.mockReturnValueOnce(new Promise((r) => { resolveCheck = r }))
      renderDialog("refine")

      expect(screen.getByText("novel.outlineGenerator.refineCheckingOutline")).toBeInTheDocument()
      await act(async () => { resolveCheck(true) })
      await waitFor(() =>
        expect(screen.queryByText("novel.outlineGenerator.refineCheckingOutline")).not.toBeInTheDocument(),
      )
    })

    it("falls back to canRefine=false when the outline check fails", async () => {
      mocks.wikiState.project = PROJECT
      mocks.hasOutlineForRefinement.mockRejectedValueOnce(new Error("check-boom"))
      renderDialog("refine")

      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.refineMissingOutline")).toBeInTheDocument(),
      )
    })

    it("reruns the outline check when dataVersion changes", async () => {
      mocks.wikiState.project = PROJECT
      const { rerender } = renderDialog("refine")
      expect(mocks.hasOutlineForRefinement).toHaveBeenCalledTimes(1)

      mocks.wikiState.dataVersion = 1
      rerender(<OutlineGeneratorDialog open mode="refine" onOpenChange={vi.fn()} />)
      await waitFor(() => expect(mocks.hasOutlineForRefinement).toHaveBeenCalledTimes(2))
    })

    it("ignores the outline-check result after unmount", async () => {
      mocks.wikiState.project = PROJECT
      let resolveCheck!: (v: boolean) => void
      mocks.hasOutlineForRefinement.mockReturnValueOnce(new Promise((r) => { resolveCheck = r }))
      const { unmount } = renderDialog("refine")
      unmount()
      await act(async () => { resolveCheck(true) })
      // no crash / no state update
    })

    it("ignores the outline-check rejection after unmount", async () => {
      mocks.wikiState.project = PROJECT
      let rejectCheck!: (e: Error) => void
      mocks.hasOutlineForRefinement.mockReturnValueOnce(new Promise((_, r) => { rejectCheck = r }))
      const { unmount } = renderDialog("refine")
      unmount()
      await act(async () => { rejectCheck(new Error("late")) })
      // no crash / no state update
    })

    it("flattens outline files (incl. nested dirs) and keeps only last 10 chapters", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/outlines")) {
          return [
            { name: "总大纲.md", path: "E:/Novel/wiki/outlines/总大纲.md", is_dir: false },
            {
              name: "sub",
              path: "E:/Novel/wiki/outlines/sub",
              is_dir: true,
              children: [
                { name: "设定.md", path: "E:/Novel/wiki/outlines/sub/设定.md", is_dir: false },
              ],
            },
            { name: "notes.txt", path: "E:/Novel/wiki/outlines/notes.txt", is_dir: false },
          ]
        }
        if (p.endsWith("/wiki/chapters")) {
          return [
            ...Array.from({ length: 12 }, (_, i) => {
              const n = `ch${String(i + 1).padStart(2, "0")}`
              return { name: `${n}.md`, path: `E:/Novel/wiki/chapters/${n}.md`, is_dir: false }
            }),
            {
              name: "sub2",
              path: "E:/Novel/wiki/chapters/sub2",
              is_dir: true,
              children: [
                { name: "附录.md", path: "E:/Novel/wiki/chapters/sub2/附录.md", is_dir: false },
              ],
            },
            { name: "readme.txt", path: "E:/Novel/wiki/chapters/readme.txt", is_dir: false },
          ]
        }
        return []
      })
      renderDialog("refine")

      await waitFor(() => expect(screen.getByText("总大纲")).toBeInTheDocument())
      expect(screen.getByText("设定")).toBeInTheDocument()
      expect(screen.queryByText("notes")).not.toBeInTheDocument()
      // outline checkboxes (2) + chapter checkboxes (10) = 12
      await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(12))
    })

    it("supports select-all / clear / toggle on outline files with counts", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/outlines")) {
          return [
            { name: "总大纲.md", path: "E:/Novel/wiki/outlines/总大纲.md", is_dir: false },
            { name: "分卷.md", path: "E:/Novel/wiki/outlines/分卷.md", is_dir: false },
          ]
        }
        return []
      })
      renderDialog("refine")

      await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2))
      const outlineChecks = screen.getAllByRole("checkbox")

      // toggle one on
      await userEvent.click(outlineChecks[0])
      expect(screen.getByText("已选中 1 / 2")).toBeInTheDocument()

      // 全选
      await userEvent.click(screen.getAllByRole("button", { name: "全选" })[0])
      expect(screen.getByText("已选中 2 / 2")).toBeInTheDocument()

      // toggle one off (checkbox delete branch)
      await userEvent.click(outlineChecks[0])
      expect(screen.getByText("已选中 1 / 2")).toBeInTheDocument()

      // 清空
      await userEvent.click(screen.getAllByRole("button", { name: "清空" })[0])
      expect(screen.queryByText(/已选中/)).not.toBeInTheDocument()
    })

    it("builds refine request with selected outline file content (with user request)", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/outlines")) {
          return [
            { name: "总大纲.md", path: "E:/Novel/wiki/outlines/总大纲.md", is_dir: false },
          ]
        }
        return []
      })
      const { rerender } = renderDialog("refine")
      await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))

      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.refineRequestPlaceholder"),
        "写细纲",
      )
      const outlineCheck = screen.getAllByRole("checkbox")[0]
      await userEvent.click(outlineCheck)
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.readFile).toHaveBeenCalledWith("E:/Novel/wiki/outlines/总大纲.md")
      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "E:/Novel",
          kind: "refine",
          userRequest: expect.stringContaining("用户选中的大纲文件内容"),
          displayTitle: "novel.outlineGenerator.refineTitle",
          writeMode: "newFileAndAddToList",
          targetPath: null,
        }),
      )
      expect(mocks.runOutlineRefinementTask).toHaveBeenCalledWith(expect.any(String), mocks.llmConfig)

      // store 非响应式：rerender 取最新快照 → 内联 generated 面板 + refineResult 面板
      rerender(<OutlineGeneratorDialog open mode="refine" onOpenChange={vi.fn()} />)
      await waitFor(() => expect(screen.getAllByText("细化完成").length).toBeGreaterThan(0))
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.openOutline" })).toBeInTheDocument()
    })

    it("builds refine request from chapter files when request is empty", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/chapters")) {
          return [
            { name: "第01章.md", path: "E:/Novel/wiki/chapters/第01章.md", is_dir: false },
          ]
        }
        return []
      })
      renderDialog("refine")
      await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))

      const chapterCheck = screen.getAllByRole("checkbox")[0]
      await userEvent.click(chapterCheck)
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          userRequest: expect.stringContaining("请基于以下选中章节进行细化生成"),
        }),
      )
    })

    it("appends chapter content when both request and chapter are selected", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/chapters")) {
          return [
            { name: "第01章.md", path: "E:/Novel/wiki/chapters/第01章.md", is_dir: false },
          ]
        }
        return []
      })
      renderDialog("refine")

      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.refineRequestPlaceholder"),
        "补充冲突",
      )
      await userEvent.click(screen.getAllByRole("checkbox")[0])
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          userRequest: expect.stringContaining("用户选中的章节内容"),
        }),
      )
    })

    it("falls back to （读取失败） when a selected file cannot be read", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/outlines")) {
          return [
            { name: "总大纲.md", path: "E:/Novel/wiki/outlines/总大纲.md", is_dir: false },
          ]
        }
        return []
      })
      mocks.readFile.mockRejectedValueOnce(new Error("no access"))
      renderDialog("refine")
      await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))

      await userEvent.click(screen.getAllByRole("checkbox")[0])
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          userRequest: expect.stringContaining("（读取失败）"),
        }),
      )
    })

    it("selects/deselects a section and shows the section hint", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("refine")

      const sectionBtn = screen.getByRole("button", { name: "章节细纲" })
      await userEvent.click(sectionBtn)
      expect(screen.getByText("novel.outlineGenerator.sectionGeneratingHint")).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "novel.outlineGenerator.sectionButtons.chapterOutlines" }),
      ).toBeInTheDocument()

      // deselect again
      await userEvent.click(sectionBtn)
      expect(screen.queryByText("novel.outlineGenerator.sectionGeneratingHint")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" })).toBeInTheDocument()
    })

    it("creates a section refine task with the section title", async () => {
      mocks.wikiState.project = PROJECT
      renderDialog("refine")

      await userEvent.click(screen.getByRole("button", { name: "人物小传" }))
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.refineRequestPlaceholder"),
        "细化人物",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.sectionButtons.characterBriefs" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "refine",
          selectedSectionKey: "characterBriefs",
          displayTitle: "人物小传",
          userRequest: "细化人物",
        }),
      )
      expect(mocks.updateTask).toHaveBeenCalledWith(expect.any(String), {
        status: "generating",
        message: "novel.outlineGenerator.sectionGenerating",
        error: null,
      })
    })

    it("supports appendCurrent write mode when the selected file is an outline md", async () => {
      mocks.wikiState.project = PROJECT
      mocks.wikiState.selectedFile = "E:/Novel/wiki/outlines/总大纲.md"
      renderDialog("refine")

      const newFileRadio = screen.getByLabelText("novel.outlineGenerator.refineWriteModeNewFile")
      const appendRadio = screen.getByLabelText("novel.outlineGenerator.refineWriteModeAppendCurrent")
      expect(appendRadio).toBeEnabled()
      expect(screen.queryByText("novel.outlineGenerator.refineWriteModeAppendHint")).not.toBeInTheDocument()

      // 先切到 appendCurrent，再切回 newFile（触发 newFile radio 的 onChange）
      await userEvent.click(appendRadio)
      await userEvent.click(newFileRadio)
      expect((newFileRadio as HTMLInputElement).checked).toBe(true)
      await userEvent.click(appendRadio)
      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.refineRequestPlaceholder"),
        "追加内容",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          writeMode: "appendCurrent",
          targetPath: "E:/Novel/wiki/outlines/总大纲.md",
        }),
      )
    })

    it("disables appendCurrent radio when the selected file is not an outline md", async () => {
      mocks.wikiState.project = PROJECT
      mocks.wikiState.selectedFile = "E:/Novel/foo.md"
      renderDialog("refine")

      const appendRadio = screen.getByLabelText("novel.outlineGenerator.refineWriteModeAppendCurrent")
      expect(appendRadio).toBeDisabled()
      expect(screen.getByText("novel.outlineGenerator.refineWriteModeAppendHint")).toBeInTheDocument()
    })

    it("shows section-generating labels while a section refine is running", async () => {
      mocks.wikiState.project = PROJECT
      let resolveRun!: (v: void | PromiseLike<void>) => void
      mocks.runOutlineRefinementTask.mockReturnValueOnce(new Promise((r) => { resolveRun = r }))
      const { rerender } = renderDialog("refine")

      await userEvent.click(screen.getByRole("button", { name: "章节细纲" }))
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.sectionButtons.chapterOutlines" }))

      // store 非响应式：rerender 取最新快照显示 taskGenerating 状态
      rerender(<OutlineGeneratorDialog open mode="refine" onOpenChange={vi.fn()} />)
      await waitFor(() =>
        expect(screen.getAllByText("novel.outlineGenerator.sectionGenerating").length).toBeGreaterThan(0),
      )
      // taskGenerating guard: a forced second click does not create another task
      fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.sectionGenerating" }))
      expect(mocks.createTask).toHaveBeenCalledTimes(1)

      await act(async () => { resolveRun() })
    })

    it("shows the generic refining label when no section/displayTitle is set", async () => {
      mocks.wikiState.project = PROJECT
      let resolveRun!: (v: void | PromiseLike<void>) => void
      mocks.runOutlineRefinementTask.mockReturnValueOnce(new Promise((r) => { resolveRun = r }))
      const { rerender } = renderDialog("refine")

      await userEvent.type(
        screen.getByPlaceholderText("novel.outlineGenerator.refineRequestPlaceholder"),
        "细化",
      )
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      rerender(<OutlineGeneratorDialog open mode="refine" onOpenChange={vi.fn()} />)
      await waitFor(() =>
        expect(screen.getAllByText("novel.outlineGenerator.refining").length).toBeGreaterThan(0),
      )
      await act(async () => { resolveRun() })
    })

    it("shows the error banner in raw form when refine task creation throws", async () => {
      mocks.wikiState.project = PROJECT
      mocks.createTask.mockImplementationOnce(() => {
        throw new Error("refine-boom")
      })
      renderDialog("refine")

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      expect(screen.getByText("refine-boom")).toBeInTheDocument()
    })

    it("supports select-all / clear / toggle on chapter files with counts", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/chapters")) {
          return [
            { name: "第01章.md", path: "E:/Novel/wiki/chapters/第01章.md", is_dir: false },
            { name: "第02章.md", path: "E:/Novel/wiki/chapters/第02章.md", is_dir: false },
          ]
        }
        return []
      })
      renderDialog("refine")
      await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(2))
      const chapterChecks = screen.getAllByRole("checkbox")

      // toggle one on
      await userEvent.click(chapterChecks[0])
      expect(screen.getByText("已选中 1 / 2")).toBeInTheDocument()

      // 全选（章节区）
      await userEvent.click(screen.getAllByRole("button", { name: "全选" })[0])
      expect(screen.getByText("已选中 2 / 2")).toBeInTheDocument()

      // toggle one off
      await userEvent.click(chapterChecks[0])
      expect(screen.getByText("已选中 1 / 2")).toBeInTheDocument()

      // 清空
      await userEvent.click(screen.getAllByRole("button", { name: "清空" })[0])
      expect(screen.queryByText(/已选中/)).not.toBeInTheDocument()
    })

    it("falls back to （读取失败） when a selected chapter file cannot be read", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockImplementation(async (p: string) => {
        if (p.endsWith("/wiki/chapters")) {
          return [
            { name: "第01章.md", path: "E:/Novel/wiki/chapters/第01章.md", is_dir: false },
          ]
        }
        return []
      })
      mocks.readFile.mockRejectedValueOnce(new Error("no access"))
      renderDialog("refine")
      await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))

      await userEvent.click(screen.getAllByRole("checkbox")[0])
      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))

      expect(mocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          userRequest: expect.stringContaining("（读取失败）"),
        }),
      )
    })

    it("guards refine generation for project / taskGenerating / checkingOutline / canRefine", async () => {
      // !project
      const r1 = renderDialog("refine")
      await act(async () => {
        invokeButtonHandler(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      })
      expect(mocks.createTask).not.toHaveBeenCalled()
      r1.unmount()

      // taskGenerating（种子任务 status=generating）→ 底部按钮文案为 refining
      mocks.wikiState.project = PROJECT
      mocks.outlineState.tasks = [
        seedTask({ kind: "refine", status: "generating", message: "生成中" }),
      ]
      const r2 = renderDialog("refine")
      await act(async () => {
        invokeButtonHandler(screen.getByRole("button", { name: "novel.outlineGenerator.refining" }))
      })
      expect(mocks.createTask).not.toHaveBeenCalled()
      r2.unmount()

      // checkingOutline（检查挂起中）
      mocks.outlineState.tasks = []
      let resolveCheck!: (v: boolean) => void
      mocks.hasOutlineForRefinement.mockReturnValueOnce(new Promise((r) => { resolveCheck = r }))
      const r3 = renderDialog("refine")
      await act(async () => {
        invokeButtonHandler(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      })
      expect(mocks.createTask).not.toHaveBeenCalled()
      await act(async () => { resolveCheck(true) })
      r3.unmount()

      // !canRefine（检查返回 false）
      mocks.hasOutlineForRefinement.mockResolvedValueOnce(false)
      const r4 = renderDialog("refine")
      await waitFor(() =>
        expect(screen.getByText("novel.outlineGenerator.refineMissingOutline")).toBeInTheDocument(),
      )
      await act(async () => {
        invokeButtonHandler(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      })
      expect(mocks.createTask).not.toHaveBeenCalled()
      r4.unmount()
    })

    it("falls back to String(err) when refine task creation throws a plain value", async () => {
      mocks.wikiState.project = PROJECT
      mocks.createTask.mockImplementationOnce(() => {
        throw "refine-str-boom"
      })
      renderDialog("refine")

      await userEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      expect(screen.getByText("refine-str-boom")).toBeInTheDocument()
    })

    it("guards refine generation when canRefine is false", async () => {
      mocks.wikiState.project = PROJECT
      mocks.hasOutlineForRefinement.mockResolvedValueOnce(false)
      renderDialog("refine")

      fireEvent.click(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" }))
      expect(mocks.createTask).not.toHaveBeenCalled()
    })

    it("clears file lists when project is null", async () => {
      renderDialog("refine")
      await waitFor(() =>
        expect(screen.queryByText("选中大纲文件")).not.toBeInTheDocument(),
      )
      expect(screen.getByText("novel.outlineGenerator.refineMissingOutline")).toBeInTheDocument()
    })

    it("keeps empty file lists when listDirectory fails", async () => {
      mocks.wikiState.project = PROJECT
      mocks.listDirectory.mockRejectedValue(new Error("fs-boom"))
      renderDialog("refine")

      await waitFor(() =>
        expect(screen.queryByText("选中大纲文件")).not.toBeInTheDocument(),
      )
      expect(screen.queryByText("选中章节（最近10章）")).not.toBeInTheDocument()
    })

    it("ignores file-list results after unmount", async () => {
      mocks.wikiState.project = PROJECT
      let resolveList!: (v: FileNode[]) => void
      mocks.listDirectory.mockReturnValueOnce(new Promise((r) => { resolveList = r }))
      const { unmount } = renderDialog("refine")
      unmount()
      await act(async () => { resolveList([]) })
      // no crash / no state update
    })

    it("resets error/selection state when switching modes", async () => {
      mocks.wikiState.project = PROJECT
      const { rerender } = renderDialog("outline")
      // 任务在挂载后才转为 error，触发 latestTask effect 显示错误
      await act(async () => {
        mocks.outlineState.tasks = [
          seedTask({ status: "error", error: "模式旧错", message: "模式旧错" }),
        ]
      })
      rerender(<OutlineGeneratorDialog open mode="outline" onOpenChange={vi.fn()} />)
      await waitFor(() => expect(screen.getByText(/模式旧错/)).toBeInTheDocument())

      rerender(<OutlineGeneratorDialog open mode="refine" onOpenChange={vi.fn()} />)
      await waitFor(() => expect(screen.queryByText(/模式旧错/)).not.toBeInTheDocument())
      expect(screen.getByRole("button", { name: "novel.outlineGenerator.refineTitle" })).toBeInTheDocument()
    })
  })
})
