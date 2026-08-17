import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  getExecutableDir: vi.fn(),
  getResourceDir: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  getExecutableDir: fsMocks.getExecutableDir,
  getResourceDir: fsMocks.getResourceDir,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: vi.fn(() => false),
}))

import { isTauri } from "@/lib/platform"

const searchWikiMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/search", () => ({
  searchWiki: searchWikiMock,
}))

const loggerWarnMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/utils", () => ({
  logger: { warn: loggerWarnMock },
}))

vi.mock("@tauri-apps/api/path", () => ({
  resourceDir: vi.fn(async () => "/resources"),
}))

import { resourceDir } from "@tauri-apps/api/path"

const listBindableMock = vi.hoisted(() => vi.fn())
vi.mock("./bindable-characters", () => ({
  listBindableNovelCharacters: listBindableMock,
}))

import {
  buildCharacterAuraContext,
  hasCharacterProfile,
  loadCharacterAuraResearchDocument,
  loadCharacterAuraSkillDocument,
} from "./character-aura-context"

const STORE_PATH = "/P/.qmai/character-aura.json"

function seedStore(store: unknown): void {
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith(STORE_PATH)) return JSON.stringify(store)
    throw new Error("ENOENT")
  })
}

function customAura(skillFolder?: string) {
  return {
    id: "custom-1",
    builtIn: false,
    name: "李清照",
    category: "诗人",
    sourceNote: "来源",
    corpus: "语料",
    styleDescription: "风格描述",
    behaviorRules: "行为规则",
    boundaries: "边界",
    notes: "备注",
    expressionDna: "表达特征文本。",
    mentalModel: "心智模型文本。",
    decisionHeuristics: "决策启发式文本。",
    valueAntiPatterns: "反模式文本。",
    honestyBoundaries: "诚实边界文本。",
    skillFolder,
  }
}

