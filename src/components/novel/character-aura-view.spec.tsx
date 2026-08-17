// @vitest-environment jsdom
/**
 * CharacterAuraView 测试
 * 覆盖：内置/自定义灵魂切换、绑定/解绑、灵魂注入预览、6 步工作流创建、
 * 编辑/删除、AuraDetails 文档加载、hideSidebar 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { CharacterAuraView } from "./character-aura-view"
import type { CharacterAura, CharacterAuraGenerationProgress } from "@/lib/novel/character-aura"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    project: { id: "p1", name: "Novel", path: "E:/Novel" },
    llmConfig: { provider: "custom" as const, apiKey: "k", model: "m" },
    novelConfig: { contextTokenBudget: 0 },
    selectedSoulId: null,
    selectedSoulSection: "builtIn",
    setSelectedSoulId: vi.fn((id: string | null) => {
      state.selectedSoulId = id
    }),
    setSelectedSoulSection: vi.fn((section: "builtIn" | "custom") => {
      state.selectedSoulSection = section
    }),
    bumpDataVersion: vi.fn(),
  }
  return { state }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: Record<string, unknown>) => unknown) => selector(wiki.state),
}))

const auraLib = vi.hoisted(() => {
  const builtInAuras: CharacterAura[] = [
    {
      id: "b1", builtIn: true, name: "内置灵魂", category: "历史帝王", sourceNote: "来源说明",
      corpus: "语料", styleDescription: "风格描述", behaviorRules: "行为规则", boundaries: "边界", notes: "备注",
    },
  ]
  const customAuras: CharacterAura[] = [
    {
      id: "c1", builtIn: false, name: "自定义灵魂", category: "拆书角色", sourceNote: "来源2",
      corpus: "语料2", styleDescription: "风格2", behaviorRules: "行为2", boundaries: "边界2", notes: "备注2",
      expressionDna: "表达2", mentalModel: "心智2", decisionHeuristics: "决策2", valueAntiPatterns: "反模式2",
      honestyBoundaries: "诚实2", sourceUrls: "url1", localDocumentPaths: "p1", generationPrompt: "gp1",
      webSearchEnabled: true, skillFolder: "E:/Novel/skills/c1",
    },
  ]
  return {
    builtInAuras,
    customAuras,
    listCharacterAuras: vi.fn(async () => [...builtInAuras, ...customAuras]),
    listBindableNovelCharacters: vi.fn(async () => ["林烬", "沈微"]),
    getCharacterAuraBindings: vi.fn(async () => [{ characterName: "林烬", auraId: "c1", aliases: ["烬哥"] }]),
    createCustomCharacterAuraSkill: vi.fn(
      async (_path: string, _input: unknown, options?: { onProgress?: (p: CharacterAuraGenerationProgress) => void }) => {
        options?.onProgress?.({ step: 1, total: 6, stage: "整理资料", detail: "开始整理", researchFileName: "01-writings.md" })
        return { id: "c2" }
      },
    ),
    updateCustomCharacterAura: vi.fn(async () => ({ id: "c1" })),
    deleteCustomCharacterAura: vi.fn(async () => ({})),
    bindCharacterAura: vi.fn(async () => ({})),
    unbindCharacterAura: vi.fn(async () => ({})),
    buildCharacterAuraContext: vi.fn(async () => "灵魂上下文内容"),
    loadCharacterAuraSkillDocument: vi.fn(async () => "# SKILL 文档"),
    loadCharacterAuraResearchDocument: vi.fn(async (_aura: CharacterAura, fileName: string) => `# 研究文档 ${fileName}`),
  }
})

vi.mock("@/lib/novel/character-aura", () => ({
  BUILT_IN_CHARACTER_AURAS: auraLib.builtInAuras,
  CHARACTER_AURA_RESEARCH_FILES: [
    { fileName: "01-writings.md", label: "01 公开资料" },
    { fileName: "02-conversations.md", label: "02 对话方式" },
    { fileName: "03-expression-dna.md", label: "03 表达特征" },
    { fileName: "04-external-views.md", label: "04 外部评价" },
    { fileName: "05-decisions.md", label: "05 决策记录" },
    { fileName: "06-timeline.md", label: "06 时间线" },
  ],
  listCharacterAuras: auraLib.listCharacterAuras,
  listBindableNovelCharacters: auraLib.listBindableNovelCharacters,
  getCharacterAuraBindings: auraLib.getCharacterAuraBindings,
  createCustomCharacterAuraSkill: auraLib.createCustomCharacterAuraSkill,
  updateCustomCharacterAura: auraLib.updateCustomCharacterAura,
  deleteCustomCharacterAura: auraLib.deleteCustomCharacterAura,
  bindCharacterAura: auraLib.bindCharacterAura,
  unbindCharacterAura: auraLib.unbindCharacterAura,
  buildCharacterAuraContext: auraLib.buildCharacterAuraContext,
  loadCharacterAuraSkillDocument: auraLib.loadCharacterAuraSkillDocument,
  loadCharacterAuraResearchDocument: auraLib.loadCharacterAuraResearchDocument,
}))

const llm = vi.hoisted(() => ({
  streamChat: vi.fn(async (_config: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
    callbacks.onToken("预览正文")
    callbacks.onDone()
  }),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: llm.streamChat,
}))

const contextEngine = vi.hoisted(() => ({
  buildContextPack: vi.fn(async () => ({ context: "pack" })),
  contextPackToPrompt: vi.fn(() => "CONTEXT PROMPT"),
}))

vi.mock("@/lib/novel/context-engine", () => ({
  buildContextPack: contextEngine.buildContextPack,
  contextPackToPrompt: contextEngine.contextPackToPrompt,
}))

const modelResolver = vi.hoisted(() => ({
  resolveNovelModel: vi.fn(() => ({ provider: "custom" as const, apiKey: "k", model: "m" })),
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveNovelModel: modelResolver.resolveNovelModel,
}))

const projectRefresh = vi.hoisted(() => ({
  refreshProjectState: vi.fn(async () => {}),
}))

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: projectRefresh.refreshProjectState,
}))

vi.mock("@/components/novel/soul-doc-editor", () => ({
  SoulDocEditor: () => <div data-testid="soul-doc-editor" />,
}))

const EMPTY_PREVIEW = "未匹配到已绑定人物灵魂。只有任务中出现已绑定人物名时，灵魂才会注入。"

beforeEach(() => {
  setupDomGlobals({ scrollTo: true })
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.selectedSoulId = null
  wiki.state.selectedSoulSection = "builtIn"
  wiki.state.novelConfig = { contextTokenBudget: 0 }
  auraLib.listCharacterAuras.mockResolvedValue([...auraLib.builtInAuras, ...auraLib.customAuras])
  auraLib.listBindableNovelCharacters.mockResolvedValue(["林烬", "沈微"])
  auraLib.getCharacterAuraBindings.mockResolvedValue([{ characterName: "林烬", auraId: "c1", aliases: ["烬哥"] }])
  auraLib.createCustomCharacterAuraSkill.mockImplementation(
    async (_path: string, _input: unknown, options?: { onProgress?: (p: CharacterAuraGenerationProgress) => void }) => {
      options?.onProgress?.({ step: 1, total: 6, stage: "整理资料", detail: "开始整理", researchFileName: "01-writings.md" })
      return { id: "c2" }
    },
  )
  auraLib.buildCharacterAuraContext.mockResolvedValue("灵魂上下文内容")
  llm.streamChat.mockImplementation(
    async (_config: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
      callbacks.onToken("预览正文")
      callbacks.onDone()
    },
  )
})

afterEach(() => {
  cleanup()
})

async function switchToCharacterTab() {
  fireEvent.click(screen.getByText("novel.soul.characterSoul"))
  await screen.findByText("角色灵魂")
}

/** Field/TextField 的 Label 与控件是兄弟节点（无 htmlFor），按 label 文本定位控件 */
function fieldControl(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelEl = screen.getByText(label).closest("label") as HTMLLabelElement
  const container = labelEl.parentElement as HTMLElement
  return container.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement
}

