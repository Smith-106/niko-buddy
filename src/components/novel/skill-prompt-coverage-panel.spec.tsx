// @vitest-environment jsdom
/**
 * skills × 提示词对齐覆盖面板：只读渲染 + 缺真源显式 N/A + 注入覆盖表后 UI 跟随。
 *
 * 断言都是可失败的：删掉任何 N/A 格子、把 uncovered 标记写死、或让 UI 忽略注入值，都会红。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { BUILT_IN_DE_AI_SKILLS, PROMPTS, type SkillPromptCoverage } from "@/lib/novel"
import { SkillPromptCoveragePanel } from "./skill-prompt-coverage-panel"

/** 注入用假覆盖表（id 与真源不重叠，便于断言 UI 真的跟随注入值）。 */
function fakeCoverage(overrides: Partial<SkillPromptCoverage> = {}): SkillPromptCoverage {
  return {
    skills: [
      {
        id: "skill:one",
        name: "一号技能",
        builtIn: true,
        sourceKind: "built-in",
        templateId: "one",
        enabled: true,
        isDefault: true,
        isFactoryDefault: true,
        declaredStages: ["output", "rewrite"],
        coveredStageCount: 2,
        promptKeyCount: null,
      },
    ],
    hooks: [
      {
        id: "hook:one",
        title: "一号钩子",
        enabled: false,
        stages: ["pre_write_prompt"],
        promptKeyCount: null,
      },
    ],
    promptKeys: [
      { key: "keyCovered", associatedSkillIds: ["skill:one"], associatedHookIds: [], uncovered: false },
      { key: "keyUncovered", associatedSkillIds: [], associatedHookIds: [], uncovered: true },
    ],
    uncoveredPromptKeys: ["keyUncovered"],
    coveredPromptKeyCount: 1,
    associationSourceDeclared: true,
    builtInSkillCount: 1,
    projectSkillCount: 0,
    disabledSkillCount: 0,
    builtInSkillIds: ["skill:one"],
    defaultSkillId: "skill:one",
    missingSources: ["假缺源 A（无真源，不猜测）", "假缺源 B（无真源，不估算）"],
    ...overrides,
  }
}

describe("SkillPromptCoveragePanel", () => {
  afterEach(cleanup)

  it("默认（不注入）：真的从真源投影 —— 内建 skill 全有行，键行覆盖状态如实标 N/A", () => {
    render(<SkillPromptCoveragePanel />)

    for (const skill of BUILT_IN_DE_AI_SKILLS) {
      expect(screen.getByTestId(`skill-prompt-row-${skill.id}`)).toBeTruthy()
    }
    // 默认没有关联真源 → 逐条断言 uncovered 等于「假装查过了」。
    // 审查修正后的口径：每行标 N/A，页眉也标 N/A（可失败：改回 uncovered 即红）。
    for (const key of Object.keys(PROMPTS)) {
      const cell = screen.getByTestId(`skill-prompt-na-${key}`)
      expect(cell.getAttribute("data-coverage-state")).toBe("na")
    }
    expect(screen.queryByTestId("skill-prompt-uncovered-chapterGeneration")).toBeNull()
    expect(screen.getByTestId("skill-prompt-coverage-panel").textContent).toContain("提示词键")
    expect(screen.getByTestId("skill-prompt-coverage-boundary").textContent).toContain("不按关键词猜测")
  })

  it("注入假覆盖表 → UI 跟随注入值（不读真源、不硬编码）", () => {
    render(<SkillPromptCoveragePanel coverage={fakeCoverage()} />)

    expect(screen.getByTestId("skill-prompt-coverage-scope").textContent).toContain(
      "skill 1 个（内建 1 · 项目 0 · 停用 0）· 钩子 1 个 · 提示词键 2 个 · 有覆盖 1 个 · uncovered 1 个",
    )
    expect(screen.getByTestId("skill-prompt-row-skill:one")).toBeTruthy()
    expect(screen.getByTestId("skill-prompt-hook-hook:one")).toBeTruthy()
    expect(screen.getByTestId("skill-prompt-covered-keyCovered").textContent).toContain("covered")
    expect(screen.getByTestId("skill-prompt-uncovered-keyUncovered").textContent).toContain("uncovered")

    // 注入后真源行必须消失（证明渲染跟随注入，而不是偷偷读真源）。
    expect(screen.queryByTestId("skill-prompt-row-built-in:comprehensive")).toBeNull()
    expect(screen.queryByTestId("skill-prompt-uncovered-chapterGeneration")).toBeNull()
  })

  it("N/A 明示：缺真源的清单与每个格子都在（删掉任一条都会红）", () => {
    const coverage = fakeCoverage()
    render(<SkillPromptCoveragePanel coverage={coverage} />)

    const naSources = screen.getAllByTestId(/^skill-prompt-na-source-/)
    expect(naSources.length).toBe(coverage.missingSources.length)
    expect(naSources.length).toBeGreaterThanOrEqual(2)
    for (const item of naSources) {
      expect(item.textContent).toContain("N/A")
    }
    expect(screen.getByTestId("skill-prompt-na-source-0").textContent).toContain("假缺源 A")
    expect(screen.getByTestId("skill-prompt-na-source-1").textContent).toContain("假缺源 B")

    expect(screen.getByTestId("skill-prompt-na-prompt-keys-skill:one").textContent).toContain("N/A")
    expect(screen.getByTestId("skill-prompt-na-hook-prompt-keys-hook:one").textContent).toContain("N/A")
  })

  it("promptKeyCount 注入数字 → N/A 格子消失并显示数字（N/A 与数据绑定，不是装饰）", () => {
    render(
      <SkillPromptCoveragePanel
        coverage={fakeCoverage({
          skills: [
            {
              id: "skill:one",
              name: "一号技能",
              builtIn: true,
              sourceKind: "built-in",
              templateId: "one",
              enabled: true,
              isDefault: true,
              isFactoryDefault: true,
              declaredStages: ["output", "rewrite"],
              coveredStageCount: 2,
              promptKeyCount: 3,
            },
          ],
        })}
      />,
    )

    expect(screen.queryByTestId("skill-prompt-na-prompt-keys-skill:one")).toBeNull()
    expect(screen.getByTestId("skill-prompt-prompt-keys-skill:one").textContent).toContain("3")
  })

  it("空钩子注册表 / 空提示词键：显式空态，不造行", () => {
    render(<SkillPromptCoveragePanel coverage={fakeCoverage({ hooks: [], promptKeys: [], uncoveredPromptKeys: [], coveredPromptKeyCount: 0 })} />)

    expect(screen.getByTestId("skill-prompt-hooks-empty").textContent).toContain("没有声明任何钩子")
    expect(screen.getByTestId("skill-prompt-keys-empty").textContent).toContain("没有可展示的行")
    expect(screen.queryAllByTestId(/^skill-prompt-key-/).length).toBe(0)
  })
})