describe("buildCharacterAuraContext", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
  })

  it("returns an empty string when there are no bindings", async () => {
    seedStore({ customAuras: [], bindings: [] })
    expect(await buildCharacterAuraContext("/P", "生成第3章")).toBe("")
  })

  it("matches a bound character by name in the task text", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "生成第3章，小晴在旧屋醒来", {
      matchingText: "第3章章纲：小晴发现第二把钥匙。",
    })
    expect(context).toContain("- 小晴：李清照")
    expect(context).toContain("  - 人物分类：诗人")
    expect(context).toContain("  - 怎么说话 / 表达特征：表达特征文本。")
    expect(context).toContain("- 角色灵魂必须服从大纲、人物小传、角色认知和正史规则")
  })

  it("matches by alias", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1", aliases: ["晴晴", ""] }],
    })
    const context = await buildCharacterAuraContext("/P", "晴晴登场", {})
    expect(context).toContain("- 小晴：李清照")
  })

  it("matches by pinyin when only the pinyin appears", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "xiaoqing 醒来", {})
    expect(context).toContain("- 小晴：李清照")
  })

  it("matches by simplified form when the traditional name appears", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "葉問天", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "叶问天登场", {})
    expect(context).toContain("- 葉問天：李清照")
  })

  it("matches through simplified aliases and renders the structured field fallbacks", async () => {
    seedStore({
      customAuras: [{
        ...customAura(),
        category: undefined,
        corpus: "语料回退",
        styleDescription: "风格回退",
        behaviorRules: "行为回退",
        boundaries: "边界回退",
        notes: "备注回退",
        expressionDna: undefined,
        mentalModel: undefined,
        decisionHeuristics: undefined,
        valueAntiPatterns: undefined,
        honestyBoundaries: undefined,
      }],
      // `乾隆后` maps to `干隆后`, while their pinyin differs, so this reaches
      // the simplified-alias matcher rather than the earlier pinyin matcher.
      bindings: [{ characterName: "小晴", auraId: "custom-1", aliases: ["乾隆后"] }],
    })

    const context = await buildCharacterAuraContext("/P", "干隆后", {})

    expect(context).toContain("人物分类：自定义灵魂")
    expect(context).toContain("表达特征：语料回退")
    expect(context).toContain("心智模型：风格回退")
    expect(context).toContain("决策启发式：行为回退")
    expect(context).toContain("价值观反模式：备注回退")
    expect(context).toContain("诚实边界：边界回退")
  })

  it("keeps matching a persisted binding whose name normalizes to empty text", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "", auraId: "custom-1" }],
    })

    await expect(buildCharacterAuraContext("/P", "任意任务", {})).resolves.toContain("- ：李清照")
  })

  it("returns an empty string when nothing matches", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    expect(await buildCharacterAuraContext("/P", "生成第5章", {})).toBe("")
  })

  it("applies fallbackAuraId when nothing matches", async () => {
    seedStore({
      customAuras: [customAura(), { ...customAura(), id: "custom-2", name: "路人" }],
      bindings: [
        { characterName: "小晴", auraId: "custom-1" },
        { characterName: "路人甲", auraId: "custom-2" },
      ],
    })
    const context = await buildCharacterAuraContext("/P", "生成第5章", { fallbackAuraId: "custom-2" })
    expect(context).toContain("- 路人甲")
    expect(context).not.toContain("小晴")
  })

  it("returns an empty string when fallbackAuraId matches nothing", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    expect(await buildCharacterAuraContext("/P", "生成第5章", { fallbackAuraId: "ghost" })).toBe("")
  })

  it("prefers direct matches over fallbackAuraId", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [
        { characterName: "小晴", auraId: "custom-1" },
        { characterName: "路人甲", auraId: "custom-2" },
      ],
    })
    const context = await buildCharacterAuraContext("/P", "小晴的戏份", { fallbackAuraId: "custom-2" })
    expect(context).toContain("- 小晴")
    expect(context).not.toContain("路人甲")
  })

  it("skips bindings whose aura is missing and returns an empty string", async () => {
    seedStore({
      customAuras: [],
      bindings: [{ characterName: "小晴", auraId: "ghost" }],
    })
    expect(await buildCharacterAuraContext("/P", "小晴", {})).toBe("")
  })

  it("renders a writing preview in previewMode writing", async () => {
    seedStore({
      customAuras: [customAura()],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "  写小晴的内心戏  ", {
      previewMode: "writing",
    })
    expect(context).toContain("【本次写作会怎样塑造「小晴」】")
    expect(context).toContain("任务场景：写小晴的内心戏")
    expect(context).toContain("- 表达方式：表达特征文本")
    expect(context).toContain("- 思考方式：心智模型文本")
    expect(context).toContain("- 决策方式：决策启发式文本")
    expect(context).toContain("- 写作时要避免：反模式文本")
    expect(context).toContain("【示例写法】")
    expect(context).toContain("小晴会先贴住当前场景和关系变化来行动")
  })

  it("renders preview fallback text for missing persisted aura fields", async () => {
    seedStore({
      customAuras: [
        {
          id: "custom-1",
          builtIn: false,
          name: "匿名",
          sourceNote: "",
        },
      ],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    const context = await buildCharacterAuraContext("/P", "写小晴", { previewMode: "writing" })
    expect(context).toContain("保持当前任务需要的角色状态，不额外偏离剧情目标。")
  })

  it("keeps punctuation-only preview fields when no sentence segment exists", async () => {
    seedStore({
      customAuras: [{ ...customAura(), expressionDna: "！！！" }],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })

    await expect(buildCharacterAuraContext("/P", "写小晴", { previewMode: "writing" })).resolves.toContain(
      "表达方式：！！！",
    )
  })

  it("drops bindings without a matching aura from the preview", async () => {
    seedStore({
      customAuras: [],
      bindings: [{ characterName: "小晴", auraId: "ghost" }],
    })
    expect(await buildCharacterAuraContext("/P", "小晴", { previewMode: "writing" })).toBe("")
  })

  it("includes compressed skill summaries when the aura has a skill folder", async () => {
    const skillFolder = "/P/.qmai/character-auras/custom-1-perspective"
    seedStore({
      customAuras: [customAura(skillFolder)],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith(STORE_PATH)) return JSON.stringify({
        customAuras: [customAura(skillFolder)],
        bindings: [{ characterName: "小晴", auraId: "custom-1" }],
      })
      if (path.endsWith("/SKILL.md")) return "---\nname: x\n---\n# 灵魂文档\n- 要点\n核心内容：价值"
      if (path.includes("/references/research/")) return "## 研究\n- 线索\n内容：详情"
      throw new Error("ENOENT")
    })
    const context = await buildCharacterAuraContext("/P", "小晴", {})
    expect(context).toContain("- 灵魂文档压缩摘要：")
    expect(context).toContain("- 研究文件压缩摘要：")
  })

  it("omits empty skill and research documents without treating them as read failures", async () => {
    const skillFolder = "/P/.qmai/character-auras/custom-1-perspective"
    seedStore({
      customAuras: [customAura(skillFolder)],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith(STORE_PATH)) return JSON.stringify({
        customAuras: [customAura(skillFolder)],
        bindings: [{ characterName: "小晴", auraId: "custom-1" }],
      })
      return ""
    })

    const context = await buildCharacterAuraContext("/P", "小晴", {})

    expect(context).not.toContain("灵魂文档压缩摘要")
    expect(context).not.toContain("研究文件压缩摘要")
    expect(context).not.toContain("灵魂文档读取失败")
  })

  it("falls back to structured fields when skill files cannot be read", async () => {
    const skillFolder = "/P/.qmai/character-auras/custom-1-perspective"
    seedStore({
      customAuras: [customAura(skillFolder)],
      bindings: [{ characterName: "小晴", auraId: "custom-1" }],
    })
    // store read works, every skill file read throws
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith(STORE_PATH)) return JSON.stringify({
        customAuras: [customAura(skillFolder)],
        bindings: [{ characterName: "小晴", auraId: "custom-1" }],
      })
      throw new Error("ENOENT")
    })
    const context = await buildCharacterAuraContext("/P", "小晴", {})
    expect(context).toContain("灵魂文档读取失败，已降级使用结构化灵魂字段。")
  })
})

