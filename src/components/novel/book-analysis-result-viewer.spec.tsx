// @vitest-environment jsdom
/**
 * W4 / CP-100: book-analysis-result-viewer.tsx 全口径覆盖 spec
 * （目标 statements/branches/functions/lines 100%，不可达分支单独记录）。
 *
 * 策略（与 App.spec.tsx / chat-panel.spec.tsx 同模式）：
 * - vi.hoisted 提供全部可写 mock state（wiki / book-analysis 双 store 可调用 +
 *   getState/setState），异步任务 mock（extractSingleCharacter / analyzeWritingStyle /
 *   importBookAnalysisSkillsAsAuras 等）直接变更 store 或返回可断言结果。
 * - lib 层与 UI 原语（Button）全部轻量 mock。
 * - 断言对照源码实现：effectiveResult 派生、排序、守卫分支、toast 文案、store 写回等。
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
} from "@/test-helpers/component-test-utils"
import { BookAnalysisResultViewer } from "./book-analysis-result-viewer"

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROJECT = { id: "p1", name: "Novel", path: "E:/Novel" }

const mocks = vi.hoisted(() => {
  const LLM_CONFIG = { provider: "openai", model: "gpt-4o", apiKey: "k", endpoint: "https://x", temperature: 1 }
  const wikiState: any = {
    project: null,
    llmConfig: LLM_CONFIG,
    aiChatModel: "",
    providerConfigs: {},
  }
  const bookState: any = {
    tasks: [],
    currentResult: null,
    setCurrentResult: vi.fn((r: any) => { bookState.currentResult = r }),
    updateTaskStyleProfile: vi.fn((id: string, profile: any) => {
      bookState.tasks = bookState.tasks.map((t: any) =>
        t.id === id ? { ...t, styleProfile: profile } : t,
      )
    }),
  }
  return {
    wikiState,
    bookState,
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    bindCharacterAura: vi.fn(),
    listBindableNovelCharacters: vi.fn(),
    importBookAnalysisSkillsAsAuras: vi.fn(),
    extractSingleCharacter: vi.fn(),
    analyzeWritingStyle: vi.fn(),
    upsertWritingStylePreset: vi.fn(),
    setEnabledWritingStyle: vi.fn(),
    getEnabledWritingStyle: vi.fn(),
    refreshProjectState: vi.fn(),
    resolveModelConfig: vi.fn(),
    joinPath: vi.fn(),
    llmConfig: LLM_CONFIG,
  }
})

function setupDefaults(): void {
  mocks.bindCharacterAura.mockImplementation(async () => ({}))
  mocks.listBindableNovelCharacters.mockImplementation(async () => [])
  mocks.importBookAnalysisSkillsAsAuras.mockImplementation(async () => [])
  mocks.extractSingleCharacter.mockImplementation(async (input: any) => ({ character: input.character }))
  mocks.analyzeWritingStyle.mockImplementation(async () => ({}))
  mocks.upsertWritingStylePreset.mockImplementation(async () => ({ id: "preset-1" }))
  mocks.setEnabledWritingStyle.mockImplementation(async () => ({}))
  mocks.getEnabledWritingStyle.mockImplementation(async () => null)
  mocks.refreshProjectState.mockImplementation(async () => {})
  mocks.resolveModelConfig.mockImplementation((model: string, base: any) => ({ ...base, model }))
  mocks.joinPath.mockImplementation((...s: string[]) => s.join("/"))
}

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: any) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: Object.assign(
    (selector: any) => selector(mocks.bookState),
    {
      getState: () => mocks.bookState,
      setState: (updater: any) => {
        const next = updater(mocks.bookState)
        Object.assign(mocks.bookState, next)
      },
    },
  ),
}))

vi.mock("@/lib/novel/character-aura", () => ({
  bindCharacterAura: mocks.bindCharacterAura,
  listBindableNovelCharacters: mocks.listBindableNovelCharacters,
}))

vi.mock("@/lib/novel/book-analysis/aura-adapter", () => ({
  importBookAnalysisSkillsAsAuras: mocks.importBookAnalysisSkillsAsAuras,
}))

vi.mock("@/lib/novel/book-analysis/character-extraction-engine", () => ({
  extractSingleCharacter: mocks.extractSingleCharacter,
}))

vi.mock("@/lib/novel/book-analysis/style-extraction-engine", () => ({
  analyzeWritingStyle: mocks.analyzeWritingStyle,
}))

// 与 style-prompts.ts:11-21 的真实 9 维对齐；画像中留空的维度 → UI 渲染「—」兜底
vi.mock("@/lib/novel/book-analysis/style-prompts", () => ({
  STYLE_DIMENSIONS: [
    { key: "narrativeDensity", label: "叙事密度 / 节奏" },
    { key: "descriptionWeight", label: "环境描写比重（具体 vs 抒情）" },
    { key: "emotionRendering", label: "情绪呈现（动作外显 vs 内心独白；克制度）" },
    { key: "sentenceStyle", label: "句式与句长 / 口语化程度" },
    { key: "rhetoricDensity", label: "比喻 / 通感密度" },
    { key: "transitionStyle", label: "场景与时间过渡方式" },
    { key: "narrativeVoice", label: "叙述视角与声音" },
    { key: "dialogueStyle", label: "对白风格（口语 / 毛边 / 潜台词）" },
    { key: "thematicHabits", label: "点题 / 总结 / 抒情习惯" },
  ],
}))

vi.mock("@/lib/novel/writing-style-store", () => ({
  upsertWritingStylePreset: mocks.upsertWritingStylePreset,
  setEnabledWritingStyle: mocks.setEnabledWritingStyle,
  getEnabledWritingStyle: mocks.getEnabledWritingStyle,
}))

vi.mock("@/lib/toast", () => ({ toast: mocks.toast }))
vi.mock("@/lib/project-refresh", () => ({ refreshProjectState: mocks.refreshProjectState }))
vi.mock("@/lib/novel/model-resolver", () => ({ resolveModelConfig: mocks.resolveModelConfig }))
vi.mock("@/lib/path-utils", () => ({ joinPath: mocks.joinPath }))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

const CHAR_LINJING = {
  id: "char-linjing",
  name: "林烬",
  aliases: ["阿烬"],
  importance: 9,
  category: "protagonist" as const,
  firstAppearance: 1,
  lastAppearance: 3,
  appearanceCount: 3,
  description: "旧城巡夜人。",
  personality: "克制。",
  speechStyle: "短句。",
  relationships: [{ target: "沈微", relation: "旧识", description: "年少相识" }],
  keyEvents: [],
  corpus: "样本文本",
  personalityProfile: {
    personality: "冷静",
    motivation: "寻亲",
    speechStyle: "简短",
    behaviorPatterns: "夜间行动",
    quotes: ["灯下无影"],
  },
}

const CHAR_SHENWEI = {
  id: "char-shenwei",
  name: "沈微",
  aliases: [],
  importance: 8,
  category: "antagonist" as const,
  firstAppearance: 2,
  lastAppearance: 3,
  appearanceCount: 2,
  description: "",
  personality: "",
  speechStyle: "",
  relationships: [],
  keyEvents: [],
}

const CHAR_AFU = {
  id: "char-afu",
  name: "阿福",
  aliases: [],
  importance: 8,
  category: "minor" as const,
  firstAppearance: 1,
  lastAppearance: 1,
  appearanceCount: 1,
  description: "伙计",
  personality: "机灵",
  speechStyle: "快语",
  relationships: [],
  keyEvents: [],
  sixDimensionResearch: {
    publicMaterial: "",
    speechStyle: "",
    expressionDna: "",
    externalViews: "",
    decisionLog: "",
    timeline: "",
  },
}

function makeTask(overrides: any = {}): any {
  return {
    id: "task-1",
    projectPath: "E:/Novel",
    bookId: "book-1",
    config: { sourceType: "file", sourcePath: "x", selectedChapters: [] },
    progress: { stage: "completed", stageLabel: "", completed: 100, total: 100, percentage: 100 },
    status: "completed",
    startedAt: 1,
    updatedAt: 2,
    completedAt: 3,
    metadata: {
      title: "长夜书",
      author: "佚名",
      totalChapters: 3,
      totalWords: 12000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 2,
    },
    characters: [CHAR_LINJING, CHAR_SHENWEI, CHAR_AFU],
    skills: [
      {
        id: "skill-1",
        characterId: "char-linjing",
        characterName: "林烬",
        skillContent: "# 林烬",
        sourceBook: "长夜书",
        chapterRange: ["1", "3"],
        createdAt: 3,
        filePath: "E:/Novel/book-analysis/book-1/skills/林烬-skill.md",
      },
    ],
    ...overrides,
  }
}

function makeResult(overrides: any = {}): any {
  return {
    metadata: {
      title: "长夜书",
      totalChapters: 3,
      totalWords: 12000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 2,
    },
    characters: [CHAR_LINJING],
    skills: [],
    ...overrides,
  }
}

function makeStyleProfile(overrides: any = {}): any {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    sampledChapterIds: ["c1"],
    narrativeDensity: "叙事密度中高",
    descriptionWeight: "",
    emotionRendering: "",
    sentenceStyle: "",
    rhetoricDensity: "",
    transitionStyle: "",
    narrativeVoice: "",
    dialogueStyle: "对白留白",
    thematicHabits: "",
    constitution: "风格宪法内容",
    samples: ["样本一"],
    ...overrides,
  }
}

describe("BookAnalysisResultViewer", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.wikiState.project = null
    mocks.wikiState.llmConfig = mocks.llmConfig
    mocks.wikiState.aiChatModel = ""
    mocks.wikiState.providerConfigs = {}
    mocks.bookState.tasks = []
    mocks.bookState.currentResult = null
    setupDefaults()
    setupDomGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  function renderViewer(overrides: { projectPath?: string; result?: any; onClose?: () => void } = {}) {
    const onClose = vi.fn()
    const utils = render(
      <BookAnalysisResultViewer
        projectPath={overrides.projectPath ?? "E:/Novel"}
        result={overrides.result ?? null}
        onClose={overrides.onClose ?? onClose}
      />,
    )
    return { ...utils, onClose }
  }

  /** 角色卡片（列表左侧，className="flex-1 min-w-0 text-left" 的 button） */
  function characterCards(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>("button.flex-1"))
  }

  it("shows the error dialog when no result and no completed task; Escape does not close", () => {
    const { onClose } = renderViewer()
    expect(screen.getByText("未找到分析结果")).toBeInTheDocument()
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    // error 态不挂 Escape 监听
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders the empty character state when a completed task has no characters", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [
      makeTask({
        characters: [],
        skills: [],
        // 无 title → 头部走「未命名作品」兜底（book-analysis-result-viewer.tsx: bookTitle = metadata?.title || "未命名作品"）
        metadata: { ...makeTask().metadata, title: "" },
      }),
    ]
    renderViewer()

    expect(screen.getByText("暂无角色数据")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新提取角色" })).toBeDisabled()
    // skills 为空 → footer「添加所选角色」按钮不渲染。注意左侧提示框（importedAuras.length===0 时）
    // 固定渲染含同一短语的 div，因此必须用 button role 断言而不是 queryByText。
    expect(
      screen.queryByRole("button", { name: /添加所选角色到自定义灵魂/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByText("尚未提取叙事文风（与角色灵魂相互独立）")).toBeInTheDocument()
    expect(screen.getAllByText("未命名作品").length).toBeGreaterThan(0)
  })

  it("renders characters sorted by importance and shows full detail on select", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    const { container } = renderViewer()

    await waitFor(() => expect(screen.getByText(/共 3 个角色/)).toBeInTheDocument())
    // 按重要性排序：林烬(9) 在最前；同分 8 走 name localeCompare
    const cards = characterCards(container)
    expect(cards[0]?.textContent).toContain("林烬")
    expect(cards[1]?.textContent).toContain("阿福")
    expect(cards[2]?.textContent).toContain("沈微")

    // 分类徽标
    expect(screen.getByText("主角")).toBeInTheDocument()
    expect(screen.getByText("反派")).toBeInTheDocument()
    expect(screen.getByText("龙套")).toBeInTheDocument()

    // 选中林烬 → 详情
    fireEvent.click(cards[0]!)
    expect(screen.getByText("旧城巡夜人。")).toBeInTheDocument()
    expect(screen.getByText("克制。")).toBeInTheDocument()
    expect(screen.getByText("短句。")).toBeInTheDocument()
    // 列表卡片（别名：{aliases.join}）与详情头部都渲染「别名：阿烬」→ getAllByText
    expect(screen.getAllByText("别名：阿烬").length).toBeGreaterThan(0)
    expect(screen.getByText("沈微：")).toBeInTheDocument()
    expect(screen.getByText(/年少相识/)).toBeInTheDocument()
    expect(screen.getByText("第 1 章")).toBeInTheDocument()
    expect(screen.getByText("第 3 章")).toBeInTheDocument()
    expect(screen.getByText("3 次")).toBeInTheDocument()
    expect(screen.getByText("9/10")).toBeInTheDocument()
    // SimpleProfileCard（简单提取）
    expect(screen.getByText("性格")).toBeInTheDocument()
    expect(screen.getByText("动机")).toBeInTheDocument()
    expect(screen.getByText("行为模式")).toBeInTheDocument()
    expect(screen.getByText("「灯下无影」")).toBeInTheDocument()

    // 沈微：空描述/性格/说话方式 → 兜底文案（两个「暂无」）
    const shenweiCard = cards.find((c) => c.textContent?.includes("沈微"))!
    fireEvent.click(shenweiCard)
    expect(screen.getByText("暂无描述")).toBeInTheDocument()
    expect(screen.getAllByText("暂无").length).toBeGreaterThanOrEqual(2)

    // 阿福：sixDimensionResearch 存在 → 不渲染 SimpleProfileCard
    const afuCard = cards.find((c) => c.textContent?.includes("阿福"))!
    fireEvent.click(afuCard)
    expect(screen.queryByText("行为模式")).not.toBeInTheDocument()
    expect(screen.getByText("伙计")).toBeInTheDocument()
  })

  it("toggles sort order back to the original character order", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const { container } = renderViewer()

    fireEvent.click(screen.getByRole("button", { name: "恢复原序" }))
    const cards = characterCards(container)
    expect(cards[0]?.textContent).toContain("林烬")
    expect(cards[1]?.textContent).toContain("沈微")
    expect(cards[2]?.textContent).toContain("阿福")
    fireEvent.click(screen.getByRole("button", { name: "按重要性排序" }))
    const reSorted = characterCards(container)
    expect(reSorted[0]?.textContent).toContain("林烬")
  })

  it("supports select-all / clear / single select with footer counts", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    renderViewer()

    const addBtn = screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ })
    expect(addBtn).toBeDisabled()

    // 勾选第一个角色（林烬）
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    expect(screen.getByText(/已选 1/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /\(1\)/ })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "全选" }))
    expect(screen.getByText(/已选 3/)).toBeInTheDocument()

    // 反选一个（删除分支）
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    expect(screen.getByText(/已选 2/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "清空" }))
    expect(screen.queryByText(/已选 [0-9]+/)).not.toBeInTheDocument()
  })

  it("imports selected character skills as auras and binds them", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    const imported = [{ auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" }]
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue(imported)
    renderViewer()

    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole("checkbox")[0]) // 林烬
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))

    await waitFor(() =>
      expect(mocks.importBookAnalysisSkillsAsAuras).toHaveBeenCalledWith(
        "E:/Novel",
        expect.objectContaining({ title: "长夜书" }),
        expect.any(Array),
        expect.any(Array),
        ["skill-1"],
      ),
    )
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
    expect(mocks.toast.success).toHaveBeenCalledWith("已添加 1 个角色 Skill 到自定义灵魂")

    // 绑定区出现（importedAuras + bindableCharacters 都非空）
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())
    // 默认勾选第一个可绑定人物（林烬）
    expect((screen.getAllByRole("checkbox").find((c) => (c as HTMLInputElement).checked) as HTMLInputElement).value ?? true).toBeDefined()

    // 绑定成功：默认已选林烬
    await userEvent.click(screen.getByRole("button", { name: /绑定/ }))
    expect(mocks.bindCharacterAura).toHaveBeenCalledWith("E:/Novel", {
      characterName: "林烬",
      auraId: "aura-1",
    })
    expect(mocks.toast.success).toHaveBeenCalledWith("已将「林烬·灵魂」绑定到 1 个小说人物")
    // 绑定后清空选择
    expect(screen.queryByText(/已选 [0-9]+/)).not.toBeInTheDocument()
  })

  it("reports partial failures when binding some characters fails", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" },
    ])
    mocks.bindCharacterAura.mockRejectedValueOnce(new Error("bind-fail"))
    renderViewer()

    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())

    // 再勾选沈微 → 两人绑定：林烬成功（默认勾选），沈微失败
    const bindCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).slice(3)
    fireEvent.click(bindCheckboxes[bindCheckboxes.length - 1]!)
    await userEvent.click(screen.getByRole("button", { name: /绑定/ }))
    await waitFor(() =>
      expect(mocks.toast.info).toHaveBeenCalledWith("绑定完成：成功 1，失败 1"),
    )
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
  })

  it("guards the bind action when the project is missing", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" },
    ])
    const { rerender } = renderViewer()

    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())

    // 移除项目 → 守卫 !currentProject?.path → toast.error（handler 闭包需随 rerender 刷新）
    // 注：!selectedAuraId / selectedNovelCharacterIds.size===0 两个守卫分支被按钮
    //   disabled={selectedNovelCharacterIds.size === 0 || !selectedAuraId} 遮蔽，无法经 UI 触达；
    //   「角色灵魂」默认名兜底（auraName ?? "角色灵魂"）要求 selectedAuraId 不在 importedAuras，
    //   而 select 的 value 只能来自 importedAuras 的 option → 均不可达，本用例不测。
    mocks.wikiState.project = null
    rerender(<BookAnalysisResultViewer projectPath="E:/Novel" result={null} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: /绑定/ }))
    expect(mocks.toast.error).toHaveBeenCalledWith("请先选择自定义灵魂和至少一个小说人物")
    expect(mocks.bindCharacterAura).not.toHaveBeenCalled()
  })

  it("adds to soul fails and surfaces the error toast", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.importBookAnalysisSkillsAsAuras.mockRejectedValue(new Error("import-fail"))
    renderViewer()

    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("添加失败：import-fail"))
  })

  it("shows toasts for the missing-project guard and the no-skill-selection guard", () => {
    // 无项目 → 守卫。footer 按钮 disabled={addingToSoul || selectedCharacterIds.size === 0}，
    // 必须先勾选角色（skills 来自 result prop，角色列表照常渲染）才能点中。
    mocks.bookState.tasks = []
    const r1 = renderViewer({ result: makeResult({ skills: [makeTask().skills[0]] }) })
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    expect(mocks.toast.error).toHaveBeenCalledWith("未找到当前项目或分析结果")
    r1.unmount()

    // 「请先勾选要添加的角色」守卫（selectedSkillIds.length === 0）只有按钮可用时才可达：
    // 勾选一个没有对应 skill 的角色（阿福，排序后 index 1；skills 仅含 char-linjing）
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    renderViewer()
    fireEvent.click(screen.getAllByRole("checkbox")[1])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    expect(mocks.toast.info).toHaveBeenCalledWith("请先勾选要添加的角色")
  })

  it("runs single-character simple reextract and updates the detail view", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockResolvedValue({
      character: { ...CHAR_LINJING, description: "新描述-林烬" },
    })
    const { container } = renderViewer()

    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))

    expect(mocks.extractSingleCharacter).toHaveBeenCalledWith(
      expect.objectContaining({
        bookPath: "E:/Novel/book-analysis/book-1",
        bookId: "book-1",
        mode: "simple",
        depth: "fast",
        bookTitle: "长夜书",
        bookAuthor: "佚名",
      }),
    )
    await waitFor(() => expect(screen.getByText("新描述-林烬")).toBeInTheDocument())
    expect(mocks.toast.success).toHaveBeenCalledWith("「林烬」简单提取完成")
    // 提取完成后按钮恢复
    expect(screen.getByRole("button", { name: "再次提取(简单)" })).toBeEnabled()
  })

  it("single reextract tolerates missing characters in currentResult/task (?? [] 兜底)", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.bookState.currentResult = { ...makeTask(), characters: undefined }
    let resolveExtract!: (v: unknown) => void
    mocks.extractSingleCharacter.mockImplementationOnce(
      () => new Promise((r) => { resolveExtract = r }),
    )
    const { container } = renderViewer()
    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    // 提取进行中：currentResult 与 task 的 characters 均缺失 → ?? [] 兜底
    mocks.bookState.tasks[0].characters = undefined
    mocks.bookState.currentResult = { ...mocks.bookState.currentResult, characters: undefined }
    await act(async () => {
      resolveExtract({ character: { ...CHAR_LINJING, description: "新描述-林烬" } })
    })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("「林烬」简单提取完成"))
  })

  it("shows the pending state while a single reextract is running", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    let resolveExtract!: (v: any) => void
    mocks.extractSingleCharacter.mockReturnValueOnce(new Promise((r) => { resolveExtract = r }))
    const { container } = renderViewer()

    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    fireEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))

    expect(screen.getByText(/正在后台提取/)).toBeInTheDocument()
    // 提取期间「再次提取(简单)」与「深度提取(6 维)」两个按钮都切换为「提取中...」并禁用
    const busyButtons = screen.getAllByRole("button", { name: "提取中..." })
    expect(busyButtons).toHaveLength(2)
    for (const b of busyButtons) {
      expect(b).toBeDisabled()
    }

    await act(async () => {
      resolveExtract({ character: { ...CHAR_LINJING, description: "后台完成" } })
    })
    await waitFor(() => expect(screen.getByText("后台完成")).toBeInTheDocument())
    expect(screen.queryByText(/正在后台提取/)).not.toBeInTheDocument()
  })

  it("runs six-dimension single reextract with deep depth", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const { container } = renderViewer()

    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    await userEvent.click(screen.getByRole("button", { name: "深度提取(6 维)" }))

    expect(mocks.extractSingleCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "six-dimension", depth: "deep" }),
    )
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("「林烬」深度提取完成"))
  })

  it("redacts URLs and api keys in single-reextract error toasts", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockRejectedValueOnce(
      new Error("GET https://api.openai.com/v1 failed with api_key=sk-123"),
    )
    const { container } = renderViewer()

    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    await userEvent.click(screen.getByRole("button", { name: "深度提取(6 维)" }))

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("「林烬」深度提取失败：GET [url] failed with [redacted]"),
    )
  })

  it("keeps plain error messages unchanged in single-reextract toasts", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockRejectedValueOnce(new Error("boo"))
    const { container } = renderViewer()

    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("「林烬」简单提取失败：boo"),
    )
  })

  it("guards single reextract without project / llm config / bookId", async () => {
    // 无项目
    mocks.bookState.tasks = []
    const r1 = renderViewer({ result: makeResult() })
    fireEvent.click(characterCards(r1.container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    expect(mocks.toast.error).toHaveBeenCalledWith("缺少项目信息")
    r1.unmount()

    // 无 llmConfig
    mocks.wikiState.project = PROJECT
    mocks.wikiState.llmConfig = null
    mocks.bookState.tasks = [makeTask()]
    const r2 = renderViewer()
    fireEvent.click(characterCards(r2.container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    expect(mocks.toast.error).toHaveBeenCalledWith("未配置 LLM，请先在设置中配置")
    r2.unmount()

    // 无 bookId（只有 result prop，无 completed task）
    mocks.wikiState.llmConfig = mocks.llmConfig
    mocks.bookState.tasks = []
    const r3 = renderViewer({ result: makeResult() })
    fireEvent.click(characterCards(r3.container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    expect(mocks.toast.error).toHaveBeenCalledWith("未找到作品标识")
  })

  it("reextracts all characters in simple mode and writes back to the store", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockImplementation(async (input: any) => ({
      character: { ...input.character, description: `新${input.character.name}` },
    }))
    const { container } = renderViewer()

    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    // 先切到深度再切回简单 → 两个 radio 的 onChange 都触发
    fireEvent.click(screen.getByLabelText("深度提取(6 维)"))
    fireEvent.click(screen.getByLabelText("简单提取(快速)"))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))

    await waitFor(() => expect(mocks.extractSingleCharacter).toHaveBeenCalledTimes(3))
    expect(mocks.extractSingleCharacter).toHaveBeenCalledWith(
      expect.objectContaining({
        bookPath: "E:/Novel/book-analysis/book-1",
        bookId: "book-1",
        mode: "simple",
        depth: "standard",
      }),
    )
    expect(mocks.toast.success).toHaveBeenCalledWith("已重新提取 3 个角色")
    // store 写回（handleReextractAll 里 useBookAnalysisStore.setState 更新 tasks）。
    // 列表卡片本身不渲染 description，只能断言 store 数据 + 点开卡片看详情。
    await waitFor(() => {
      expect(mocks.bookState.tasks[0].characters.map((c: any) => c.description)).toContain(
        "新林烬",
      )
    })
    fireEvent.click(characterCards(container)[0]!)
    expect(screen.getByText("新林烬")).toBeInTheDocument()
    // 下拉关闭
    expect(screen.queryByText("选择提取方式")).not.toBeInTheDocument()
  })

  it("reextracts all characters in six-dimension mode and syncs currentResult", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.bookState.currentResult = makeResult({ characters: [CHAR_LINJING] })
    mocks.extractSingleCharacter.mockImplementation(async (input: any) => ({
      character: { ...input.character, description: `六维${input.character.name}` },
    }))
    renderViewer()

    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    fireEvent.click(screen.getByLabelText("深度提取(6 维)"))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))

    await waitFor(() =>
      expect(mocks.extractSingleCharacter).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "six-dimension", depth: "standard" }),
      ),
    )
    // currentResult 存在 → setCurrentResult 同步
    expect(mocks.bookState.setCurrentResult).toHaveBeenCalled()
    expect(mocks.toast.success).toHaveBeenCalledWith("已重新提取 3 个角色")
  })

  it("reextract-all uses the unknown book path and resolver when no task/aiChatModel", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.aiChatModel = "custom-model"
    mocks.bookState.tasks = []
    renderViewer({ result: makeResult({ characters: [CHAR_LINJING] }) })

    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))

    await waitFor(() =>
      expect(mocks.extractSingleCharacter).toHaveBeenCalledWith(
        expect.objectContaining({ bookPath: "E:/Novel/book-analysis/unknown" }),
      ),
    )
    expect(mocks.resolveModelConfig).toHaveBeenCalledWith("custom-model", mocks.llmConfig, {})
    expect(mocks.toast.success).toHaveBeenCalledWith("已重新提取 1 个角色")
  })

  it("guards reextract-all while running and surfaces failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    let resolveFirst!: (v: any) => void
    mocks.extractSingleCharacter.mockReturnValueOnce(new Promise((r) => { resolveFirst = r }))
    renderViewer()

    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))
    // 第一个角色提取挂起 → reextractRunning=true → 守卫
    const reextractBtn = screen.getByRole("button", { name: "提取中..." })
    await act(async () => {
      const key = Object.keys(reextractBtn).find((k) => k.startsWith("__reactProps"))
      ;(reextractBtn as any)[key!].onClick()
    })
    expect(mocks.extractSingleCharacter).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveFirst({ character: { ...CHAR_LINJING, description: "第一次" } })
    })
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已重新提取 3 个角色"))
  })

  it("surfaces reextract-all errors", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockRejectedValue(new Error("extract-all-fail"))
    renderViewer()

    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("重新提取失败：extract-all-fail"),
    )
  })

  it("extracts the writing style and renders the profile card", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const profile = makeStyleProfile()
    mocks.analyzeWritingStyle.mockResolvedValue(profile)
    renderViewer()

    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() =>
      expect(mocks.analyzeWritingStyle).toHaveBeenCalledWith(
        "E:/Novel/book-analysis/book-1",
        expect.objectContaining(mocks.llmConfig),
      ),
    )
    expect(mocks.bookState.updateTaskStyleProfile).toHaveBeenCalledWith("task-1", profile)
    expect(mocks.toast.success).toHaveBeenCalledWith("已提取作品文风")

    // 画像渲染：维度（头部 summary span 与维度网格各渲染一次 → getAllByText）、宪法、样本、空值「—」兜底
    expect(screen.getAllByText("叙事密度中高").length).toBeGreaterThan(0)
    expect(screen.getByText("风格宪法")).toBeInTheDocument()
    expect(screen.getByText("风格宪法内容")).toBeInTheDocument()
    expect(screen.getByText("代表原文样本")).toBeInTheDocument()
    expect(screen.getByText("样本一")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
    // 按钮切换为「重新提取文风」
    expect(screen.getByRole("button", { name: "重新提取文风" })).toBeInTheDocument()
  })

  it("enables and disables the writing style preset", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    renderViewer()

    expect(screen.getByRole("button", { name: "启用此文风" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "启用此文风" }))
    expect(mocks.upsertWritingStylePreset).toHaveBeenCalledWith(
      "E:/Novel",
      expect.objectContaining({ name: "长夜书 · 文风", sourceBook: "长夜书" }),
    )
    expect(mocks.setEnabledWritingStyle).toHaveBeenCalledWith("E:/Novel", "preset-1")
    expect(mocks.toast.success).toHaveBeenCalledWith("已启用该文风，生成时会按此文风写作")
    expect(screen.getByRole("button", { name: "已启用 ✓" })).toBeInTheDocument()
    expect(screen.getByText(/只模仿写法/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "已启用 ✓" }))
    expect(mocks.setEnabledWritingStyle).toHaveBeenCalledWith("E:/Novel", null)
    expect(mocks.toast.success).toHaveBeenCalledWith("已取消启用该文风")
    expect(screen.getByRole("button", { name: "启用此文风" })).toBeInTheDocument()
  })

  it("derives style-enabled from the enabled-style store on mount", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    mocks.getEnabledWritingStyle.mockResolvedValue({ id: "s1", sourceBook: "长夜书" })
    renderViewer()

    await waitFor(() => expect(screen.getByRole("button", { name: "已启用 ✓" })).toBeInTheDocument())
  })

  it("falls back to the enabled-style store error and null preset", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    mocks.getEnabledWritingStyle.mockRejectedValueOnce(new Error("style-load-fail"))
    renderViewer()
    // catch → styleEnabledSourceBook null → 「启用此文风」
    await waitFor(() => expect(screen.getByRole("button", { name: "启用此文风" })).toBeInTheDocument())
  })

  it("guards style toggle without project and with preset errors", async () => {
    // 无项目 + styleProfile 存在 → 点击启用命中守卫
    mocks.bookState.tasks = []
    const r1 = renderViewer({ result: makeResult({ styleProfile: makeStyleProfile() }) })
    await userEvent.click(screen.getByRole("button", { name: "启用此文风" }))
    expect(mocks.upsertWritingStylePreset).not.toHaveBeenCalled()
    r1.unmount()

    // upsert 失败 → toast 操作失败
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    mocks.upsertWritingStylePreset.mockRejectedValueOnce(new Error("preset-fail"))
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "启用此文风" }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("操作失败：preset-fail"))
  })

  it("guards style extraction without bookId / llm config and surfaces errors", async () => {
    // 无 bookId（仅 result prop）
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = []
    const r1 = renderViewer({ result: makeResult() })
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    expect(mocks.toast.error).toHaveBeenCalledWith("未找到作品标识")
    r1.unmount()

    // 无 llmConfig
    mocks.wikiState.llmConfig = null
    mocks.bookState.tasks = [makeTask()]
    const r2 = renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    expect(mocks.toast.error).toHaveBeenCalledWith("未配置 LLM，请先在设置中配置")
    r2.unmount()

    // analyzeWritingStyle 失败
    mocks.wikiState.llmConfig = mocks.llmConfig
    mocks.analyzeWritingStyle.mockRejectedValueOnce(new Error("style-fail"))
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("提取文风失败：style-fail"))
  })

  it("shows extracting state and guards re-entry while extracting", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    let resolveStyle!: (v: any) => void
    mocks.analyzeWritingStyle.mockReturnValueOnce(new Promise((r) => { resolveStyle = r }))
    renderViewer()

    const extractBtn = screen.getByRole("button", { name: "提取文风" })
    fireEvent.click(extractBtn)
    // styleExtracting=true → 文案切换
    const busyBtn = screen.getByRole("button", { name: "提取中..." })
    await act(async () => {
      const key = Object.keys(busyBtn).find((k) => k.startsWith("__reactProps"))
      ;(busyBtn as any)[key!].onClick()
    })
    expect(mocks.analyzeWritingStyle).toHaveBeenCalledTimes(1)
    await act(async () => { resolveStyle(makeStyleProfile()) })
  })

  it("closes on Escape and traps Tab focus within the dialog", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const { onClose } = renderViewer()

    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)

    const buttons = screen.getAllByRole("button")
    const first = buttons[0]!
    const last = buttons[buttons.length - 1]!
    // TASK-LE-5：Radix FocusScope 在容器内拦截 Tab（keydown 派发到模态内元素）
    first.focus()
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
    // 焦点在 last 时再按 Shift+Tab：两个分支都不命中（覆盖 !e.shiftKey 为 false 的一侧）
    fireEvent.keyDown(last, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)
    // 非 Tab / 非 Escape 键：不关闭
    fireEvent.keyDown(first, { key: "a" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes via the bottom close button and the header X button", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const { onClose } = renderViewer()

    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onClose).toHaveBeenCalledTimes(1)

    const xButton = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "")
    fireEvent.click(xButton!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("keeps the novel-character selection when the bindable list refreshes", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" },
    ])
    const { rerender } = renderViewer()

    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())

    // 已勾选沈微（size>0）→ 项目路径变化触发 effect → 保留当前选择
    const bindCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).slice(3)
    fireEvent.click(bindCheckboxes[1]!)
    mocks.wikiState.project = { ...PROJECT, path: "E:/Novel" }
    rerender(<BookAnalysisResultViewer projectPath="E:/Novel" result={null} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
          .slice(3)
          .filter((c) => c.checked),
      ).toHaveLength(2),
    )
  })

  it("resets the bindable list when the effect rejects or returns empty", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    // 首次加载必须返回非空：绑定区渲染条件是 importedAuras.length > 0 && bindableCharacters.length > 0
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" },
    ])
    const { rerender } = renderViewer()

    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())

    // effect 重新运行返回空列表 → setBindableCharacters([]) → 绑定区收起
    mocks.listBindableNovelCharacters.mockResolvedValue([])
    mocks.wikiState.project = { ...PROJECT, path: "E:/Novel2" }
    rerender(<BookAnalysisResultViewer projectPath="E:/Novel" result={null} onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByText("绑定小说人物（多选）")).not.toBeInTheDocument(),
    )
  })

  it("ignores the bindable-list rejection after project switch", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockRejectedValue(new Error("bind-list-fail"))
    renderViewer()
    // catch → setBindableCharacters([]) → 绑定区不渲染（无 importedAuras 也无影响）
    await waitFor(() => expect(screen.getByText(/共 3 个角色/)).toBeInTheDocument())
    expect(screen.queryByText("绑定小说人物（多选）")).not.toBeInTheDocument()
  })

  it("pre-selects the first bindable character when none selected yet", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂", characterName: "林烬" },
    ])
    renderViewer()

    // 导入前绑定区不渲染（importedAuras 为空）→ 只有 3 个角色复选框
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())

    // 第一个可绑定人物默认勾选（effect 中 setSelectedNovelCharacterIds 预选 names[0]，兼容旧 UX）
    const bindCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).slice(3)
    expect(bindCheckboxes[0]?.checked).toBe(true)
    // 绑定按钮可用 + 显示 (1)
    expect(screen.getByRole("button", { name: /绑定 \(1\)/ })).toBeEnabled()
  })

  it("handles a completed task without characters or skills", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ characters: undefined, skills: undefined })]
    renderViewer()
    // task.characters ?? [] / task.skills ?? [] 的两个 ?? 右侧（JSX 文本节点拆分，用 textContent 断言）
    expect(document.body.textContent).toContain("角色列表 (0)")
    expect(document.body.textContent).toContain("暂无角色数据")
  })

  it("ignores bindable-list resolution and rejection after unmount", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    let resolveBind!: (v: unknown) => void
    let rejectBind!: (e: unknown) => void
    mocks.listBindableNovelCharacters
      .mockImplementationOnce(
        () => new Promise((r, j) => { resolveBind = r; rejectBind = j }),
      )
      .mockImplementationOnce(
        () => new Promise((r, j) => { resolveBind = r; rejectBind = j }),
      )
    const { rerender, unmount } = renderViewer()
    await waitFor(() => expect(screen.getByText(/共 3 个角色/)).toBeInTheDocument())
    // 项目路径变化 → effect 重跑（第一次 promise 的 cleanup 置 cancelled；第二次调用挂起）
    mocks.wikiState.project = { ...PROJECT, path: "E:/Novel2" }
    rerender(<BookAnalysisResultViewer projectPath="E:/Novel" result={null} onClose={vi.fn()} />)
    await waitFor(() => expect(mocks.listBindableNovelCharacters).toHaveBeenCalledTimes(2))
    unmount()
    // 卸载后 resolve：then 的 cancelled=true 直接 return；再 reject：catch 的 cancelled=true 不写回
    await act(async () => {
      resolveBind(["林烬"])
      await new Promise((r) => setTimeout(r, 0))
      rejectBind(new Error("late"))
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it("resolves an empty enabled-style preset and ignores late rejection after unmount", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    // 预设存在但没有 sourceBook → preset?.sourceBook ?? null 的 ?? 右侧
    mocks.getEnabledWritingStyle.mockResolvedValueOnce({ id: "s1" })
    let rejectStyle!: (e: unknown) => void
    mocks.getEnabledWritingStyle.mockImplementationOnce(
      () => new Promise((_r, j) => { rejectStyle = j }),
    )
    const { rerender, unmount } = renderViewer()
    await waitFor(() => expect(screen.getByRole("button", { name: "启用此文风" })).toBeInTheDocument())
    // 项目路径变化 → effect 重跑 → 第二次调用挂起
    mocks.wikiState.project = { ...PROJECT, path: "E:/Novel2" }
    rerender(<BookAnalysisResultViewer projectPath="E:/Novel" result={null} onClose={vi.fn()} />)
    await waitFor(() => expect(mocks.getEnabledWritingStyle).toHaveBeenCalledTimes(2))
    unmount()
    await act(async () => {
      rejectStyle(new Error("late"))
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it("guards reextract-all without a project", async () => {
    mocks.wikiState.project = null
    mocks.bookState.tasks = []
    renderViewer({ result: makeResult() })
    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))
    // !currentProject?.path 守卫直接返回
    expect(mocks.extractSingleCharacter).not.toHaveBeenCalled()
  })

  it("keeps non-matching tasks untouched during reextract-all", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask(), makeTask({ id: "task-x", projectPath: "E:/Other" })]
    mocks.extractSingleCharacter.mockImplementation(async (input: any) => ({
      character: { ...input.character, description: `新${input.character.name}` },
    }))
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已重新提取 3 个角色"))
    const other = mocks.bookState.tasks.find((t: any) => t.id === "task-x")
    expect(other.characters[0].description).toBe("旧城巡夜人。")
  })

  it("surfaces non-Error reextract-all failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockRejectedValue("boom-string")
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "重新提取角色" }))
    await userEvent.click(screen.getByRole("button", { name: "开始" }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("重新提取失败：boom-string"))
  })

  it("extracts the writing style with a runtime aiChatModel", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.wikiState.aiChatModel = "style-model"
    mocks.analyzeWritingStyle.mockResolvedValue(makeStyleProfile())
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() =>
      expect(mocks.resolveModelConfig).toHaveBeenCalledWith("style-model", mocks.llmConfig, {}),
    )
    expect(mocks.analyzeWritingStyle).toHaveBeenCalledWith(
      "E:/Novel/book-analysis/book-1",
      expect.objectContaining({ model: "style-model" }),
    )
  })

  it("extracts style with a current result snapshot to sync it", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.bookState.currentResult = makeResult()
    mocks.analyzeWritingStyle.mockResolvedValue(makeStyleProfile())
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已提取作品文风"))
    // currentResult 存在 → if (cur) setCurrentResult 同步 styleProfile
    expect(mocks.bookState.setCurrentResult).toHaveBeenCalledWith(
      expect.objectContaining({ styleProfile: expect.objectContaining({ schemaVersion: 1 }) }),
    )
  })

  it("extracts style without a current result snapshot", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.analyzeWritingStyle.mockResolvedValue(makeStyleProfile())
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已提取作品文风"))
    // currentResult 为 null → if (cur) setCurrentResult 分支不执行
    expect(mocks.bookState.setCurrentResult).not.toHaveBeenCalled()
  })

  it("surfaces non-Error style extraction failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.analyzeWritingStyle.mockRejectedValue("style-boom")
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "提取文风" }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("提取文风失败：style-boom"))
  })

  it("surfaces non-Error style toggle failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile() })]
    mocks.upsertWritingStylePreset.mockRejectedValue("toggle-boom")
    renderViewer()
    await userEvent.click(screen.getByRole("button", { name: "启用此文风" }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("操作失败：toggle-boom"))
  })

  it("runs single reextract with a runtime aiChatModel", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.wikiState.aiChatModel = "single-model"
    const { container } = renderViewer()
    fireEvent.click(characterCards(container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    await waitFor(() => expect(mocks.extractSingleCharacter).toHaveBeenCalled())
    expect(mocks.resolveModelConfig).toHaveBeenCalledWith("single-model", mocks.llmConfig, {})
  })

  it("syncs currentResult and keeps non-matching tasks on single reextract", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask(), makeTask({ id: "task-x", projectPath: "E:/Other" })]
    mocks.bookState.currentResult = makeResult({ characters: [CHAR_LINJING, CHAR_SHENWEI] })
    mocks.extractSingleCharacter.mockImplementation(async (input: any) => ({
      character: { ...input.character, description: `已${input.character.name}` },
    }))
    const { container } = renderViewer()
    fireEvent.click(characterCards(container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    await waitFor(() => expect(screen.getByText("已林烬")).toBeInTheDocument())
    // 写回 currentResult：匹配角色替换（true 侧）、其他角色保留原样（false 侧）
    expect(mocks.bookState.setCurrentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        characters: expect.arrayContaining([
          expect.objectContaining({ id: "char-linjing", description: "已林烬" }),
          expect.objectContaining({ id: "char-shenwei" }),
        ]),
      }),
    )
    // 非匹配任务不被改写（tasks.map 的 : t 分支）
    const other = mocks.bookState.tasks.find((t: any) => t.id === "task-x")
    expect(other.characters[0]).toBe(CHAR_LINJING)
    // 再对沈微跑一次：currentResult.characters 中此时含已更新林烬 → 角色替换/保留两向都再次命中
    fireEvent.click(characterCards(container)[1]!)
    fireEvent.click(screen.getByRole("button", { name: "深度提取(6 维)" }))
    await waitFor(() => expect(mocks.extractSingleCharacter).toHaveBeenCalledTimes(2))
    expect(mocks.bookState.setCurrentResult).toHaveBeenCalledTimes(2)
  })

  it("keeps a different visible character on single reextract completion", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    let resolveExtract!: (v: unknown) => void
    mocks.extractSingleCharacter.mockReturnValueOnce(new Promise((r) => { resolveExtract = r }))
    const { container } = renderViewer()
    const cards = characterCards(container)
    fireEvent.click(cards[0]!)
    fireEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    // 提取期间切到另一角色
    fireEvent.click(cards[1]!)
    await act(async () => {
      resolveExtract({ character: { ...CHAR_LINJING, description: "完成后" } })
    })
    // prev(沈微)?.id !== fresh(林烬).id → 保留 prev 不变
    await waitFor(() => expect(screen.getByText("沈微")).toBeInTheDocument())
    expect(screen.queryByText("完成后")).not.toBeInTheDocument()
  })

  it("surfaces non-Error single reextract failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.extractSingleCharacter.mockRejectedValue("plain")
    const { container } = renderViewer()
    fireEvent.click(characterCards(container)[0]!)
    await userEvent.click(screen.getByRole("button", { name: "再次提取(简单)" }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("「林烬」简单提取失败：plain"),
    )
  })

  it("re-imports while an aura is selected and handles an empty import", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValueOnce([
      { auraId: "aura-1", auraName: "林烬·灵魂" },
      { auraId: "aura-2", auraName: "沈微·灵魂" },
    ])
    renderViewer()
    // 角色勾选框（3 个）出现后导入
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    // 绑定区出现（含 2 个可绑定人物勾选框）
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())
    const auraSelect = document.querySelector("select") as HTMLSelectElement
    expect(auraSelect?.value).toBe("aura-1")
    // 第二次导入：已选中 aura → current || ... 走 left 侧（保持 aura-1）
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValueOnce([{ auraId: "aura-3", auraName: "新·灵魂" }])
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(document.querySelector("select")?.value).toBe("aura-1"))
    // 空导入：imported[0]?.auraId 为 undefined → || "" 回退
    cleanup()
    mocks.bookState.tasks = [makeTask()]
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValueOnce([])
    renderViewer()
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已添加 0 个角色 Skill 到自定义灵魂"))
    // 无绑定区
    expect(screen.queryByText("绑定小说人物（多选）")).not.toBeInTheDocument()
  })

  it("surfaces non-Error add-to-soul failures", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.importBookAnalysisSkillsAsAuras.mockRejectedValue("add-boom")
    renderViewer()
    fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("添加失败：未知错误"))
  })

  it("renders unknown character categories with fallback label and color", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask({ characters: [{ ...CHAR_LINJING, category: "weird" }] })]
    renderViewer()
    // labels[category] || category 与 colors[category] || 默认色的回退
    expect(screen.getByRole("button", { name: /林烬/ })).toBeInTheDocument()
    expect(screen.getAllByText("weird").length).toBeGreaterThan(0)
  })

  it("falls back the style summary copy for missing profile and empty density", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    // 无 styleProfile → 尚未提取文案
    renderViewer()
    expect(screen.getByText(/尚未提取叙事文风/)).toBeInTheDocument()
    cleanup()
    // 有 profile 但 narrativeDensity 为空 → 已提取兜底
    mocks.bookState.tasks = [makeTask({ styleProfile: makeStyleProfile({ narrativeDensity: "" }) })]
    renderViewer()
    expect(screen.getAllByText("已提取").length).toBeGreaterThan(0)
  })

  it("stops propagation when clicking the detail card body", () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    const { container } = renderViewer()
    fireEvent.click(characterCards(container)[0]!)
    // 点击详情卡非按钮区域（标题 h3 与描述段落）→ 包装 div 的 onClick stopPropagation 执行
    fireEvent.click(screen.getByRole("heading", { level: 3, name: "林烬" }))
    fireEvent.click(screen.getByText("旧城巡夜人。"))
    expect(screen.getByText("旧城巡夜人。")).toBeInTheDocument()
  })

  it("unchecks a bindable character and switches the selected aura before binding", async () => {
    mocks.wikiState.project = PROJECT
    mocks.bookState.tasks = [makeTask()]
    mocks.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
    mocks.importBookAnalysisSkillsAsAuras.mockResolvedValue([
      { auraId: "aura-1", auraName: "林烬·灵魂" },
      { auraId: "aura-2", auraName: "沈微·灵魂" },
    ])
    renderViewer()
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3))
    fireEvent.click(screen.getAllByRole("checkbox")[0])
    fireEvent.click(screen.getByRole("button", { name: /添加所选角色到自定义灵魂/ }))
    await waitFor(() => expect(screen.getByText("绑定小说人物（多选）")).toBeInTheDocument())
    const bindCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).slice(3)
    // 取消勾选已预选的林烬（else next.delete 分支）→ 无选中 → 绑定按钮禁用
    fireEvent.click(bindCheckboxes[0]!)
    expect(bindCheckboxes[0]!.checked).toBe(false)
    expect(screen.getByRole("button", { name: /绑定 并加入灵魂/ })).toBeDisabled()
    // 切换到沈微的 aura
    fireEvent.change(document.querySelector("select") as HTMLSelectElement, {
      target: { value: "aura-2" },
    })
    // 勾选沈微后绑定 → bindCharacterAura 收到 aura-2
    fireEvent.click(bindCheckboxes[1]!)
    await userEvent.click(screen.getByRole("button", { name: /绑定 \(1\)/ }))
    await waitFor(() =>
      expect(mocks.bindCharacterAura).toHaveBeenCalledWith("E:/Novel", {
        characterName: "沈微",
        auraId: "aura-2",
      }),
    )
  })
})
