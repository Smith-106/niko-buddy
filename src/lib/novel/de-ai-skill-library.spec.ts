/** de-ai-skill-library 真实行为测试（替代 C4 空壳：逐函数断言行为）。 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  DEFAULT_DE_AI_SKILL_ID,
  isDeAiSkillConfigCorruptError,
  BUILT_IN_DE_AI_SKILLS,
  normalizeDeAiSkillConfig,
  getAllDeAiSkills,
  resolveAvailableDeAiSkills,
  resolveEffectiveDeAiSkill,
  deAiSkillToUserSkill,
  loadEffectiveDeAiSkillSafely,
  isDeAiSkillModified,
  createBlankProjectDeAiSkill,
  updateProjectDeAiSkill,
  updateDeAiSkill,
  resetBuiltInDeAiSkill,
  setDefaultDeAiSkill,
  setLastChapterDeAiSkill,
  setDeAiSkillEnabled,
  deleteProjectDeAiSkill,
  loadDeAiSkillConfig,
  saveDeAiSkillConfig,
  restoreDeAiSkillConfigFromBackup,
  recreateDeAiSkillConfig,
} from "./de-ai-skill-library"
import type { DeAiSkill, DeAiSkillConfig } from "./de-ai-skill-library"
import { DEFAULT_SKILL_PRIORITY } from "./skill-library"
import { readFile, writeFile, writeFileAtomic, createDirectory } from "@/commands/fs"
import { join } from "@tauri-apps/api/path"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    createDirectory: vi.fn(),
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

const P = "P"
const CONFIG_PATH = "P/.niko-buddy/de-ai-skills.json"
const LEGACY_ROOT_PATH = "P/de-ai-skills.json"
const LEGACY_TXT_PATH = "P/de-ai-skill.txt"

function mockFiles(files: Record<string, string>): void {
  vi.mocked(readFile).mockImplementation(async (p: string) => {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]
    throw new Error(`ENOENT: ${p}`)
  })
}

function blankConfig(): DeAiSkillConfig {
  return normalizeDeAiSkillConfig(null)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFiles({})
  vi.mocked(createDirectory).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(writeFileAtomic).mockResolvedValue(undefined)
})

describe("normalizeDeAiSkillConfig", () => {
  it("null/非对象输入返回全默认配置", () => {
    expect(normalizeDeAiSkillConfig(null)).toEqual({
      version: 1,
      defaultSkillId: DEFAULT_DE_AI_SKILL_ID,
      disabledSkillIds: [],
      projectSkills: [],
      builtInSkillOverrides: [],
      lastChapterDeAiSkillId: null,
    })
    expect(normalizeDeAiSkillConfig("nope" as unknown as null)).toEqual(blankConfig())
  })

  it("未知 defaultSkillId 回退到综合技能", () => {
    expect(normalizeDeAiSkillConfig({ defaultSkillId: "nope" }).defaultSkillId).toBe(
      DEFAULT_DE_AI_SKILL_ID,
    )
    expect(normalizeDeAiSkillConfig({ defaultSkillId: "project:ghost" }).defaultSkillId).toBe(
      DEFAULT_DE_AI_SKILL_ID,
    )
  })

  it("disabled 不改变 normalize 阶段的 default（由 setDeAiSkillEnabled 收敛）", () => {
    const cfg = normalizeDeAiSkillConfig({
      defaultSkillId: "built-in:comprehensive",
      disabledSkillIds: ["built-in:comprehensive"],
    })
    expect(cfg.defaultSkillId).toBe("built-in:comprehensive")
    expect(cfg.disabledSkillIds).toEqual(["built-in:comprehensive"])
  })

  it("lastChapter 未知或被禁用时为 null，合法时保留", () => {
    expect(normalizeDeAiSkillConfig({ lastChapterDeAiSkillId: "nope" }).lastChapterDeAiSkillId).toBeNull()
    expect(
      normalizeDeAiSkillConfig({
        lastChapterDeAiSkillId: "built-in:comprehensive",
        disabledSkillIds: ["built-in:comprehensive"],
      }).lastChapterDeAiSkillId,
    ).toBeNull()
    expect(
      normalizeDeAiSkillConfig({ lastChapterDeAiSkillId: "built-in:comprehensive" })
        .lastChapterDeAiSkillId,
    ).toBe("built-in:comprehensive")
  })

  it("disabledSkillIds 去重修整，非数组归空", () => {
    expect(
      normalizeDeAiSkillConfig({ disabledSkillIds: [" b ", "b", "", 1, null, "a"] }).disabledSkillIds,
    ).toEqual(["b", "a"])
    expect(normalizeDeAiSkillConfig({ disabledSkillIds: "x" }).disabledSkillIds).toEqual([])
  })

  it("projectSkills 过滤非法条目并补全字段", () => {
    const cfg = normalizeDeAiSkillConfig({
      defaultSkillId: "project:keep",
      projectSkills: [
        null,
        42,
        { junk: true },
        { name: "", content: "x" },
        { name: "N", content: "" },
        { id: "project:keep", name: "  Keep  ", content: " C " },
        { id: "legacy:old", name: "Old", content: "C", source: "legacy" },
        { id: "weird", name: "W", content: "C" },
      ],
    })
    expect(cfg.projectSkills).toHaveLength(3)
    const [keep, legacy, generated] = cfg.projectSkills
    expect(keep.id).toBe("project:keep")
    expect(keep.name).toBe("Keep")
    expect(keep.content).toBe("C")
    expect(keep.source).toBe("project")
    expect(keep.templateId).toBe("custom")
    expect(legacy.id).toBe("legacy:old")
    expect(legacy.source).toBe("legacy")
    expect(generated.id.startsWith("project:")).toBe(true)
    expect(typeof generated.createdAt).toBe("number")
  })

  it("built-in overrides 未知 id 丢弃、空覆盖回退基线、同 id 去重", () => {
    const cfg = normalizeDeAiSkillConfig({
      builtInSkillOverrides: [
        null,
        { id: "built-in:nope", name: "X", content: "Y" },
        { id: "built-in:comprehensive", name: "  X  ", content: "  Y  " },
        { id: "built-in:comprehensive", name: "X2", content: "Y2" },
      ],
    })
    expect(cfg.builtInSkillOverrides).toHaveLength(1)
    expect(cfg.builtInSkillOverrides[0]).toMatchObject({
      id: "built-in:comprehensive",
      name: "X",
      content: "Y",
      source: "built-in",
    })
    const blank = normalizeDeAiSkillConfig({
      builtInSkillOverrides: [{ id: "built-in:comprehensive", name: "", content: "" }],
    })
    const base = BUILT_IN_DE_AI_SKILLS[0]
    expect(blank.builtInSkillOverrides[0].name).toBe(base.name)
    expect(blank.builtInSkillOverrides[0].content).toBe(base.content)
  })

  it("内置 5 技能 id 集合符合预期", () => {
    expect(BUILT_IN_DE_AI_SKILLS.map((s) => s.id)).toEqual([
      "built-in:comprehensive",
      "built-in:reduce-explanation",
      "built-in:dialogue-natural",
      "built-in:break-regularity",
      "built-in:literary-retain",
    ])
    expect(DEFAULT_DE_AI_SKILL_ID).toBe("built-in:comprehensive")
  })
})

describe("getAllDeAiSkills / resolveAvailableDeAiSkills / resolveEffectiveDeAiSkill", () => {
  it("项目技能在前，override 原位替换内置", () => {
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [{ id: "project:p1", name: "P1", content: "C" }],
      builtInSkillOverrides: [{ id: "built-in:comprehensive", name: "改", content: "NC" }],
    })
    const all = getAllDeAiSkills(cfg)
    expect(all.map((s) => s.id)).toEqual([
      "project:p1",
      "built-in:comprehensive",
      "built-in:reduce-explanation",
      "built-in:dialogue-natural",
      "built-in:break-regularity",
      "built-in:literary-retain",
    ])
    expect(all[1].name).toBe("改")
  })

  it("resolveAvailableDeAiSkills 排除禁用", () => {
    const cfg = normalizeDeAiSkillConfig({ disabledSkillIds: ["built-in:comprehensive"] })
    const ids = resolveAvailableDeAiSkills(cfg).map((s) => s.id)
    expect(ids).not.toContain("built-in:comprehensive")
    expect(ids).toHaveLength(4)
  })

  it("resolveEffectiveDeAiSkill：null 显式关闭，缺省走默认，未知回退首个", () => {
    const cfg = blankConfig()
    expect(resolveEffectiveDeAiSkill(cfg, null)).toBeNull()
    expect(resolveEffectiveDeAiSkill(cfg)?.id).toBe(DEFAULT_DE_AI_SKILL_ID)
    expect(resolveEffectiveDeAiSkill(cfg, "nope")?.id).toBe(DEFAULT_DE_AI_SKILL_ID)
    expect(resolveEffectiveDeAiSkill(cfg, "built-in:dialogue-natural")?.id).toBe(
      "built-in:dialogue-natural",
    )
  })

  it("全部禁用时返回 null（默认也被禁用则回退首个可用）", () => {
    const allDisabled = normalizeDeAiSkillConfig({
      disabledSkillIds: BUILT_IN_DE_AI_SKILLS.map((s) => s.id),
    })
    expect(resolveEffectiveDeAiSkill(allDisabled)).toBeNull()
    const defaultDisabled = normalizeDeAiSkillConfig({
      disabledSkillIds: [DEFAULT_DE_AI_SKILL_ID],
    })
    expect(resolveEffectiveDeAiSkill(defaultDisabled)?.id).toBe("built-in:reduce-explanation")
  })
})

describe("deAiSkillToUserSkill", () => {
  it("内置技能映射 kind/stages/modes/priority", () => {
    const user = deAiSkillToUserSkill(BUILT_IN_DE_AI_SKILLS[0])
    expect(user).toMatchObject({
      id: "built-in:comprehensive",
      kind: ["style"],
      stages: ["rewrite", "output"],
      modes: ["fast", "standard", "strict"],
      source: "built-in",
      priority: DEFAULT_SKILL_PRIORITY,
      tags: [],
      categoryId: "",
    })
  })

  it("legacy 来源归一为 project", () => {
    const skill: DeAiSkill = {
      id: "legacy:old",
      name: "Old",
      description: "",
      templateId: "legacy",
      content: "C",
      source: "legacy",
    }
    expect(deAiSkillToUserSkill(skill).source).toBe("project")
  })
})

describe("isDeAiSkillConfigCorruptError", () => {
  it("消息前缀匹配即损坏（含类实例与普通 Error）", async () => {
    mockFiles({ [CONFIG_PATH]: "{bad json" })
    const err = await loadDeAiSkillConfig(P).catch((e: unknown) => e)
    expect(isDeAiSkillConfigCorruptError(err)).toBe(true)
    expect(isDeAiSkillConfigCorruptError(new Error("技能库配置文件损坏：x"))).toBe(true)
  })

  it("其它错误/非错误一律 false", () => {
    expect(isDeAiSkillConfigCorruptError(new Error("io fail"))).toBe(false)
    expect(isDeAiSkillConfigCorruptError(null)).toBe(false)
    expect(isDeAiSkillConfigCorruptError("技能库配置文件损坏")).toBe(false)
  })
})

describe("isDeAiSkillModified", () => {
  it("内置：有 override 即改过", () => {
    const cfg = normalizeDeAiSkillConfig({
      builtInSkillOverrides: [{ id: "built-in:comprehensive", name: "X", content: "Y" }],
    })
    expect(isDeAiSkillModified(cfg, "built-in:comprehensive")).toBe(true)
    expect(isDeAiSkillModified(cfg, "built-in:reduce-explanation")).toBe(false)
    expect(isDeAiSkillModified(cfg, "built-in:nope")).toBe(false)
  })

  it("项目：updatedAt 大于 createdAt 即改过", () => {
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [
        { id: "project:a", name: "A", content: "C", createdAt: 1, updatedAt: 2 },
        { id: "project:b", name: "B", content: "C", createdAt: 5, updatedAt: 5 },
      ],
    })
    expect(isDeAiSkillModified(cfg, "project:a")).toBe(true)
    expect(isDeAiSkillModified(cfg, "project:b")).toBe(false)
    expect(isDeAiSkillModified(cfg, "project:ghost")).toBe(false)
  })
})

describe("create / update / reset", () => {
  it("createBlankProjectDeAiSkill 新建并置为默认", () => {
    const cfg = createBlankProjectDeAiSkill(blankConfig(), 12345)
    expect(cfg.defaultSkillId).toBe("project:12345")
    expect(cfg.projectSkills[0]).toMatchObject({
      id: "project:12345",
      name: "新建去AI味技能",
      templateId: "custom",
      source: "project",
      createdAt: 12345,
      updatedAt: 12345,
    })
  })

  it("updateProjectDeAiSkill 只改目标并刷新 updatedAt", () => {
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [
        { id: "project:a", name: "A", content: "CA", createdAt: 1, updatedAt: 1 },
        { id: "project:b", name: "B", content: "CB", createdAt: 1, updatedAt: 1 },
      ],
    })
    const next = updateProjectDeAiSkill(cfg, "project:a", { name: "A2" }, 777)
    expect(next.projectSkills.find((s) => s.id === "project:a")).toMatchObject({
      name: "A2",
      content: "CA",
      createdAt: 1,
      updatedAt: 777,
    })
    expect(next.projectSkills.find((s) => s.id === "project:b")).toMatchObject({ updatedAt: 1 })
    const untouched = updateProjectDeAiSkill(cfg, "project:ghost", { name: "X" }, 777)
    expect(untouched.projectSkills).toHaveLength(2)
  })

  it("updateDeAiSkill 项目分支委托且保持 project 来源", () => {
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [{ id: "project:a", name: "A", content: "CA", createdAt: 1, updatedAt: 1 }],
    })
    const next = updateDeAiSkill(cfg, "project:a", { content: "CC" }, 888)
    expect(next.projectSkills[0]).toMatchObject({ content: "CC", source: "project", updatedAt: 888 })
  })

  it("updateDeAiSkill 内置分支建 override，二次更新保留 createdAt", () => {
    const once = updateDeAiSkill(blankConfig(), "built-in:comprehensive", { name: "改" }, 100)
    const override = once.builtInSkillOverrides.find((s) => s.id === "built-in:comprehensive")
    expect(override).toMatchObject({ name: "改", source: "built-in", createdAt: 100, updatedAt: 100 })
    const twice = updateDeAiSkill(once, "built-in:comprehensive", { name: "改2" }, 200)
    expect(
      twice.builtInSkillOverrides.find((s) => s.id === "built-in:comprehensive"),
    ).toMatchObject({ name: "改2", createdAt: 100, updatedAt: 200 })
  })

  it("updateDeAiSkill 未知内置 id 不建 override", () => {
    const next = updateDeAiSkill(blankConfig(), "built-in:nope", { name: "X" }, 100)
    expect(next.builtInSkillOverrides).toEqual([])
  })

  it("resetBuiltInDeAiSkill 移除 override，未知 id 原样", () => {
    const cfg = normalizeDeAiSkillConfig({
      builtInSkillOverrides: [{ id: "built-in:comprehensive", name: "X", content: "Y" }],
    })
    expect(resetBuiltInDeAiSkill(cfg, "built-in:comprehensive").builtInSkillOverrides).toEqual([])
    expect(resetBuiltInDeAiSkill(cfg, "built-in:nope")).toEqual(normalizeDeAiSkillConfig(cfg))
  })
})

describe("setDefault / setLastChapter / setEnabled / delete", () => {
  it("setDefaultDeAiSkill 合法切换，非法/禁用保持", () => {
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [{ id: "project:p1", name: "P1", content: "C" }],
      disabledSkillIds: ["built-in:reduce-explanation"],
    })
    expect(setDefaultDeAiSkill(cfg, "project:p1").defaultSkillId).toBe("project:p1")
    expect(setDefaultDeAiSkill(cfg, "nope").defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
    expect(setDefaultDeAiSkill(cfg, "built-in:reduce-explanation").defaultSkillId).toBe(
      DEFAULT_DE_AI_SKILL_ID,
    )
  })

  it("setLastChapterDeAiSkill 合法设置，非法清 null", () => {
    const cfg = blankConfig()
    expect(setLastChapterDeAiSkill(cfg, "built-in:dialogue-natural").lastChapterDeAiSkillId).toBe(
      "built-in:dialogue-natural",
    )
    expect(setLastChapterDeAiSkill(cfg, "nope").lastChapterDeAiSkillId).toBeNull()
  })

  it("setDeAiSkillEnabled 禁用默认回退首个可用，启用恢复", () => {
    const cfg = blankConfig()
    const disabled = setDeAiSkillEnabled(cfg, DEFAULT_DE_AI_SKILL_ID, false)
    expect(disabled.disabledSkillIds).toContain(DEFAULT_DE_AI_SKILL_ID)
    expect(disabled.defaultSkillId).toBe("built-in:reduce-explanation")
    const reenabled = setDeAiSkillEnabled(disabled, DEFAULT_DE_AI_SKILL_ID, true)
    expect(reenabled.disabledSkillIds).not.toContain(DEFAULT_DE_AI_SKILL_ID)
    const keepDefault = setDeAiSkillEnabled(cfg, "built-in:dialogue-natural", false)
    expect(keepDefault.defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
  })

  it("全部禁用后再禁默认时默认保持（无可用回退）", () => {
    const ids = BUILT_IN_DE_AI_SKILLS.map((s) => s.id)
    const cfg = normalizeDeAiSkillConfig({ disabledSkillIds: ids })
    const next = setDeAiSkillEnabled(cfg, DEFAULT_DE_AI_SKILL_ID, false)
    expect(next.disabledSkillIds).toHaveLength(5)
    expect(next.defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
  })

  it("deleteProjectDeAiSkill 非 project 前缀返回同一对象", () => {
    const cfg = blankConfig()
    expect(deleteProjectDeAiSkill(cfg, "built-in:comprehensive")).toBe(cfg)
  })

  it("删除默认项目技能回退综合技能，删非默认保持", () => {
    // normalize 先把被删的默认重置为综合技能（未知 id 回退），故删默认恒落到综合
    const cfg = normalizeDeAiSkillConfig({
      defaultSkillId: "project:p1",
      projectSkills: [
        { id: "project:p1", name: "P1", content: "C" },
        { id: "project:p2", name: "P2", content: "C" },
      ],
    })
    const afterDefault = deleteProjectDeAiSkill(cfg, "project:p1")
    expect(afterDefault.projectSkills.map((s) => s.id)).toEqual(["project:p2"])
    expect(afterDefault.defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
    const cfg2 = normalizeDeAiSkillConfig({
      defaultSkillId: "project:p2",
      projectSkills: [
        { id: "project:p1", name: "P1", content: "C" },
        { id: "project:p2", name: "P2", content: "C" },
      ],
    })
    expect(deleteProjectDeAiSkill(cfg2, "project:p1").defaultSkillId).toBe("project:p2")
  })

  it("删除唯一默认项目技能回退内置综合", () => {
    const cfg = normalizeDeAiSkillConfig({
      defaultSkillId: "project:only",
      projectSkills: [{ id: "project:only", name: "O", content: "C" }],
    })
    expect(deleteProjectDeAiSkill(cfg, "project:only").defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
  })
})

describe("loadDeAiSkillConfig", () => {
  it("projectPath 为空直接返回默认（不读盘）", async () => {
    expect(await loadDeAiSkillConfig(null)).toEqual(blankConfig())
    expect(await loadDeAiSkillConfig(undefined)).toEqual(blankConfig())
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })

  it("主配置合法 JSON 按内容归一化", async () => {
    mockFiles({ [CONFIG_PATH]: JSON.stringify({ defaultSkillId: "built-in:dialogue-natural" }) })
    const cfg = await loadDeAiSkillConfig(P)
    expect(cfg.defaultSkillId).toBe("built-in:dialogue-natural")
    expect(vi.mocked(join)).toHaveBeenCalledWith(P, ".niko-buddy/de-ai-skills.json")
  })

  it("主配置损坏抛 corrupt 错误", async () => {
    mockFiles({ [CONFIG_PATH]: "{bad json" })
    await expect(loadDeAiSkillConfig(P)).rejects.toThrow("技能库配置文件损坏")
  })

  it("旧根路径 JSON 命中时惰性迁移（读旧写新）", async () => {
    const legacy = {
      defaultSkillId: "project:legacy-de-ai-skill",
      projectSkills: [
        { id: "project:legacy-de-ai-skill", name: "旧", content: "C", source: "legacy" },
      ],
    }
    mockFiles({ [LEGACY_ROOT_PATH]: JSON.stringify(legacy) })
    const cfg = await loadDeAiSkillConfig(P)
    expect(cfg.defaultSkillId).toBe("project:legacy-de-ai-skill")
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.stringContaining("project:legacy-de-ai-skill"),
    )
    expect(vi.mocked(createDirectory)).toHaveBeenCalled()
  })

  it("迁移写失败不阻断读取", async () => {
    mockFiles({ [LEGACY_ROOT_PATH]: JSON.stringify({ projectSkills: [] }) })
    vi.mocked(writeFileAtomic).mockRejectedValue(new Error("locked"))
    const cfg = await loadDeAiSkillConfig(P)
    expect(cfg.defaultSkillId).toBe(DEFAULT_DE_AI_SKILL_ID)
  })

  it("旧根 JSON 损坏时回退 txt", async () => {
    mockFiles({ [LEGACY_ROOT_PATH]: "{bad", [LEGACY_TXT_PATH]: "  自定义规则  " })
    const cfg = await loadDeAiSkillConfig(P)
    expect(cfg.projectSkills[0]).toMatchObject({
      id: "project:legacy-de-ai-skill",
      content: "自定义规则",
      source: "legacy",
    })
    expect(cfg.defaultSkillId).toBe("project:legacy-de-ai-skill")
  })

  it("txt 为空或缺失时返回默认", async () => {
    mockFiles({ [LEGACY_TXT_PATH]: "   \n" })
    expect(await loadDeAiSkillConfig(P)).toEqual(blankConfig())
    mockFiles({})
    expect(await loadDeAiSkillConfig(P)).toEqual(blankConfig())
  })
})

describe("save / restore / recreate", () => {
  it("save 归一化落盘：有合法旧文件先备份", async () => {
    const existing = JSON.stringify({ defaultSkillId: "built-in:dialogue-natural" })
    mockFiles({ "P1/.niko-buddy/de-ai-skills.json": existing })
    const cfg = normalizeDeAiSkillConfig({
      projectSkills: [{ id: "project:p1", name: "P1", content: "C" }],
    })
    await saveDeAiSkillConfig("P1", cfg)
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith("P1/.niko-buddy/de-ai-skills.backup.json", existing)
    const [, written] = vi.mocked(writeFileAtomic).mock.calls[0]
    expect(JSON.parse(written as string)).toMatchObject({ version: 1 })
  })

  it("save 无合法旧文件时跳过备份", async () => {
    mockFiles({ "P2/.niko-buddy/de-ai-skills.json": "{bad" })
    await saveDeAiSkillConfig("P2", blankConfig())
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(1)
  })

  it("同 path 串行 save 按序落盘两次", async () => {
    mockFiles({})
    await saveDeAiSkillConfig("P3", blankConfig())
    await saveDeAiSkillConfig("P3", blankConfig())
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(2)
  })

  it("同 path 并发 save：前者失败不阻断后者（队列 catch 生效）", async () => {
    mockFiles({})
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error("locked")).mockResolvedValue(undefined)
    const first = saveDeAiSkillConfig("PQ", blankConfig())
    const second = saveDeAiSkillConfig("PQ", blankConfig())
    await expect(first).rejects.toThrow("locked")
    await expect(second).resolves.toBeUndefined()
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(2)
  })

  it("restore 备份合法时写回并返回配置", async () => {
    mockFiles({
      "P4/.niko-buddy/de-ai-skills.backup.json": JSON.stringify({
        defaultSkillId: "built-in:break-regularity",
      }),
    })
    const cfg = await restoreDeAiSkillConfigFromBackup("P4")
    expect(cfg.defaultSkillId).toBe("built-in:break-regularity")
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledWith(
      "P4/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("built-in:break-regularity"),
    )
  })

  it("restore 备份损坏时报错", async () => {
    mockFiles({ "P5/.niko-buddy/de-ai-skills.backup.json": "{bad" })
    await expect(restoreDeAiSkillConfigFromBackup("P5")).rejects.toThrow("技能库备份文件损坏")
  })

  it("recreate 写入默认配置", async () => {
    const cfg = await recreateDeAiSkillConfig("P6")
    expect(cfg).toEqual(blankConfig())
    expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledWith(
      "P6/.niko-buddy/de-ai-skills.json",
      JSON.stringify(blankConfig(), null, 2),
    )
  })
})

describe("loadEffectiveDeAiSkillSafely", () => {
  it("正常返回技能且无警告；显式 null 关闭", async () => {
    mockFiles({})
    expect(await loadEffectiveDeAiSkillSafely(P)).toEqual({
      skill: expect.objectContaining({ id: DEFAULT_DE_AI_SKILL_ID }),
      warning: "",
    })
    expect(await loadEffectiveDeAiSkillSafely(P, null)).toEqual({ skill: null, warning: "" })
  })

  it("配置损坏返回 null + 损坏警告", async () => {
    mockFiles({ [CONFIG_PATH]: "{bad" })
    const res = await loadEffectiveDeAiSkillSafely(P)
    expect(res.skill).toBeNull()
    expect(res.warning).toContain("损坏")
  })

  it("读取失败返回 null + 读取失败警告", async () => {
    // 读盘 ENOENT 会被归一为默认配置；只有 join（tauri）抛错才会走到读取失败分支
    vi.mocked(join).mockRejectedValueOnce(new Error("tauri closed"))
    const res = await loadEffectiveDeAiSkillSafely(P)
    expect(res.skill).toBeNull()
    expect(res.warning).toContain("读取去AI味技能失败")
  })
})
