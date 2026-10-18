// @vitest-environment jsdom
/**
 * skills × 提示词对齐覆盖表：真源 = 去AI味技能库 + `PROMPTS` 键 + 钩子注册表。
 *
 * 断言重点（都是可失败的，不是「存在即通过」）：
 * - 内建 skill 全在行里（含被停用的）；
 * - `uncoveredPromptKeys` = **真实差集**（独立从真源算一遍，并有「关联真源缺失」的机械证据）；
 * - 注入关联源 → 差集收缩（证明 uncovered 不是硬编码「全部键」）；
 * - 无关联真源时 `promptKeyCount` 恒 `null`（不是 0）；
 * - 排序码点稳定、只读（不执行钩子、不改注册表）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  BUILT_IN_DE_AI_SKILLS,
  DEFAULT_DE_AI_SKILL_ID,
  normalizeDeAiSkillConfig,
} from "./de-ai-skill-library"
import { getNovelSkillHookRegistry, registerNovelSkillHook, setNovelSkillHookRegistry } from "./novel-skill-hooks"
import { PROMPTS } from "./prompt-templates"
import { buildSkillPromptCoverage } from "./skill-prompt-coverage"

/** 码点升序（与实现同一定义：`a < b`，不用 localeCompare）。 */
const CODE_POINT_SORT = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const REAL_PROMPT_KEYS = Object.keys(PROMPTS).sort(CODE_POINT_SORT)

/** 真源对象上「值数组」的只读取值（用于证明关联真源缺失，不用 any）。 */
function ownValues(source: object): unknown[] {
  return Object.values(source as Record<string, unknown>)
}

