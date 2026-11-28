import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  BUILT_IN_CRAFT_PRESETS,
  PRESET_JOURNAL_FILE,
  applyCraftPresetToProject,
  mergeFencedPresetHint,
  rollbackLastCraftPreset,
  stripFencedPresetHint,
} from "./craft-preset-applier"
import {
  NMEM_SNAPSHOT,
  NMEM_SNAPSHOT_VERSION,
  validateNmemSnapshot,
} from "./craft/nmem-snapshot"
import {
  TECHNIQUE_COMPILER_VERSION,
  compileFromCommittedSnapshot,
} from "./craft/technique-compiler"
import {
  CRAFT_RULE_REGISTRY_VERSION,
  getAllInjectionScopes,
  getUniversalSpaceRuleIds,
} from "./craft/craft-rule-registry"

const memFs = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    failOnPath: null as string | null,
    reset() {
      files.clear()
      this.failOnPath = null
    },
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: vi.fn(async (p: string) => memFs.files.has(p.replace(/\\/g, "/"))),
    readFile: vi.fn(async (p: string) => {
      const key = p.replace(/\\/g, "/")
      if (!memFs.files.has(key)) throw new Error(`ENOENT: ${key}`)
      return memFs.files.get(key)!
    }),
    createDirectory: vi.fn(async () => {}),
    writeFileAtomic: vi.fn(async (p: string, content: string) => {
      const key = p.replace(/\\/g, "/")
      if (memFs.failOnPath && key.endsWith(memFs.failOnPath)) {
        throw new Error(`simulated disk failure on ${key}`)
      }
      memFs.files.set(key, content)
    }),
  }
})