describe("无关联真源时不得显示确定的 0（审查回归）", () => {
  afterEach(cleanup)

  it("associationSourceDeclared=false → 页眉显示 N/A 而不是「有覆盖 0 个」", () => {
    render(
      <SkillPromptCoveragePanel
        coverage={{
          skills: [],
          hooks: [],
          promptKeys: [],
          uncoveredPromptKeys: [],
          coveredPromptKeyCount: 0,
          associationSourceDeclared: false,
          builtInSkillCount: 0,
          projectSkillCount: 0,
          disabledSkillCount: 0,
          builtInSkillIds: [],
          defaultSkillId: "built-in:comprehensive",
          missingSources: ["skill↔提示词关联（无真源）"],
        }}
      />,
    )
    const scope = screen.getByTestId("skill-prompt-coverage-scope").textContent ?? ""
    expect(scope).toContain("N/A（无关联真源）")
    expect(scope).not.toMatch(/有覆盖 0 个/)
  })
})

describe("有关联真源时行内仍是 covered/uncovered（审查回归）", () => {
  afterEach(cleanup)

  it("associationSourceDeclared=true → data-coverage-state 分别是 uncovered / covered", () => {
    render(
      <SkillPromptCoveragePanel
        coverage={{
          skills: [],
          hooks: [],
          promptKeys: [
            { key: "a", associatedSkillIds: [], associatedHookIds: [], uncovered: true },
            { key: "b", associatedSkillIds: ["s1"], associatedHookIds: [], uncovered: false },
          ],
          uncoveredPromptKeys: ["a"],
          coveredPromptKeyCount: 1,
          associationSourceDeclared: true,
          builtInSkillCount: 0,
          projectSkillCount: 0,
          disabledSkillCount: 0,
          builtInSkillIds: [],
          defaultSkillId: "built-in:comprehensive",
          missingSources: [],
        }}
      />,
    )
    expect(screen.getByTestId("skill-prompt-uncovered-a").getAttribute("data-coverage-state")).toBe(
      "uncovered",
    )
    expect(screen.getByTestId("skill-prompt-covered-b").getAttribute("data-coverage-state")).toBe(
      "covered",
    )
    expect(screen.queryByTestId("skill-prompt-na-a")).toBeNull()
  })
})