describe("buildSkillPromptCoverage", () => {
  afterEach(() => {
    setNovelSkillHookRegistry(null)
  })

  it("内建 skill 全在行里（不遗漏；被停用的仍有一行、不隐藏）", () => {
    const config = normalizeDeAiSkillConfig({ disabledSkillIds: ["built-in:literary-retain"] })
    const coverage = buildSkillPromptCoverage({ config })
    const rowIds = coverage.skills.map((row) => row.id)

    for (const skill of BUILT_IN_DE_AI_SKILLS) {
      expect(rowIds).toContain(skill.id)
    }
    expect(coverage.builtInSkillIds).toEqual(BUILT_IN_DE_AI_SKILLS.map((skill) => skill.id).sort(CODE_POINT_SORT))

    const disabled = coverage.skills.find((row) => row.id === "built-in:literary-retain")
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.builtIn).toBe(true)
    expect(coverage.disabledSkillCount).toBe(1)
    expect(coverage.builtInSkillCount).toBe(BUILT_IN_DE_AI_SKILLS.length)
    expect(coverage.projectSkillCount).toBe(0)
  })

  it("uncovered 键集合 = 真实差集（独立算一遍：PROMPTS 键 − 已声明关联）", () => {
    const coverage = buildSkillPromptCoverage()

    // 真实差集：既有真源里没有任何 skill/hook → PROMPTS 键 的关联声明，差集 = 全部键。
    const declaredAssociations = new Set<string>()
    const realUncovered = REAL_PROMPT_KEYS.filter((key) => !declaredAssociations.has(key))

    expect(coverage.uncoveredPromptKeys).toEqual(realUncovered)
    expect(realUncovered.length).toBe(REAL_PROMPT_KEYS.length)
    expect(coverage.coveredPromptKeyCount).toBe(0)
    expect(coverage.promptKeys.map((row) => row.key)).toEqual(REAL_PROMPT_KEYS)
    expect(coverage.promptKeys.every((row) => row.uncovered)).toBe(true)
    expect(
      coverage.promptKeys.every(
        (row) => row.associatedSkillIds.length === 0 && row.associatedHookIds.length === 0,
      ),
    ).toBe(true)
  })

  it("关联真源缺失的机械证据：真源对象上没有任何「值含 PROMPTS 键的数组字段」", () => {
    const keySet = new Set(REAL_PROMPT_KEYS)
    registerNovelSkillHook({
      id: "fuse.hook",
      title: "fuse",
      stages: ["pre_write_prompt"],
      track: "B",
      run: () => {},
    })

    const sources: object[] = [...BUILT_IN_DE_AI_SKILLS, ...getNovelSkillHookRegistry().hooks]
    const hits: string[] = []
    for (const source of sources) {
      for (const value of ownValues(source)) {
        if (!Array.isArray(value)) continue
        for (const item of value) {
          if (typeof item === "string" && keySet.has(item)) hits.push(item)
        }
      }
    }

    // 一旦有人给真源加上 prompt 键字段，本行先红：builder 的 uncovered 结论必须同步改。
    expect(hits).toEqual([])
  })

  it("注入关联源 → 差集收缩（证明 uncovered 不是硬编码「全部键」）", () => {
    const coverage = buildSkillPromptCoverage({
      links: [
        { source: "skill", sourceId: DEFAULT_DE_AI_SKILL_ID, promptKeys: ["chapterRevision"] },
        { source: "hook", sourceId: "test.hook", promptKeys: ["consistencyCheck", "chapterRevision"] },
      ],
    })

    expect(coverage.uncoveredPromptKeys).toEqual(
      REAL_PROMPT_KEYS.filter((key) => key !== "chapterRevision" && key !== "consistencyCheck"),
    )
    expect(coverage.coveredPromptKeyCount).toBe(2)

    const revision = coverage.promptKeys.find((row) => row.key === "chapterRevision")
    expect(revision?.uncovered).toBe(false)
    expect(revision?.associatedSkillIds).toEqual([DEFAULT_DE_AI_SKILL_ID])
    expect(revision?.associatedHookIds).toEqual(["test.hook"])

    // 显式声明关联源后才有数字（默认无真源 → null）。
    expect(coverage.skills.find((row) => row.id === DEFAULT_DE_AI_SKILL_ID)?.promptKeyCount).toBe(1)
    expect(coverage.skills.find((row) => row.id === "built-in:literary-retain")?.promptKeyCount).toBe(0)
  })

  it("注入不存在的键不计入（覆盖表只对真实键全集负责）", () => {
    const coverage = buildSkillPromptCoverage({
      promptKeys: ["onlyKey"],
      links: [
        { source: "skill", sourceId: DEFAULT_DE_AI_SKILL_ID, promptKeys: ["onlyKey", "notARealKey"] },
        { source: "hook", sourceId: "h", promptKeys: ["notARealKey"] },
      ],
    })

    expect(coverage.promptKeys.map((row) => row.key)).toEqual(["onlyKey"])
    expect(coverage.coveredPromptKeyCount).toBe(1)
    expect(coverage.uncoveredPromptKeys).toEqual([])
  })

  it("无关联真源 → promptKeyCount 恒 null（不是 0：0 会谎称「确定没有关联」）", () => {
    registerNovelSkillHook({
      id: "a.hook",
      title: "a",
      stages: ["pre_write_prompt"],
      track: "B",
      run: () => {},
    })
    const coverage = buildSkillPromptCoverage()

    for (const row of coverage.skills) {
      expect(row.promptKeyCount).toBeNull()
      expect(row.promptKeyCount).not.toBe(0)
    }
    for (const hook of coverage.hooks) {
      expect(hook.promptKeyCount).toBeNull()
      expect(hook.promptKeyCount).not.toBe(0)
    }
  })

  it("skill 的 stage 来自 deAiSkillToUserSkill 的固定映射（全体一致，非逐 skill 真源）", () => {
    const coverage = buildSkillPromptCoverage()

    expect(coverage.skills.length).toBeGreaterThan(0)
    expect(coverage.skills.every((row) => row.coveredStageCount === 2)).toBe(true)
    expect(coverage.skills[0].declaredStages).toEqual(["output", "rewrite"])
  })

  it("钩子行来自注册表：id 码点升序、stage 码点升序、enabled 反映 enabled !== false", () => {
    registerNovelSkillHook({
      id: "b.hook",
      title: "b",
      stages: ["pre_write_prompt", "post_draft_light_check"],
      track: "B",
      run: () => {},
    })
    registerNovelSkillHook({
      id: "a.hook",
      title: "a",
      stages: ["pre_six_dim_review"],
      track: "B",
      enabled: false,
      run: () => {},
    })

    const coverage = buildSkillPromptCoverage()

    expect(coverage.hooks.map((hook) => hook.id)).toEqual(["a.hook", "b.hook"])
    expect(coverage.hooks[1].stages).toEqual(["post_draft_light_check", "pre_write_prompt"])
    expect(coverage.hooks[0].enabled).toBe(false)
    expect(coverage.hooks[1].enabled).toBe(true)
  })

  it("空注册表 → 0 行（不造行）+ 缺真源清单非空且点名 prompt 键关联", () => {
    const coverage = buildSkillPromptCoverage()

    expect(coverage.hooks).toEqual([])
    expect(coverage.missingSources.length).toBeGreaterThanOrEqual(4)
    expect(coverage.missingSources.join("\n")).toContain("PROMPTS 键")
    expect(coverage.missingSources.join("\n")).toContain("prompt 键字段")
  })

  it("只读：投影不执行钩子、不改注册表", () => {
    const runSpy = vi.fn()
    registerNovelSkillHook({
      id: "spy.hook",
      title: "spy",
      stages: ["pre_write_prompt"],
      track: "B",
      run: runSpy,
    })

    buildSkillPromptCoverage()

    expect(runSpy).not.toHaveBeenCalled()
    expect(getNovelSkillHookRegistry().hooks.map((hook) => hook.id)).toEqual(["spy.hook"])
  })

  it("行序码点稳定（不随真源声明顺序漂移）", () => {
    const coverage = buildSkillPromptCoverage()
    const skillIds = coverage.skills.map((row) => row.id)

    expect(skillIds).toEqual([...skillIds].sort(CODE_POINT_SORT))
    expect(coverage.promptKeys.map((row) => row.key)).toEqual(REAL_PROMPT_KEYS)
  })

  it("项目技能也是一行（builtIn=false）+ 默认/出厂默认标记", () => {
    const config = normalizeDeAiSkillConfig({
      projectSkills: [
        {
          id: "project:1",
          name: "我的去AI味",
          description: "",
          templateId: "custom",
          content: "# 规则",
          source: "project",
        },
      ],
      defaultSkillId: "project:1",
    })
    const coverage = buildSkillPromptCoverage({ config })
    const row = coverage.skills.find((item) => item.id === "project:1")

    expect(row?.builtIn).toBe(false)
    expect(row?.sourceKind).toBe("project")
    expect(row?.isDefault).toBe(true)
    expect(coverage.projectSkillCount).toBe(1)
    expect(coverage.defaultSkillId).toBe("project:1")
    expect(coverage.skills.filter((item) => item.isFactoryDefault).map((item) => item.id)).toEqual([
      DEFAULT_DE_AI_SKILL_ID,
    ])
  })
})
