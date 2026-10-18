// @vitest-environment jsdom
/**
 * 方法论投影：真源 = 钩子注册表（`getNovelSkillHookRegistry` / `listNovelSkillHooksForStage`）。
 * 覆盖：空注册表 → 空数组 + 缺真源清单；有钩子 → 计数/id 正确；无真源字段恒 null；只读不执行。
 */
import { afterEach, describe, expect, it, vi } from "vitest"

import { registerNovelSkillHook, setNovelSkillHookRegistry } from "./novel-skill-hooks"
import { projectMethodologyUsage } from "./methodology-projection"

/** 码点升序（与实现同一定义：`a < b`，不用 localeCompare）。 */
const KNOWN_STAGES_SORTED = [
  "post_draft_light_check",
  "post_gate_literary_polish",
  "pre_outline_soft_gate",
  "pre_six_dim_review",
  "pre_write_prompt",
]

describe("projectMethodologyUsage", () => {
  afterEach(() => {
    setNovelSkillHookRegistry(null)
  })

  it("空注册表 → 空数组（不造行）+ 缺真源清单非空", () => {
    const projection = projectMethodologyUsage()

    expect(projection.stages).toEqual([])
    expect(projection.declaredHookCount).toBe(0)
    expect(projection.enabledHookCount).toBe(0)
    expect(projection.knownStages).toEqual(KNOWN_STAGES_SORTED)
    expect(projection.missingSources.length).toBeGreaterThan(0)
    expect(projection.missingSources.join("\n")).toContain("触发")
    expect(projection.missingSources.join("\n")).toContain("promptHint")
  })

  it("有钩子 → 每 stage 的计数与 id 列表正确（码点升序）", () => {
    registerNovelSkillHook({
      id: "zzz.hook",
      title: "z",
      stages: ["pre_write_prompt"],
      track: "B",
      run: () => {},
    })
    registerNovelSkillHook({
      id: "aaa.hook",
      title: "a",
      stages: ["pre_write_prompt", "pre_six_dim_review"],
      track: "B",
      run: () => {},
    })
    registerNovelSkillHook({
      id: "off.hook",
      title: "off",
      stages: ["pre_write_prompt"],
      track: "B",
      enabled: false,
      run: () => {},
    })

    const projection = projectMethodologyUsage()

    expect(projection.stages.map((row) => row.stage)).toEqual([
      "pre_six_dim_review",
      "pre_write_prompt",
    ])
    const [sixDim, preWrite] = projection.stages
    expect(sixDim.hookCount).toBe(1)
    expect(sixDim.hookIds).toEqual(["aaa.hook"])
    expect(sixDim.declaredHookCount).toBe(1)

    // 声明 3 个（含 enabled:false），实际生效 2 个。
    expect(preWrite.hookCount).toBe(2)
    expect(preWrite.hookIds).toEqual(["aaa.hook", "zzz.hook"])
    expect(preWrite.declaredHookCount).toBe(3)

    // 跨 stage 去重后仍只有 aaa/zzz 两个生效钩子；声明总数含 off.hook。
    expect(projection.enabledHookCount).toBe(2)
    expect(projection.declaredHookCount).toBe(3)
  })

  it("注册顺序不影响行序（码点稳定，不随注册顺序漂移）", () => {
    registerNovelSkillHook({
      id: "b",
      title: "b",
      stages: ["post_gate_literary_polish", "pre_outline_soft_gate"],
      track: "B",
      run: () => {},
    })
    const first = projectMethodologyUsage().stages.map((row) => row.stage)

    setNovelSkillHookRegistry(null)
    registerNovelSkillHook({
      id: "b",
      title: "b",
      stages: ["pre_outline_soft_gate", "post_gate_literary_polish"],
      track: "B",
      run: () => {},
    })
    const second = projectMethodologyUsage().stages.map((row) => row.stage)

    expect(first).toEqual(["post_gate_literary_polish", "pre_outline_soft_gate"])
    expect(second).toEqual(first)
  })

  it("无真源字段恒 null（不是 false / 不是 0）", () => {
    registerNovelSkillHook({
      id: "some.hook",
      title: "s",
      stages: ["pre_six_dim_review"],
      track: "B",
      run: () => {},
    })

    const [row] = projectMethodologyUsage().stages
    expect(row.hasPromptHint).toBeNull()
    expect(row.triggerCount).toBeNull()
    expect(row.hasPromptHint).not.toBe(false)
    expect(row.triggerCount).not.toBe(0)
  })

  it("只读：投影不执行任何钩子、不改注册表", () => {
    const runSpy = vi.fn()
    registerNovelSkillHook({
      id: "spy.hook",
      title: "spy",
      stages: ["pre_write_prompt"],
      track: "B",
      run: runSpy,
    })

    projectMethodologyUsage()

    expect(runSpy).not.toHaveBeenCalled()
    expect(projectMethodologyUsage().stages[0].hookIds).toEqual(["spy.hook"])
  })
})
