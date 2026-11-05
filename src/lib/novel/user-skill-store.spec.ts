/**
 * user-skill-store.ts 行为测试（替代 C4 空壳）。
 * 覆盖：配置归一化、技能 CRUD、分类 CRUD、linked 内容加载、落盘/加载 IO 全分支。
 * 零真实 IO：@/commands/fs + @tauri-apps/api/path.join 均 mock。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => [] as unknown[]),
  createDirectory: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    listDirectory: fsMocks.listDirectory,
    createDirectory: fsMocks.createDirectory,
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

const loggerWarnMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    logger: { warn: loggerWarnMock },
  }
})

import {
  USER_SKILL_CONFIG_FILE,
  normalizeUserSkillConfig,
  createBlankWritingSkill,
  importWritingSkill,
  loadLinkedSkillContent,
  loadAllLinkedSkillsContent,
  updateWritingSkill,
  touchSkillUsage,
  setWritingSkillEnabled,
  deleteWritingSkill,
  createSkillCategory,
  renameSkillCategory,
  deleteSkillCategory,
  reorderSkillCategories,
  moveSkillToCategory,
  resolveEnabledWritingSkills,
  loadUserSkillConfig,
  saveUserSkillConfig,
  ensureBuiltinSkills,
  exportSkillToJson,
  importSkillFromJson,
  WRITING_SKILL_KIND_OPTIONS,
  WRITING_SKILL_STAGE_OPTIONS,
  WRITING_SKILL_MODE_OPTIONS,
  type UserSkillConfig,
} from "./user-skill-store"
import { normalizeUserSkill, type UserSkill } from "./skill-library"
import { DEFAULT_BUILTIN_WRITING_SKILLS } from "./skill-seed"

function blankConfig(overrides: Partial<UserSkillConfig> = {}): UserSkillConfig {
  return normalizeUserSkillConfig({
    version: 1,
    selectedSkillId: null,
    disabledSkillIds: [],
    skills: [],
    categories: [],
    ...overrides,
  })
}

function rawSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "skill:1",
    name: "测试技能",
    description: "描述",
    kind: ["style"],
    stages: ["drafting"],
    modes: ["standard"],
    content: "技能正文",
    source: "uploaded",
    priority: 50,
    tags: [],
    categoryId: "",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.writeFileAtomic.mockReset()
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.listDirectory.mockReset()
  fsMocks.listDirectory.mockResolvedValue([])
  fsMocks.createDirectory.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  loggerWarnMock.mockClear()
})

describe("normalizeUserSkillConfig", () => {
  it("null/undefined 输入 → 空配置，selected 为 null", () => {
    const config = normalizeUserSkillConfig(null)
    expect(config).toEqual({
      version: 1,
      selectedSkillId: null,
      disabledSkillIds: [],
      skills: [],
      categories: [],
    })
    expect(normalizeUserSkillConfig(undefined).selectedSkillId).toBeNull()
  })

  it("非数组 skills/categories 按空处理", () => {
    const config = normalizeUserSkillConfig({ skills: "x", categories: 42 } as unknown as Partial<UserSkillConfig>)
    expect(config.skills).toEqual([])
    expect(config.categories).toEqual([])
  })

  it("过滤无效技能：无名、非 linked 空内容；linked 无内容保留", () => {
    const config = normalizeUserSkillConfig({
      skills: [
        rawSkill({ id: "s1" }),
        rawSkill({ id: "bad-noname", name: "   " }),
        rawSkill({ id: "bad-empty", content: "  " }),
        rawSkill({ id: "linked-ok", source: "linked", content: "", linkedPath: "p" }),
        { ...rawSkill({ id: "linked-undef" }), source: "linked", content: undefined, linkedPath: "q.md" },
        null,
        42,
        "junk",
      ],
      categories: [null, 7, { id: "c1", name: "好" }],
    } as unknown as Partial<UserSkillConfig>)
    expect(config.skills.map((s) => s.id).sort()).toEqual(["linked-ok", "linked-undef", "s1"])
    expect(config.skills.find((s) => s.id === "linked-undef")!.content).toBe("")
    expect(config.categories.map((c) => c.id)).toEqual(["c1"])
  })

  it("未知 source 归一为 uploaded", () => {
    const config = normalizeUserSkillConfig({ skills: [rawSkill({ source: "project" })] } as unknown as Partial<UserSkillConfig>)
    expect(config.skills[0].source).toBe("uploaded")
  })

  it("按 id 去重（首见获胜），分类按 id 去重", () => {
    const config = normalizeUserSkillConfig({
      skills: [rawSkill({ id: "dup", name: "First" }), rawSkill({ id: "dup", name: "Second" })],
      categories: [
        { id: "c1", name: "A" },
        { id: "c1", name: "B" },
        { id: "", name: "坏" },
        { id: "c2", name: "  " },
      ],
    } as unknown as Partial<UserSkillConfig>)
    expect(config.skills).toHaveLength(1)
    expect(config.skills[0].name).toBe("First")
    expect(config.categories.map((c) => c.id)).toEqual(["c1"])
  })

  it("categoryId 不在分类集合中 → 置空；合法则保留", () => {
    const config = normalizeUserSkillConfig({
      skills: [rawSkill({ id: "s1", categoryId: "nope" }), rawSkill({ id: "s2", categoryId: "c1" })],
      categories: [{ id: "c1", name: "分类一" }],
    } as unknown as Partial<UserSkillConfig>)
    expect(config.skills.find((s) => s.id === "s1")!.categoryId).toBe("")
    expect(config.skills.find((s) => s.id === "s2")!.categoryId).toBe("c1")
  })

  it("selectedSkillId：合法保留、非法回退首个、空技能回退 null", () => {
    const two = {
      skills: [rawSkill({ id: "a" }), rawSkill({ id: "b" })],
      categories: [],
    } as unknown as Partial<UserSkillConfig>
    expect(normalizeUserSkillConfig({ ...two, selectedSkillId: "b" } as object).selectedSkillId).toBe("b")
    expect(normalizeUserSkillConfig({ ...two, selectedSkillId: "ghost" } as object).selectedSkillId).toBe("a")
    expect(normalizeUserSkillConfig({ ...two, selectedSkillId: 123 } as object).selectedSkillId).toBe("a")
  })

  it("disabledSkillIds 去重修整：去空格、去重、丢弃非字符串", () => {
    const config = normalizeUserSkillConfig({
      disabledSkillIds: [" a ", "a", "", 1, null, "b"] as unknown as string[],
    } as Partial<UserSkillConfig>)
    expect(config.disabledSkillIds).toEqual(["a", "b"])
    expect(normalizeUserSkillConfig({ disabledSkillIds: "nope" } as unknown as Partial<UserSkillConfig>).disabledSkillIds).toEqual([])
  })

  it("分类 createdAt/updatedAt 仅数字保留", () => {
    const config = normalizeUserSkillConfig({
      categories: [{ id: "c1", name: " 名称 ", createdAt: "x", updatedAt: 5 }],
    } as unknown as Partial<UserSkillConfig>)
    expect(config.categories[0]).toEqual({ id: "c1", name: "名称", createdAt: undefined, updatedAt: 5 })
  })
})

describe("createBlankWritingSkill / importWritingSkill", () => {
  it("新建空白技能：id 含 now、前置、选中、内容为模板", () => {
    const next = createBlankWritingSkill(blankConfig(), 1700000000000)
    expect(next.skills[0].id).toBe("skill:1700000000000")
    expect(next.selectedSkillId).toBe("skill:1700000000000")
    expect(next.skills[0].name).toBe("新建写作技能")
    expect(next.skills[0].content).toContain("# 写作 Skill")
  })

  it("导入空白名/空白内容 → 返回同一引用", () => {
    const config = blankConfig()
    expect(importWritingSkill(config, { name: "  ", content: "x" }, 1)).toBe(config)
    expect(importWritingSkill(config, { name: "n", content: "   " }, 1)).toBe(config)
  })

  it("导入合法：修整、前置、选中", () => {
    const next = importWritingSkill(blankConfig(), { name: " 导入 ", content: " 正文 ", description: " d " }, 2000)
    expect(next.skills[0].id).toBe("skill:2000")
    expect(next.skills[0].name).toBe("导入")
    expect(next.skills[0].content).toBe("正文")
    expect(next.selectedSkillId).toBe("skill:2000")
    const noDesc = importWritingSkill(blankConfig(), { name: "n", content: "c" }, 2001)
    expect(noDesc.skills[0].description).toBe("")
  })
})

describe("updateWritingSkill / touchSkillUsage", () => {
  it("更新字段并刷新 updatedAt，保持 id 与 source", () => {
    const config = blankConfig({ skills: [rawSkill({ id: "s1", source: "uploaded" }), rawSkill({ id: "s2", name: "不动" })] } as unknown as Partial<UserSkillConfig>)
    const next = updateWritingSkill(config, "s1", { name: "新名" }, 9999)
    const skill = next.skills.find((s) => s.id === "s1")!
    expect(skill.name).toBe("新名")
    expect(skill.source).toBe("uploaded")
    expect(skill.updatedAt).toBe(9999)
    expect(next.skills.find((s) => s.id === "s2")!.name).toBe("不动")
  })

  it("touch：built-in 与未知 id 返回同一引用；普通技能刷新 updatedAt", () => {
    const builtinId = DEFAULT_BUILTIN_WRITING_SKILLS[0].id
    const config = ensureBuiltinSkills(blankConfig())
    expect(touchSkillUsage(config, builtinId, 5)).toBe(config)
    expect(touchSkillUsage(config, "ghost", 5)).toBe(config)

    const custom = blankConfig({ skills: [rawSkill({ id: "s1", updatedAt: 1 }), rawSkill({ id: "s2", updatedAt: 1 })] } as unknown as Partial<UserSkillConfig>)
    const next = touchSkillUsage(custom, "s1", 7777)
    expect(next.skills.find((s) => s.id === "s1")!.updatedAt).toBe(7777)
    expect(next.skills.find((s) => s.id === "s2")!.updatedAt).toBe(1)
  })
})

describe("setWritingSkillEnabled / deleteWritingSkill", () => {
  it("禁用追加（去重）、启用移除", () => {
    const config = blankConfig()
    const disabled = setWritingSkillEnabled(config, "s1", false)
    expect(disabled.disabledSkillIds).toEqual(["s1"])
    expect(setWritingSkillEnabled(disabled, "s1", false).disabledSkillIds).toEqual(["s1"])
    expect(setWritingSkillEnabled(disabled, "s1", true).disabledSkillIds).toEqual([])
  })

  it("删除 built-in 返回同一引用", () => {
    const config = ensureBuiltinSkills(blankConfig())
    const builtinId = DEFAULT_BUILTIN_WRITING_SKILLS[0].id
    expect(deleteWritingSkill(config, builtinId)).toBe(config)
  })

  it("删除技能：清理 disabled，被删选中项回退到首个；删光则 null", () => {
    const config = blankConfig({
      skills: [rawSkill({ id: "a" }), rawSkill({ id: "b" })],
      selectedSkillId: "b",
      disabledSkillIds: ["b", "keep"],
    } as unknown as Partial<UserSkillConfig>)
    const next = deleteWritingSkill(config, "b")
    expect(next.skills.map((s) => s.id)).toEqual(["a"])
    expect(next.selectedSkillId).toBe("a")
    expect(next.disabledSkillIds).toEqual(["keep"])

    const single = blankConfig({
      skills: [rawSkill({ id: "only" })],
      selectedSkillId: "only",
    } as unknown as Partial<UserSkillConfig>)
    expect(deleteWritingSkill(single, "only").selectedSkillId).toBeNull()
  })

  it("删除非选中技能保持选中不变", () => {
    const config = blankConfig({
      skills: [rawSkill({ id: "a" }), rawSkill({ id: "b" })],
      selectedSkillId: "a",
    } as unknown as Partial<UserSkillConfig>)
    expect(deleteWritingSkill(config, "b").selectedSkillId).toBe("a")
  })
})

describe("分类 CRUD / 排序 / 移动", () => {
  it("创建：空白名返回同一引用；合法追加 cat:now", () => {
    const config = blankConfig()
    expect(createSkillCategory(config, "   ", 1)).toBe(config)
    const next = createSkillCategory(config, " 悬念 ", 3000)
    expect(next.categories).toHaveLength(1)
    expect(next.categories[0]).toMatchObject({ id: "cat:3000", name: "悬念" })
  })

  it("重命名：空白名返回同一引用；合法改名并刷新 updatedAt", () => {
    const config = blankConfig({ categories: [{ id: "c1", name: "旧" }, { id: "c2", name: "他" }] } as unknown as Partial<UserSkillConfig>)
    expect(renameSkillCategory(config, "c1", "  ", 1)).toBe(config)
    const next = renameSkillCategory(config, "c1", " 新 ", 4000)
    expect(next.categories[0]).toMatchObject({ name: "新", updatedAt: 4000 })
    expect(next.categories[1].name).toBe("他")
  })

  it("删除分类：同步清空技能引用", () => {
    const config = blankConfig({
      skills: [rawSkill({ id: "s1", categoryId: "c1" }), rawSkill({ id: "s2", categoryId: "c2" })],
      categories: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }],
    } as unknown as Partial<UserSkillConfig>)
    const next = deleteSkillCategory(config, "c1")
    expect(next.categories.map((c) => c.id)).toEqual(["c2"])
    expect(next.skills.find((s) => s.id === "s1")!.categoryId).toBe("")
    expect(next.skills.find((s) => s.id === "s2")!.categoryId).toBe("c2")
  })

  it("排序：0→2 后顺序为 b,c,a；原地不动保持顺序", () => {
    const config = blankConfig({
      categories: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
    } as unknown as Partial<UserSkillConfig>)
    expect(reorderSkillCategories(config, 0, 2).categories.map((c) => c.id)).toEqual(["b", "c", "a"])
    expect(reorderSkillCategories(config, 1, 1).categories.map((c) => c.id)).toEqual(["a", "b", "c"])
  })

  it("移动技能到已知分类保留、未知分类归一为空", () => {
    const config = blankConfig({
      skills: [rawSkill({ id: "s1" }), rawSkill({ id: "s2" })],
      categories: [{ id: "c1", name: "A" }],
    } as unknown as Partial<UserSkillConfig>)
    const moved = moveSkillToCategory(config, "s1", "c1")
    expect(moved.skills.find((s) => s.id === "s1")!.categoryId).toBe("c1")
    expect(moved.skills.find((s) => s.id === "s2")!.categoryId).toBe("")
    expect(moveSkillToCategory(config, "s1", "ghost").skills[0].categoryId).toBe("")
  })
})

describe("resolveEnabledWritingSkills", () => {
  it("过滤 disabled 列表中的技能", () => {
    const config = blankConfig({
      skills: [rawSkill({ id: "a" }), rawSkill({ id: "b" })],
      disabledSkillIds: ["b"],
    } as unknown as Partial<UserSkillConfig>)
    expect(resolveEnabledWritingSkills(config).map((s) => s.id)).toEqual(["a"])
  })
})

describe("loadLinkedSkillContent", () => {
  function linkedSkill(overrides: Partial<UserSkill> = {}): UserSkill {
    return {
      id: "skill:9",
      name: "外链",
      description: "",
      kind: ["style"],
      stages: ["drafting"],
      modes: ["standard"],
      content: "旧内容",
      source: "linked",
      linkedPath: "proj/skills/foo",
      priority: 50,
      tags: [],
      categoryId: "",
      ...overrides,
    }
  }

  it("非 linked 直接返回 content 且零 IO", async () => {
    const skill = linkedSkill({ source: "uploaded", content: "正文" })
    await expect(loadLinkedSkillContent(skill)).resolves.toBe("正文")
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("linked 但无 linkedPath 直接返回 content", async () => {
    const skill = linkedSkill({ linkedPath: undefined })
    await expect(loadLinkedSkillContent(skill)).resolves.toBe("旧内容")
  })

  it("linked 文件路径（大小写后缀 .MD/.txt/.json）直接读文件", async () => {
    fsMocks.readFile.mockResolvedValue("文件内容")
    await expect(loadLinkedSkillContent(linkedSkill({ linkedPath: "x/y.MD" }))).resolves.toBe("文件内容")
    await expect(loadLinkedSkillContent(linkedSkill({ linkedPath: "x/y.txt" }))).resolves.toBe("文件内容")
    await expect(loadLinkedSkillContent(linkedSkill({ linkedPath: "x/y.json" }))).resolves.toBe("文件内容")
    expect(fsMocks.readFile).toHaveBeenCalledWith("x/y.json")
  })

  it("linked 目录：SKILL.md + docs/*.md 合并，跳过目录与非 md", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/skills/foo/SKILL.md") return "BASE"
      if (p === "proj/skills/foo/docs/a.md") return "DOC-A"
      throw new Error("missing")
    })
    fsMocks.listDirectory.mockResolvedValue([
      { name: "a.md", path: "proj/skills/foo/docs/a.md", is_dir: false },
      { name: "note.txt", path: "proj/skills/foo/docs/note.txt", is_dir: false },
      { name: "sub", path: "proj/skills/foo/docs/sub", is_dir: true },
    ])
    const content = await loadLinkedSkillContent(linkedSkill())
    expect(content).toContain("BASE")
    expect(content).toContain("DOC-A")
    expect(content).toContain("# 附加文档")
  })

  it("docs 目录缺失仅返回 SKILL.md 且记 warn", async () => {
    fsMocks.readFile.mockResolvedValue("BASE")
    fsMocks.listDirectory.mockRejectedValue(new Error("no docs"))
    await expect(loadLinkedSkillContent(linkedSkill())).resolves.toBe("BASE")
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it("附加文档全部读取失败 → 仅返回 SKILL.md 且记 warn", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/skills/foo/SKILL.md") return "BASE"
      throw new Error("bad doc")
    })
    fsMocks.listDirectory.mockResolvedValue([
      { name: "bad.md", path: "proj/skills/foo/docs/bad.md", is_dir: false },
    ])
    await expect(loadLinkedSkillContent(linkedSkill({
      id: "skill:9",
      name: "外链",
      description: "",
      kind: ["style"],
      stages: ["drafting"],
      modes: ["standard"],
      content: "旧内容",
      source: "linked",
      linkedPath: "proj/skills/foo",
      priority: 50,
      tags: [],
      categoryId: "",
    }))).resolves.toBe("BASE")
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it("单个附加文档读取失败被跳过且记 warn", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/skills/foo/SKILL.md") return "BASE"
      if (p === "proj/skills/foo/docs/good.md") return "GOOD"
      throw new Error("bad doc")
    })
    fsMocks.listDirectory.mockResolvedValue([
      { name: "good.md", path: "proj/skills/foo/docs/good.md", is_dir: false },
      { name: "bad.md", path: "proj/skills/foo/docs/bad.md", is_dir: false },
    ])
    const content = await loadLinkedSkillContent(linkedSkill())
    expect(content).toContain("GOOD")
    expect(content).not.toContain("bad")
    expect(loggerWarnMock).toHaveBeenCalled()
  })

  it("SKILL.md 读取失败 → 空字符串", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    await expect(loadLinkedSkillContent(linkedSkill())).resolves.toBe("")
  })

  it("docs 为空时不追加附加文档段", async () => {
    fsMocks.readFile.mockResolvedValue("BASE")
    fsMocks.listDirectory.mockResolvedValue([])
    await expect(loadLinkedSkillContent(linkedSkill())).resolves.toBe("BASE")
  })
})

describe("loadAllLinkedSkillsContent", () => {
  it("无 linked 技能返回同一引用", async () => {
    const config = blankConfig({ skills: [rawSkill({ id: "s1" })] } as unknown as Partial<UserSkillConfig>)
    await expect(loadAllLinkedSkillsContent(config)).resolves.toBe(config)
  })

  it("批量加载 linked 内容，非 linked 保持不变", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => `内容:${p}`)
    const config = blankConfig({
      skills: [
        rawSkill({ id: "plain", source: "uploaded", content: "本地" }),
        { ...rawSkill({ id: "l1" }), source: "linked", linkedPath: "a.md", content: "旧" },
        { ...rawSkill({ id: "l2" }), source: "linked", linkedPath: "b.md", content: "旧" },
      ],
    } as unknown as Partial<UserSkillConfig>)
    const next = await loadAllLinkedSkillsContent(config)
    expect(next.skills.find((s) => s.id === "plain")!.content).toBe("本地")
    expect(next.skills.find((s) => s.id === "l1")!.content).toBe("内容:a.md")
    expect(next.skills.find((s) => s.id === "l2")!.content).toBe("内容:b.md")
  })
})

describe("loadUserSkillConfig", () => {
  it("projectPath 为空 → 空白+内置技能+默认分类", async () => {
    const config = await loadUserSkillConfig(null)
    expect(config.version).toBe(1)
    expect(config.skills).toHaveLength(DEFAULT_BUILTIN_WRITING_SKILLS.length)
    expect(config.categories).toHaveLength(9)
    expect(config.selectedSkillId).toBe(DEFAULT_BUILTIN_WRITING_SKILLS[0].id)
    await expect(loadUserSkillConfig(undefined)).resolves.toMatchObject({ version: 1 })
  })

  it("新路径合法 JSON：解析自定义技能并补齐内置", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/.niko-buddy/writing-skills.json") {
        return JSON.stringify({ skills: [rawSkill({ id: "mine" })], categories: [] })
      }
      throw new Error("missing")
    })
    const config = await loadUserSkillConfig("proj")
    expect(config.skills.some((s) => s.id === "mine")).toBe(true)
    expect(config.skills.some((s) => s.id === DEFAULT_BUILTIN_WRITING_SKILLS[0].id)).toBe(true)
  })

  it("新路径缺失 + 旧路径存在 → 惰性迁移并落盘", async () => {
    const legacy = JSON.stringify({ skills: [rawSkill({ id: "legacy-one" })], categories: [] })
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/writing-skills.json") return legacy
      throw new Error("missing new")
    })
    const config = await loadUserSkillConfig("proj")
    expect(config.skills.some((s) => s.id === "legacy-one")).toBe(true)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("proj/.niko-buddy")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, text] = fsMocks.writeFileAtomic.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("proj/.niko-buddy/writing-skills.json")
    expect(JSON.parse(text as string).skills.some((s: { id: string }) => s.id === "legacy-one")).toBe(true)
  })

  it("迁移写失败不阻断：仍返回旧配置", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/writing-skills.json") return JSON.stringify({ skills: [rawSkill({ id: "legacy-one" })] })
      throw new Error("missing new")
    })
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    const config = await loadUserSkillConfig("proj")
    expect(config.skills.some((s) => s.id === "legacy-one")).toBe(true)
  })

  it("新旧路径均失败 → 空白+内置", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("gone"))
    const config = await loadUserSkillConfig("proj")
    expect(config.skills).toHaveLength(DEFAULT_BUILTIN_WRITING_SKILLS.length)
  })

  it("新路径 JSON 损坏 → 回退旧路径/空白（不抛）", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p === "proj/.niko-buddy/writing-skills.json") return "{broken"
      throw new Error("missing legacy")
    })
    const config = await loadUserSkillConfig("proj")
    expect(config.skills).toHaveLength(DEFAULT_BUILTIN_WRITING_SKILLS.length)
  })
})

describe("saveUserSkillConfig", () => {
  it("创建目录并写入归一化 JSON", async () => {
    const config = blankConfig({ skills: [rawSkill({ id: "s1" })] } as unknown as Partial<UserSkillConfig>)
    await saveUserSkillConfig("proj", config)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("proj/.niko-buddy")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, text] = fsMocks.writeFileAtomic.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("proj/.niko-buddy/writing-skills.json")
    const parsed = JSON.parse(text as string)
    expect(parsed.version).toBe(1)
    expect(parsed.skills).toHaveLength(1)
  })

  it("目录已存在（创建失败）仍继续写入", async () => {
    fsMocks.createDirectory.mockRejectedValue(new Error("exists"))
    await saveUserSkillConfig("proj", blankConfig())
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })
})

describe("ensureBuiltinSkills", () => {
  it("空配置补齐全部内置与 9 个默认分类", () => {
    const next = ensureBuiltinSkills(blankConfig())
    expect(next.skills).toHaveLength(DEFAULT_BUILTIN_WRITING_SKILLS.length)
    expect(next.categories).toHaveLength(9)
    expect(next.skills.every((s) => s.source === "built-in")).toBe(true)
  })

  it("缺失单个内置会被补回，自定义技能保留", () => {
    const withoutOne = ensureBuiltinSkills(blankConfig())
    const dropped = {
      ...withoutOne,
      skills: [...withoutOne.skills.slice(1), rawSkill({ id: "mine", source: "uploaded" }) as unknown as UserSkill],
    }
    const next = ensureBuiltinSkills(dropped)
    expect(next.skills.some((s) => s.id === "mine")).toBe(true)
    expect(next.skills).toHaveLength(DEFAULT_BUILTIN_WRITING_SKILLS.length + 1)
  })

  it("已带合法分类的内置技能保持原分类", () => {
    const seeded = normalizeUserSkill({
      id: DEFAULT_BUILTIN_WRITING_SKILLS[0].id,
      name: "章节承接",
      description: "d",
      content: "c",
      source: "built-in",
      categoryId: "skill-category:writing",
    })
    const next = ensureBuiltinSkills(
      blankConfig({
        skills: [seeded],
        categories: [{ id: "skill-category:writing", name: "正文" }],
      } as unknown as Partial<UserSkillConfig>),
    )
    expect(next.skills.find((s) => s.id === seeded.id)!.categoryId).toBe("skill-category:writing")
  })

  it("自定义同名默认分类不重复追加", () => {
    const next = ensureBuiltinSkills(
      blankConfig({ categories: [{ id: "skill-category:writing", name: "自定义正文" }] } as unknown as Partial<UserSkillConfig>),
    )
    expect(next.categories.filter((c) => c.id === "skill-category:writing")).toHaveLength(1)
    expect(next.categories).toHaveLength(9)
  })
})

describe("exportSkillToJson / importSkillFromJson", () => {
  it("导出携带标记与字段", () => {
    const skill = normalizeUserSkillConfig({ skills: [rawSkill({ id: "s1" })] } as unknown as Partial<UserSkillConfig>).skills[0]
    const parsed = JSON.parse(exportSkillToJson(skill))
    expect(parsed["niko-buddy-skill"]).toBe(true)
    expect(parsed.version).toBe(1)
    expect(parsed.name).toBe("测试技能")
    expect(parsed.content).toBe("技能正文")
  })

  it("导出→导入往返", () => {
    const skill = normalizeUserSkillConfig({ skills: [rawSkill({ id: "s1" })] } as unknown as Partial<UserSkillConfig>).skills[0]
    const back = importSkillFromJson(exportSkillToJson(skill))
    expect(back).not.toBeNull()
    expect(back!.name).toBe("测试技能")
    expect(back!.content).toBe("技能正文")
    expect(back!.source).toBe("uploaded")
  })

  it("非法输入返回 null", () => {
    expect(importSkillFromJson("not json")).toBeNull()
    expect(importSkillFromJson("null")).toBeNull()
    expect(importSkillFromJson(JSON.stringify([1, 2]))).toBeNull()
    expect(importSkillFromJson(JSON.stringify({}))).toBeNull()
    expect(importSkillFromJson(JSON.stringify({ name: "n" }))).toBeNull()
    expect(importSkillFromJson(JSON.stringify({ name: "  ", content: "c" }))).toBeNull()
    expect(importSkillFromJson(JSON.stringify({ name: "n", content: "  " }))).toBeNull()
  })

  it("缺失 kind/stages/modes 时用 skill-library 默认", () => {
    const bare = importSkillFromJson(JSON.stringify({ name: "n", content: "c" }))
    expect(bare).not.toBeNull()
    expect(bare!.kind).toEqual(["style"])
    expect(bare!.stages).toEqual(["rewrite", "output"])
    expect(bare!.modes).toEqual(["standard", "strict"])
  })

  it("缺失可选字段时用默认值（kind 回退、priority/tags 归一）", () => {
    const back = importSkillFromJson(JSON.stringify({ name: "n", content: "c", kind: ["bogus"], priority: "x", tags: "y" }))
    expect(back).not.toBeNull()
    expect(back!.kind).toEqual(["style"])
    expect(back!.priority).toBe(50)
    expect(back!.tags).toEqual([])
    expect(back!.description).toBe("")
  })
})

describe("选项常量", () => {
  it("USER_SKILL_CONFIG_FILE 与三组选项非空且含预期值", () => {
    expect(USER_SKILL_CONFIG_FILE).toBe(".niko-buddy/writing-skills.json")
    expect(WRITING_SKILL_KIND_OPTIONS).toContain("style")
    expect(WRITING_SKILL_STAGE_OPTIONS).toContain("planning")
    expect(WRITING_SKILL_MODE_OPTIONS).toEqual(["fast", "standard", "strict"])
  })
})