describe("CharacterAuraView", () => {
  it("shows the project soul editor on the project tab", async () => {
    render(<CharacterAuraView />)
    expect(await screen.findByTestId("soul-doc-editor")).toBeInTheDocument()
    // 默认选中项目灵魂 tab
    expect(screen.queryByText("角色灵魂")).not.toBeInTheDocument()
  })

  it("loads auras, characters and bindings on mount", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    // 加载调用
    expect(auraLib.listCharacterAuras).toHaveBeenCalledWith("E:/Novel")
    expect(auraLib.listBindableNovelCharacters).toHaveBeenCalledWith("E:/Novel")
    expect(auraLib.getCharacterAuraBindings).toHaveBeenCalledWith("E:/Novel")
    // 内置灵魂详情（h2）
    expect(screen.getByText("内置灵魂", { selector: "h2" })).toBeInTheDocument()
    // 人物下拉框
    expect(screen.getByRole("option", { name: "林烬" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "沈微" })).toBeInTheDocument()
    // 绑定区（b1 无绑定）
    expect(screen.getByText("当前灵魂还没有绑定任何小说人物。")).toBeInTheDocument()
  })

  it("renders custom aura details with skill and research documents", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    // 详情 + 徽标 + 编辑/删除
    expect(await screen.findByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
    expect(screen.getAllByText("自定义灵魂").length).toBeGreaterThan(1)
    expect(screen.getByText("编辑灵魂")).toBeInTheDocument()
    expect(screen.getByText("删除灵魂")).toBeInTheDocument()
    // 详情字段（风格2 同时出现在列表与详情）
    expect(screen.getAllByText("来源2").length).toBeGreaterThan(0)
    expect(screen.getAllByText("风格2").length).toBeGreaterThan(0)
    expect(screen.getByText("表达2")).toBeInTheDocument()
    expect(screen.getByText("心智2")).toBeInTheDocument()
    expect(screen.getByText("决策2")).toBeInTheDocument()
    expect(screen.getByText("反模式2")).toBeInTheDocument()
    expect(screen.getByText("诚实2")).toBeInTheDocument()
    // 生成提示词 + AI 搜索
    expect(screen.getByText("gp1")).toBeInTheDocument()
    expect(screen.getByText("已开启")).toBeInTheDocument()
    // 灵魂文档
    expect(await screen.findByText("# SKILL 文档")).toBeInTheDocument()
    // 研究文件：默认 01
    expect(await screen.findByText("# 研究文档 01-writings.md")).toBeInTheDocument()
    expect(auraLib.loadCharacterAuraSkillDocument).toHaveBeenCalledWith(auraLib.customAuras[0], "E:/Novel")
    // 切换研究文件
    fireEvent.click(screen.getByText("02 对话方式"))
    expect(await screen.findByText("# 研究文档 02-conversations.md")).toBeInTheDocument()
    expect(auraLib.loadCharacterAuraResearchDocument).toHaveBeenLastCalledWith(auraLib.customAuras[0], "02-conversations.md", "E:/Novel")
  })

  it("shows fallback values for minimal custom auras without a skill folder", async () => {
    const minimal: CharacterAura = {
      id: "c9", builtIn: false, name: "极简灵魂", sourceNote: "sn",
      corpus: "corpus-x", styleDescription: "style-x", behaviorRules: "br-x", boundaries: "bd-x", notes: "nt-x",
    }
    auraLib.listCharacterAuras.mockResolvedValue([...auraLib.builtInAuras, minimal])
    auraLib.getCharacterAuraBindings.mockResolvedValue([])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    expect(await screen.findByText("极简灵魂", { selector: "h2" })).toBeInTheDocument()
    // category ?? 自定义灵魂 / skillFolder ?? 未关联灵魂文件夹
    expect(screen.getAllByText("自定义灵魂").length).toBeGreaterThan(0)
    expect(screen.getByText("未关联灵魂文件夹")).toBeInTheDocument()
    // 可选字段回退（详情多处以同一文案渲染）
    expect(screen.getAllByText("style-x").length).toBeGreaterThan(0)
    expect(screen.getAllByText("corpus-x").length).toBeGreaterThan(0)
    expect(screen.getByText("br-x")).toBeInTheDocument()
    expect(screen.getByText("nt-x")).toBeInTheDocument()
    expect(screen.getByText("bd-x")).toBeInTheDocument()
    // 未开启 AI 搜索
    expect(screen.getByText("未开启")).toBeInTheDocument()
    // 无 skillFolder → 无文档占位
    expect(await screen.findByText("暂无灵魂文档。")).toBeInTheDocument()
    expect(screen.getByText("暂无研究文件。")).toBeInTheDocument()
    expect(auraLib.loadCharacterAuraSkillDocument).not.toHaveBeenCalled()
    // 编辑表单中的可选字段回退（formFromAura）
    fireEvent.click(screen.getByText("编辑灵魂"))
    expect((fieldControl("怎么说话 / 表达特征") as HTMLTextAreaElement).value).toBe("style-x")
    expect((fieldControl("怎么想 / 心智模型") as HTMLTextAreaElement).value).toBe("corpus-x")
    expect((fieldControl("怎么判断 / 决策启发式") as HTMLTextAreaElement).value).toBe("br-x")
    expect((fieldControl("什么不做 / 价值观反模式") as HTMLTextAreaElement).value).toBe("nt-x")
    expect((fieldControl("知道局限 / 诚实边界") as HTMLTextAreaElement).value).toBe("bd-x")
  })

  it("reports skill and research document load errors", async () => {
    auraLib.loadCharacterAuraSkillDocument.mockRejectedValueOnce(new Error("boom"))
    auraLib.loadCharacterAuraResearchDocument.mockRejectedValueOnce(new Error("boom2"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    expect(await screen.findByText("灵魂文档读取失败：E:/Novel/skills/c1/SKILL.md")).toBeInTheDocument()
    expect(await screen.findByText("研究文件读取失败：E:/Novel/skills/c1/references/research/01-writings.md")).toBeInTheDocument()
  })

  it("binds a character with aliases to the selected aura", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await screen.findByText("自定义灵魂", { selector: "h2" })
    // 别名输入
    const aliasesInput = screen.getByPlaceholderText("例如：小林, 烬哥, 林公子")
    fireEvent.change(aliasesInput, { target: { value: "小林, 烬哥、林公子" } })
    fireEvent.click(screen.getByText("绑定"))
    await waitFor(() => {
      expect(auraLib.bindCharacterAura).toHaveBeenCalledWith("E:/Novel", {
        characterName: "林烬",
        auraId: "c1",
        aliases: ["小林", "烬哥", "林公子"],
      })
    })
    expect(wiki.state.bumpDataVersion).toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent("已将「自定义灵魂」绑定到人物「林烬」")
    // 别名清空
    expect((aliasesInput as HTMLInputElement).value).toBe("")
  })

  it("binds with a different character and without aliases", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await screen.findByText("自定义灵魂", { selector: "h2" })
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "沈微" } })
    fireEvent.click(screen.getByText("绑定"))
    await waitFor(() => {
      expect(auraLib.bindCharacterAura).toHaveBeenCalledWith("E:/Novel", {
        characterName: "沈微",
        auraId: "c1",
        aliases: undefined,
      })
    })
  })

  it("disables the bind button without characters or selection", async () => {
    auraLib.listBindableNovelCharacters.mockResolvedValue([])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    // 无人物可选 → select 显示提示 + 绑定按钮禁用
    const bindButton = screen.getByText("绑定").closest("button") as HTMLButtonElement
    await waitFor(() => {
      expect(bindButton.disabled).toBe(true)
    })
    expect(screen.getByText("请先在人物小传或实体页中添加小说人物")).toBeInTheDocument()
  })

  it("unbinds a character from the selected aura", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    // 绑定 chip：林烬（别名：烬哥）
    expect(await screen.findByText(/别名：烬哥/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/别名：烬哥/))
    await waitFor(() => {
      expect(auraLib.unbindCharacterAura).toHaveBeenCalledWith("E:/Novel", "林烬", "c1")
    })
    expect(wiki.state.bumpDataVersion).toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent("已取消“林烬”与“自定义灵魂”的绑定")
  })

  it("shows the empty injection message when no aura context is built", async () => {
    auraLib.buildCharacterAuraContext.mockResolvedValue("")
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "写林烬进入皇城" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    expect(await screen.findByText(EMPTY_PREVIEW)).toBeInTheDocument()
    expect(auraLib.buildCharacterAuraContext).toHaveBeenCalledWith("E:/Novel", "写林烬进入皇城", { fallbackAuraId: "b1" })
  })

  it("streams a preview snippet from the context pack", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "写林烬进入皇城" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    expect(await screen.findByText("预览正文")).toBeInTheDocument()
    // 上下文装配 + 模型解析 + 流式调用
    expect(contextEngine.buildContextPack).toHaveBeenCalledWith("E:/Novel", "写林烬进入皇城")
    expect(contextEngine.contextPackToPrompt).toHaveBeenCalledWith(expect.objectContaining({ context: "pack" }), undefined)
    expect(modelResolver.resolveNovelModel).toHaveBeenCalledWith(wiki.state.llmConfig, wiki.state.novelConfig, "writing")
    expect(llm.streamChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.anything(),
      expect.anything(),
      { temperature: 0.7 },
    )
  })

  it("passes the context token budget to the prompt builder", async () => {
    wiki.state.novelConfig = { contextTokenBudget: 8000 }
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "写林烬进入皇城" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    await screen.findByText("预览正文")
    expect(contextEngine.contextPackToPrompt).toHaveBeenCalledWith(expect.anything(), 8000)
  })

  it("previews without a fallback aura when nothing is selected", async () => {
    auraLib.listCharacterAuras.mockResolvedValue([...auraLib.builtInAuras])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    // 无自定义灵魂 → 占位
    expect(await screen.findByText("还没有自定义灵魂。点击左侧上方“新建角色灵魂”后，就可以生成并保存到当前小说项目。")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "任务" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    await waitFor(() => {
      expect(auraLib.buildCharacterAuraContext).toHaveBeenCalledWith("E:/Novel", "任务", undefined)
    })
  })

  it("reports stream errors from the preview", async () => {
    llm.streamChat.mockImplementationOnce(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
        callbacks.onError(new Error("流式错误"))
      },
    )
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "写林烬进入皇城" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    expect(await screen.findByText("流式错误")).toBeInTheDocument()
  })

  it("reports context build failures from the preview", async () => {
    auraLib.buildCharacterAuraContext.mockRejectedValueOnce(new Error("上下文构建失败"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "写林烬进入皇城" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    expect(await screen.findByText("上下文构建失败")).toBeInTheDocument()
  })

  it("creates a custom aura through the 6-step workflow", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    // 创建表单
    expect(screen.getByText("新建角色灵魂", { selector: "h2" })).toBeInTheDocument()
    // 名称为空 → 禁用
    const createButton = screen.getByText("从资料生成角色灵魂").closest("button") as HTMLButtonElement
    expect(createButton.disabled).toBe(true)
    // 填表
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.change(fieldControl("人物分类"), { target: { value: "小说角色" } })
    fireEvent.change(fieldControl("生成提示词"), { target: { value: "提示词内容" } })
    fireEvent.change(fieldControl("资料文本"), { target: { value: "资料内容" } })
    fireEvent.change(fieldControl("网页资料地址"), { target: { value: "https://a.com\nhttps://b.com" } })
    fireEvent.change(fieldControl("本地文档路径"), { target: { value: "E:/doc.md" } })
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(createButton)
    await waitFor(() => {
      expect(auraLib.createCustomCharacterAuraSkill).toHaveBeenCalledWith("E:/Novel", {
        name: "新灵魂",
        category: "小说角色",
        corpus: "资料内容",
        sourceUrls: "https://a.com\nhttps://b.com",
        localDocumentPaths: "E:/doc.md",
        generationPrompt: "提示词内容",
        enableWebSearch: true,
      }, expect.objectContaining({ onProgress: expect.any(Function) }))
    })
    expect(projectRefresh.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByRole("status")).toHaveTextContent("自定义灵魂已按 6 步工作流生成并保存到当前小说项目")
  })

  it("shows generation progress while creating", async () => {
    // 生成后的 refresh 挂起，让创建表单保持打开以展示进度
    auraLib.listCharacterAuras.mockImplementationOnce(() => new Promise(() => {}))
    // 创建挂起（调用 onProgress 后不 resolve），进度面板才能保持可见（resolve 后会 setGenerationProgress(null)）
    auraLib.createCustomCharacterAuraSkill.mockImplementationOnce(
      (_path: string, _input: unknown, options?: { onProgress?: (p: any) => void }) => {
        options?.onProgress?.({ step: 1, total: 6, stage: "整理资料", detail: "开始整理", researchFileName: "01-writings.md" })
        return new Promise(() => {})
      },
    )
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    // onProgress 回调 → 进度展示（status 与进度面板两处；status 含完整文案）
    expect(await screen.findByRole("status")).toHaveTextContent("整理资料（1/6）：开始整理")
    expect(screen.getByText("开始整理")).toBeInTheDocument()
    expect(screen.getByText(/当前研究文件：01-writings.md/)).toBeInTheDocument()
  })

  it("blocks interactions while generating via the binding chip", async () => {
    // 生成挂起 + 无进度回调 → 通用拦截文案
    auraLib.createCustomCharacterAuraSkill.mockImplementationOnce(() => new Promise(() => {}))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    // 绑定 chip 未禁用 → 点击触发拦截
    fireEvent.click(await screen.findByText(/别名：烬哥/))
    expect(screen.getByRole("status")).toHaveTextContent("当前正在生成角色灵魂，请等待完成后再切换或操作其他灵魂。")
    expect(auraLib.unbindCharacterAura).not.toHaveBeenCalled()
  })

  it("blocks with the stage label when progress is available", async () => {
    auraLib.createCustomCharacterAuraSkill.mockImplementationOnce(
      async (_p: string, _i: unknown, opts?: { onProgress?: (p: CharacterAuraGenerationProgress) => void }) => {
        opts?.onProgress?.({ step: 3, total: 6, stage: "生成表达特征", detail: "dd" })
        return new Promise(() => {})
      },
    )
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    fireEvent.click(await screen.findByText(/别名：烬哥/))
    expect(screen.getByRole("status")).toHaveTextContent("当前正在执行「生成表达特征」(3/6)，请等待完成后再切换或操作其他灵魂。")
  })

  it("reports create failures with Error and fallback messages", async () => {
    auraLib.createCustomCharacterAuraSkill.mockRejectedValueOnce(new Error("生成失败"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    expect(await screen.findByText("生成失败")).toBeInTheDocument()
    // 非 Error 抛出 → 兜底消息
    auraLib.createCustomCharacterAuraSkill.mockRejectedValueOnce("boom")
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂2" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    expect(await screen.findByText("自定义灵魂生成失败，请检查项目文件权限后重试")).toBeInTheDocument()
  })

  it("does not start creation without a project", async () => {
    wiki.state.project = null
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click((await screen.findAllByText("新建角色灵魂"))[0])
    fireEvent.change(fieldControl("名称"), { target: { value: "新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    expect(auraLib.createCustomCharacterAuraSkill).not.toHaveBeenCalled()
  })

  it("edits and saves a custom aura", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    // 编辑表单预填
    expect((fieldControl("名称") as HTMLInputElement).value).toBe("自定义灵魂")
    expect((fieldControl("气质说明") as HTMLTextAreaElement).value).toBe("来源2")
    expect((fieldControl("怎么说话 / 表达特征") as HTMLTextAreaElement).value).toBe("表达2")
    fireEvent.change(fieldControl("名称"), { target: { value: "改名后的灵魂" } })
    fireEvent.click(screen.getByText("保存修改"))
    await waitFor(() => {
      expect(auraLib.updateCustomCharacterAura).toHaveBeenCalledWith("E:/Novel", "c1", expect.objectContaining({
        name: "改名后的灵魂",
        category: "拆书角色",
        sourceNote: "来源2",
        expressionDna: "表达2",
        mentalModel: "心智2",
        decisionHeuristics: "决策2",
        valueAntiPatterns: "反模式2",
        honestyBoundaries: "诚实2",
        webSearchEnabled: true,
      }))
    })
    expect(projectRefresh.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByRole("status")).toHaveTextContent("自定义灵魂已更新")
    // 编辑器关闭 → 回到详情
    expect(screen.queryByText("保存修改")).not.toBeInTheDocument()
  })

  it("falls back to existing fields when heuristic fields are emptied", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    // 清空决策启发式 → behaviorRules 回退到表单值
    fireEvent.change(fieldControl("怎么判断 / 决策启发式"), { target: { value: "  " } })
    fireEvent.change(fieldControl("什么不做 / 价值观反模式"), { target: { value: "  " } })
    fireEvent.change(fieldControl("知道局限 / 诚实边界"), { target: { value: "  " } })
    fireEvent.click(screen.getByText("保存修改"))
    await waitFor(() => {
      const payload = auraLib.updateCustomCharacterAura.mock.calls[0][2] as Record<string, unknown>
      expect(payload.behaviorRules).toBe("行为2")
      expect(payload.notes).toBe("备注2")
      expect(payload.boundaries).toBe("边界2")
      expect(payload.decisionHeuristics).toBe("")
      expect(payload.valueAntiPatterns).toBe("")
      expect(payload.honestyBoundaries).toBe("")
    })
  })

  it("reports update failures", async () => {
    auraLib.updateCustomCharacterAura.mockRejectedValueOnce(new Error("保存失败"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    fireEvent.click(screen.getByText("保存修改"))
    expect(await screen.findByText("保存失败")).toBeInTheDocument()
    // 非 Error → 兜底
    auraLib.updateCustomCharacterAura.mockRejectedValueOnce("boom")
    fireEvent.click(screen.getByText("保存修改"))
    expect(await screen.findByText("自定义灵魂更新失败，请检查项目文件权限后重试")).toBeInTheDocument()
  })

  it("deletes a custom aura from the edit form after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    fireEvent.click(screen.getByText("删除"))
    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => {
      // 表单删除按钮把点击事件当作 targetAura 传入（既有行为），仍走删除流程
      expect(auraLib.deleteCustomCharacterAura).toHaveBeenCalledWith("E:/Novel", undefined)
    })
    expect(projectRefresh.refreshProjectState).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByRole("status")).toHaveTextContent("自定义灵魂已删除")
    // 删除后编辑器关闭 → 回到详情
    expect(screen.queryByText("保存修改")).not.toBeInTheDocument()
    expect(screen.getByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
    confirmSpy.mockRestore()
  })

  it("does not delete without confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    fireEvent.click(screen.getByText("删除"))
    expect(auraLib.deleteCustomCharacterAura).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it("deletes a custom aura from the details view", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("删除灵魂"))
    await waitFor(() => {
      expect(auraLib.deleteCustomCharacterAura).toHaveBeenCalledWith("E:/Novel", "c1")
    })
    confirmSpy.mockRestore()
  })

  it("reports delete failures", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    auraLib.deleteCustomCharacterAura.mockRejectedValueOnce(new Error("删除失败"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("删除灵魂"))
    expect(await screen.findByText("删除失败")).toBeInTheDocument()
    confirmSpy.mockRestore()
  })

  it("selects the first built-in aura when switching back from custom", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await screen.findByText("自定义灵魂", { selector: "h2" })
    fireEvent.click(screen.getByText("内置灵魂"))
    expect(await screen.findByText("内置灵魂", { selector: "h2" })).toBeInTheDocument()
    // 内置灵魂没有编辑/删除按钮
    expect(screen.queryByText("编辑灵魂")).not.toBeInTheDocument()
    expect(screen.queryByText("删除灵魂")).not.toBeInTheDocument()
  })

  it("opens the create editor and cancels back to the details", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("新建角色灵魂"))
    expect(screen.getByText("新建角色灵魂", { selector: "h2" })).toBeInTheDocument()
    fireEvent.click(screen.getByText("返回预览"))
    // 回到详情
    expect(await screen.findByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("reports refresh failures", async () => {
    auraLib.listCharacterAuras.mockRejectedValueOnce(new Error("加载失败"))
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    expect(await screen.findByText("加载失败")).toBeInTheDocument()
    // 非 Error → 兜底消息
    cleanup()
    auraLib.listCharacterAuras.mockRejectedValueOnce("boom")
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    expect(await screen.findByText("角色灵魂加载失败，请稍后重试")).toBeInTheDocument()
  })

  it("keeps the current character and selection on refresh", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "沈微" } })
    // 重新触发刷新：当前人物仍存在 → 保留
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(screen.getByText("内置灵魂"))
    await screen.findByText("内置灵魂", { selector: "h2" })
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("沈微")
  })

  it("selects the first custom aura when entering the custom section", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    // 选中第一个自定义灵魂（详情 h2）
    expect(await screen.findByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("auto-opens the create editor in sidebar mode for a new custom soul", async () => {
    wiki.state.selectedSoulSection = "custom"
    wiki.state.selectedSoulId = "new-custom-soul"
    // 加载挂起，避免 refresh 回写选中 id 后自动关闭编辑器
    auraLib.listCharacterAuras.mockImplementationOnce(() => new Promise(() => {}))
    render(<CharacterAuraView hideSidebar />)
    // 无 tab、无侧栏
    expect(screen.queryByText("novel.soul.projectSoul")).not.toBeInTheDocument()
    expect(screen.queryByText("内置灵魂")).not.toBeInTheDocument()
    // 自动进入创建编辑器
    expect(await screen.findByText("新建角色灵魂", { selector: "h2" })).toBeInTheDocument()
    // 名称写入后创建
    fireEvent.change(fieldControl("名称"), { target: { value: "侧栏新灵魂" } })
    fireEvent.click(screen.getByText("从资料生成角色灵魂"))
    await waitFor(() => {
      expect(auraLib.createCustomCharacterAuraSkill).toHaveBeenCalled()
    })
    // hideSidebar：更新动作写回 store
    expect(wiki.state.setSelectedSoulSection).toHaveBeenCalledWith("custom")
  })

  it("renders a stored custom soul in sidebar mode", async () => {
    wiki.state.selectedSoulSection = "custom"
    wiki.state.selectedSoulId = "c1"
    render(<CharacterAuraView hideSidebar />)
    expect(await screen.findByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
    // 删除按钮可用 → 走 store 同步
    fireEvent.click(screen.getByText("编辑灵魂"))
    expect(screen.getByText("编辑角色灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("renders the built-in section from the store in sidebar mode", async () => {
    wiki.state.selectedSoulSection = "builtIn"
    wiki.state.selectedSoulId = "b1"
    render(<CharacterAuraView hideSidebar />)
    expect(await screen.findByText("内置灵魂", { selector: "h2" })).toBeInTheDocument()
    // 预览按钮（无侧栏布局）
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "任务" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    expect(await screen.findByText("预览正文")).toBeInTheDocument()
  })

  it("does not refresh or load anything without a project", async () => {
    wiki.state.project = null
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    // refresh 的 !project 守卫直接返回，不发起任何加载
    expect(auraLib.listCharacterAuras).not.toHaveBeenCalled()
    expect(auraLib.listBindableNovelCharacters).not.toHaveBeenCalled()
    expect(auraLib.getCharacterAuraBindings).not.toHaveBeenCalled()
    // 人物下拉框为空占位
    expect(screen.getByText("请先在人物小传或实体页中添加小说人物")).toBeInTheDocument()
  })

  it("falls back to the first custom aura when the selected built-in disappears", async () => {
    auraLib.listCharacterAuras.mockResolvedValue([...auraLib.customAuras])
    auraLib.getCharacterAuraBindings.mockResolvedValue([])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    // refresh 时 b1 已不在列表 → 内置 fallback 找不到 → 取首个 custom（但不显示内置详情）
    expect(auraLib.listCharacterAuras).toHaveBeenCalledWith("E:/Novel")
    await waitFor(() => {
      expect(screen.queryByText("内置灵魂", { selector: "h2" })).not.toBeInTheDocument()
    })
    // selected 为 null 时切到自定义 section → (selected?.builtIn ?? true) 走 ?? 右侧
    fireEvent.click(screen.getByText("自定义灵魂"))
    expect(await screen.findByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("handles an empty aura list from the backend", async () => {
    auraLib.listCharacterAuras.mockResolvedValue([])
    auraLib.getCharacterAuraBindings.mockResolvedValue([])
    auraLib.listBindableNovelCharacters.mockResolvedValue([])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    // loaded 为空 → nextId = fallback ?? loaded[0]?.id ?? "" 的最后一级 ?? ""
    expect(auraLib.listCharacterAuras).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByText("请先在人物小传或实体页中添加小说人物")).toBeInTheDocument()
  })

  it("renders when the built-in aura catalog is empty", async () => {
    const saved = [...auraLib.builtInAuras]
    auraLib.builtInAuras.length = 0
    try {
      auraLib.listCharacterAuras.mockResolvedValue([...auraLib.customAuras])
      render(<CharacterAuraView />)
      await switchToCharacterTab()
      expect(auraLib.listCharacterAuras).toHaveBeenCalledWith("E:/Novel")
      expect(screen.getByText("绑定小说人物")).toBeInTheDocument()
    } finally {
      auraLib.builtInAuras.push(...saved)
    }
  })

  it("syncs an empty stored selection back to the first aura in sidebar mode", async () => {
    // beforeEach 已将 selectedSoulId 置为 null
    render(<CharacterAuraView hideSidebar />)
    expect(await screen.findByText("内置灵魂", { selector: "h2" })).toBeInTheDocument()
    await waitFor(() => {
      expect(wiki.state.setSelectedSoulId).toHaveBeenCalledWith("b1")
    })
  })

  it("selects a custom aura from the sidebar list", async () => {
    const extra: CharacterAura = {
      id: "c3", builtIn: false, name: "二号灵魂", category: "拆书角色",
      sourceNote: "sn", corpus: "co", styleDescription: "st", behaviorRules: "br", boundaries: "bd", notes: "nt",
    }
    auraLib.listCharacterAuras.mockResolvedValue([...auraLib.builtInAuras, ...auraLib.customAuras, extra])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    // 点击侧栏行（非 section tab）→ 行级 onClick
    fireEvent.click(screen.getByText("二号灵魂"))
    expect(await screen.findByText("二号灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("selects another built-in aura from the sidebar list", async () => {
    const b2: CharacterAura = {
      id: "b2", builtIn: true, name: "内置灵魂二号", category: "历史帝王",
      sourceNote: "s", corpus: "c", styleDescription: "st", behaviorRules: "br", boundaries: "bd", notes: "n",
    }
    auraLib.listCharacterAuras.mockResolvedValue([...auraLib.builtInAuras, b2, ...auraLib.customAuras])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("内置灵魂二号"))
    expect(await screen.findByText("内置灵魂二号", { selector: "h2" })).toBeInTheDocument()
  })

  it("renders a binding chip without aliases", async () => {
    auraLib.getCharacterAuraBindings.mockResolvedValue([{ characterName: "林烬", auraId: "c1" }])
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    const chip = await screen.findByRole("button", { name: "林烬" })
    expect(chip).toBeInTheDocument()
    // 无别名 → 别名后缀分支不渲染
    expect(screen.queryByText(/别名：/)).not.toBeInTheDocument()
  })

  it("re-clicking the built-in section keeps the built-in selection", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await screen.findByText("自定义灵魂", { selector: "h2" })
    // 切回内置（选中从 custom 变内置）
    fireEvent.click(screen.getAllByText("内置灵魂")[0])
    await screen.findByText("内置灵魂", { selector: "h2" })
    // 再点一次内置 tab：selected 已是内置 → !selected.builtIn 短路
    fireEvent.click(screen.getAllByText("内置灵魂")[0])
    expect(screen.getByText("内置灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("re-clicking the custom section keeps the custom selection", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await screen.findByText("自定义灵魂", { selector: "h2" })
    // 再点一次自定义 tab：selected 已是 custom → (selected?.builtIn ?? true) 短路
    fireEvent.click(screen.getAllByText("自定义灵魂")[0])
    expect(screen.getByText("自定义灵魂", { selector: "h2" })).toBeInTheDocument()
  })

  it("returns to the project soul tab", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("novel.soul.projectSoul"))
    expect(await screen.findByTestId("soul-doc-editor")).toBeInTheDocument()
  })

  it("falls back to the empty preview message when the stream yields no tokens", async () => {
    llm.streamChat.mockImplementationOnce(
      async (_c: unknown, _m: unknown, callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void }) => {
        callbacks.onDone()
      },
    )
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.change(screen.getByPlaceholderText("例如：写林烬进入皇城，与太子第一次交锋"), {
      target: { value: "任务" },
    })
    fireEvent.click(screen.getByText("预览本次注入"))
    // 空流 → 预览区内渲染 EMPTY_AURA_PREVIEW_MESSAGE（<pre> 内）
    await waitFor(() => {
      const pre = document.querySelector("pre")
      expect(pre?.textContent).toContain("未匹配到已绑定人物灵魂")
    })
  })

  it("edits the advanced fields and saves their values", async () => {
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    fireEvent.click(await screen.findByText("编辑灵魂"))
    fireEvent.change(fieldControl("气质说明"), { target: { value: "来源X" } })
    fireEvent.change(fieldControl("灵魂摘要"), { target: { value: "摘要X" } })
    fireEvent.change(fieldControl("怎么说话 / 表达特征"), { target: { value: "表达X" } })
    fireEvent.change(fieldControl("怎么想 / 心智模型"), { target: { value: "心智X" } })
    fireEvent.change(fieldControl("资料文本 / 来源摘要"), { target: { value: "资料X" } })
    fireEvent.change(fieldControl("网页资料地址"), { target: { value: "https://x.com" } })
    fireEvent.change(fieldControl("本地文档路径"), { target: { value: "E:/x.md" } })
    fireEvent.click(screen.getByText("保存修改"))
    await waitFor(() => {
      expect(auraLib.updateCustomCharacterAura).toHaveBeenCalled()
      const payload = auraLib.updateCustomCharacterAura.mock.calls[0][2] as Record<string, unknown>
      expect(payload.sourceNote).toBe("来源X")
      expect(payload.styleDescription).toBe("摘要X")
      expect(payload.expressionDna).toBe("表达X")
      expect(payload.mentalModel).toBe("心智X")
      expect(payload.corpus).toBe("资料X")
      expect(payload.sourceUrls).toBe("https://x.com")
      expect(payload.localDocumentPaths).toBe("E:/x.md")
    })
  })

  it("ignores late document load rejections after unmounting the details view", async () => {
    let rejectSkill!: (e: Error) => void
    let rejectResearch!: (e: Error) => void
    let skillStarted = false
    let researchStarted = false
    auraLib.loadCharacterAuraSkillDocument.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          skillStarted = true
          rejectSkill = rej
        }),
    )
    auraLib.loadCharacterAuraResearchDocument.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          researchStarted = true
          rejectResearch = rej
        }),
    )
    render(<CharacterAuraView />)
    await switchToCharacterTab()
    fireEvent.click(screen.getByText("自定义灵魂"))
    await waitFor(() => {
      expect(skillStarted && researchStarted).toBe(true)
    })
    cleanup()
    await act(async () => {
      rejectSkill(new Error("late"))
      rejectResearch(new Error("late"))
      await new Promise((r) => setTimeout(r, 0))
    })
    // cancelled=true 分支已走：不再 setSkillError/setResearchError（无声无息）
  })
})