describe("loadCharacterAuraSkillDocument / loadCharacterAuraResearchDocument", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
  })

  it("returns an empty string when the aura has no skill folder", async () => {
    expect(await loadCharacterAuraSkillDocument(customAura(undefined) as never)).toBe("")
    expect(await loadCharacterAuraResearchDocument(customAura(undefined) as never, "01-writings.md")).toBe("")
  })

  it("reads the skill document directly", async () => {
    fsMocks.readFile.mockResolvedValue("# SKILL")
    const out = await loadCharacterAuraSkillDocument(customAura("/s") as never)
    expect(out).toBe("# SKILL")
    expect(fsMocks.readFile).toHaveBeenCalledWith("/s/SKILL.md")
  })

  it("reads a research document directly", async () => {
    fsMocks.readFile.mockResolvedValue("# 研究")
    const out = await loadCharacterAuraResearchDocument(customAura("/s") as never, "02-conversations.md")
    expect(out).toBe("# 研究")
    expect(fsMocks.readFile).toHaveBeenCalledWith("/s/references/research/02-conversations.md")
  })

  it("falls back to the projectPath root when the direct read fails", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/P/skills/soulskill/li-bai-perspective/SKILL.md") return "# 回退内容"
      throw new Error("ENOENT")
    })
    const aura = {
      id: "builtin-li-bai",
      builtIn: true,
      name: "李白",
      sourceNote: "",
      corpus: "",
      styleDescription: "",
      behaviorRules: "",
      boundaries: "",
      notes: "",
      skillFolder: "skills/soulskill/li-bai-perspective",
    }
    const out = await loadCharacterAuraSkillDocument(aura, "/P")
    expect(out).toBe("# 回退内容")
  })

  it("rethrows the original error when every root fails", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("disk failure"))
    await expect(loadCharacterAuraSkillDocument(customAura("/s") as never, "/P")).rejects.toThrow("disk failure")
  })
})