describe("Phase 3 upgrades: Atomic CraftPresetApplier + Compiler v2 + Snapshot v5", () => {
  beforeEach(() => {
    memFs.reset()
  })

  it("mergeFencedPresetHint 无损保留用户围栏外提示词，切换预设仅替换围栏块", () => {
    const userNote = "主角左手有旧伤，雨天发疼。"
    const first = mergeFencedPresetHint(userNote, "cuttlefish-mystery", "多用信息差与克制潜台词。")
    expect(first).toContain(userNote)
    expect(first).toContain("<!-- preset-hint:start:cuttlefish-mystery -->")
    expect(first).toContain("多用信息差与克制潜台词。")

    const switched = mergeFencedPresetHint(first, "fox-folk-horror", "强痛觉与嗅觉错位。")
    expect(switched).toContain(userNote)
    expect(switched).not.toContain("cuttlefish-mystery")
    expect(switched).toContain("<!-- preset-hint:start:fox-folk-horror -->")
    expect(switched).toContain("强痛觉与嗅觉错位。")

    expect(stripFencedPresetHint(switched)).toBe(userNote)
  })

  it("applyCraftPresetToProject 四文件原子提交 + 时间戳备份 + BookRules 无损合并 + 一键回滚", async () => {
    const project = "/MyNovel"
    const origNovelCfg = JSON.stringify({
      searchTopK: 9,
      taskPrompts: { writing: { extra: "保留我的自定义写作习惯" } },
      taskSkillNames: { outline: [], writing: [], review: [], summary: [], extract: [] },
    })
    const origBookRules = JSON.stringify({
      version: "1.1",
      prohibitions: ["绝不后宫"],
      allowedDeviations: [],
    })
    memFs.files.set(`${project}/.niko-buddy/novel-config.json`, origNovelCfg)
    memFs.files.set(`${project}/.novel/book-rules.json`, origBookRules)

    const res = await applyCraftPresetToProject(project, "cuttlefish-mystery", {
      now: new Date("2026-11-27T12:00:00Z"),
    })
    expect(res.preset.id).toBe("cuttlefish-mystery")
    expect(res.backupDir).toMatch(/^\.niko-buddy\/preset-backups\/20261127T120000Z-tx-/)
    expect(res.updatedNovelConfig.activeCraftPresetId).toBe("cuttlefish-mystery")
    expect(res.updatedNovelConfig.taskPrompts.writing.extra).toContain("保留我的自定义写作习惯")
    expect(res.updatedNovelConfig.taskPrompts.writing.extra).toContain("<!-- preset-hint:start:cuttlefish-mystery -->")
    expect(res.updatedBookRules.prohibitions).toContain("绝不后宫")
    expect(res.updatedBookRules.genreLock?.primary).toBe("西方奇幻")
    expect(memFs.files.has(`${project}/${PRESET_JOURNAL_FILE}`)).toBe(true)

    // 一键回滚恢复全部原文件内容
    const rolled = await rollbackLastCraftPreset(project)
    expect(rolled.presetId).toBe("cuttlefish-mystery")
    expect(memFs.files.get(`${project}/.niko-buddy/novel-config.json`)).toBe(origNovelCfg)
    expect(memFs.files.get(`${project}/.novel/book-rules.json`)).toBe(origBookRules)
  })

  it("applyCraftPresetToProject 第 3 步写盘失败时自动回滚前 2 个已写文件", async () => {
    const project = "/FailNovel"
    const origRules = JSON.stringify({ version: "1.1", prohibitions: ["禁穿越"], allowedDeviations: [] })
    memFs.files.set(`${project}/.novel/book-rules.json`, origRules)

    memFs.failOnPath = ".niko-buddy/novel-config.json"
    await expect(applyCraftPresetToProject(project, "mortal-cultivation")).rejects.toThrow("自动回滚")

    // 取消故障注入后验证 book-rules.json 已自动恢复原字节
    expect(memFs.files.get(`${project}/.novel/book-rules.json`)).toBe(origRules)
    expect(memFs.files.has(`${project}/${PRESET_JOURNAL_FILE}`)).toBe(false)
  })

  it("BUILT_IN_CRAFT_PRESETS 完整收录 12 套离线流派配方，且完整挂载 7 个写作技法库蒸馏技能", () => {
    expect(BUILT_IN_CRAFT_PRESETS).toHaveLength(12)
    expect(new Set(BUILT_IN_CRAFT_PRESETS.map((p) => p.id)).size).toBe(12)

    const allAssignedSkills = new Set(
      BUILT_IN_CRAFT_PRESETS.flatMap((p) => [
        ...p.craftSkills,
        ...p.taskSkillNames.outline,
        ...p.taskSkillNames.writing,
        ...p.taskSkillNames.review,
      ]),
    )
    for (const craftSlug of [
      "craft-opening-hook-promise-and-inciting-incident",
      "craft-scene-sequel-beats-and-pov-discipline",
      "craft-mystery-clue-fairplay-and-red-herring",
      "craft-worldview-coherence-and-belief-arc",
      "craft-midbook-midpoint-and-climax-architecture",
      "craft-self-editing-revision-and-prose-tightening",
      "craft-emotional-tension-and-crisis-escalation",
    ]) {
      expect(allAssignedSkills.has(craftSlug), `内置流派预设尚未挂载技法 ${craftSlug}`).toBe(true)
    }
  })

  it("Compiler v2 & Snapshot v5：13 条通用规则全编译、18/18 技能全覆盖映射、6 域 InjectionScope 对齐", () => {
    expect(NMEM_SNAPSHOT_VERSION).toBe(5)
    expect(TECHNIQUE_COMPILER_VERSION).toBe("2.0.0")
    expect(CRAFT_RULE_REGISTRY_VERSION).toBe("2.0.0")
    expect(validateNmemSnapshot(NMEM_SNAPSHOT).ok).toBe(true)
    expect(NMEM_SNAPSHOT.universalRules).toHaveLength(13)

    const registry = compileFromCommittedSnapshot()
    expect(registry.packs).toHaveLength(9)
    expect(registry.universalRulePacks).toHaveLength(13)
    expect(getUniversalSpaceRuleIds()).toHaveLength(13)

    // 全部 18 条 snapshot skills 都至少映射到了 1 个 packId
    for (const skill of NMEM_SNAPSHOT.skills) {
      const mapped = registry.skillPackIndex?.[skill.skillId]
      expect(mapped, `skill ${skill.skillId} (${skill.title}) 未映射到任何规则包`).toBeDefined()
      expect(mapped!.length).toBeGreaterThanOrEqual(1)
    }

    // 全部 6 个 InjectionScope 对齐
    const allScopes = new Set(getAllInjectionScopes())
    expect(allScopes.size).toBe(6)
    for (const uPack of registry.universalRulePacks ?? []) {
      expect(allScopes.has(uPack.injectionPoint)).toBe(true)
    }
  })
})