describe("readSkillFileWithFallback Tauri root probing", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.getExecutableDir.mockReset()
    fsMocks.getResourceDir.mockReset()
    ;(isTauri as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  it("probes executable dir, _up_ dir, parent dir and resource dirs", async () => {
    fsMocks.getExecutableDir.mockResolvedValue("C:/apps/niko")
    fsMocks.getResourceDir.mockResolvedValue("C:/apps/niko/resources")
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "C:/apps/niko/resources/_up_/s/SKILL.md") return "# 资源命中"
      throw new Error("ENOENT")
    })
    const out = await loadCharacterAuraSkillDocument(customAura("/s") as never)
    expect(out).toBe("# 资源命中")
    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/apps/niko/_up_/s/SKILL.md")
    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/apps/niko/resources/_up_/s/SKILL.md")
  })

  it("handles root probe failures and rethrows after exhausting roots", async () => {
    fsMocks.getExecutableDir.mockRejectedValue(new Error("no exe"))
    fsMocks.getResourceDir.mockRejectedValue(new Error("no res"))
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    await expect(loadCharacterAuraSkillDocument(customAura("/s") as never)).rejects.toThrow("gone")
  })

  it("skips pushing the parent dir when it equals the exe dir", async () => {
    fsMocks.getExecutableDir.mockResolvedValue("C:/")
    fsMocks.getResourceDir.mockRejectedValue(new Error("no res"))
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    await expect(loadCharacterAuraSkillDocument(customAura("/s") as never)).rejects.toThrow("gone")
  })

  it("probes the tauri resourceDir API when fs resource dirs fail", async () => {
    fsMocks.getExecutableDir.mockRejectedValue(new Error("no exe"))
    fsMocks.getResourceDir.mockRejectedValue(new Error("no res"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "/resources/s/SKILL.md") return "# API 资源"
      throw new Error("ENOENT")
    })
    const out = await loadCharacterAuraSkillDocument(customAura("/s") as never)
    expect(out).toBe("# API 资源")
    expect(resourceDir).toHaveBeenCalled()
  })
})

describe("hasCharacterProfile", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    searchWikiMock.mockReset()
    loggerWarnMock.mockReset()
    listBindableMock.mockReset()
  })

  it("returns true when the character is already a bindable novel character", async () => {
    listBindableMock.mockResolvedValue(["小晴", "林动"])
    expect(await hasCharacterProfile("/P", "小晴")).toBe(true)
    expect(searchWikiMock).not.toHaveBeenCalled()
  })

  it("returns true when a wiki result title/snippet matches", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      {
        path: "/P/wiki/x.md",
        title: "小晴 人物小传",
        snippet: "小晴的完整人物设定",
        titleMatch: true,
        score: 1,
        images: [],
      },
    ])
    expect(await hasCharacterProfile("/P", "小晴")).toBe(true)
  })

  it("returns true when a wiki file content matches", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockResolvedValue("# 小晴 人物小传\n小晴的人物设定如下。")
    expect(await hasCharacterProfile("/P", "小晴")).toBe(true)
  })

  it("logs a warning and continues when a wiki file read fails", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await hasCharacterProfile("/P", "小晴")).toBe(false)
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Character Aura",
      "readFile failed for research file",
      expect.objectContaining({ error: "ENOENT" }),
    )
  })

  it("logs a string rejection from a wiki file read", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴", snippet: "", titleMatch: false, score: 1, images: [] },
    ])
    fsMocks.readFile.mockRejectedValue("raw read failure")

    await expect(hasCharacterProfile("/P", "小晴")).resolves.toBe(false)
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Character Aura",
      "readFile failed for research file",
      expect.objectContaining({ error: "raw read failure" }),
    )
  })

  it("returns false when nothing matches", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockResolvedValue([
      { path: "/P/wiki/x.md", title: "小晴的武功", snippet: "武学描述", titleMatch: false, score: 1, images: [] },
    ])
    expect(await hasCharacterProfile("/P", "小晴")).toBe(false)
  })

  it("propagates searchWiki failures", async () => {
    listBindableMock.mockResolvedValue([])
    searchWikiMock.mockRejectedValue(new Error("search down"))
    await expect(hasCharacterProfile("/P", "小晴")).rejects.toThrow("search down")
  })
})
