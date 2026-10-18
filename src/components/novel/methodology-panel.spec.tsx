// @vitest-environment jsdom
/**
 * 方法论生效面板：只读投影渲染 + 缺真源显式中文 N/A。
 * 断言都「可失败」：计数必须跟随 projection、N/A 文案必须真存在。
 */
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { MethodologyPanel } from "./methodology-panel"
import type { MethodologyProjection } from "@/lib/novel"

const fakeProjection: MethodologyProjection = {
  stages: [
    {
      stage: "pre_six_dim_review",
      hookCount: 0,
      declaredHookCount: 1,
      hookIds: [],
      hasPromptHint: null,
      triggerCount: null,
    },
    {
      stage: "pre_write_prompt",
      hookCount: 2,
      declaredHookCount: 3,
      hookIds: ["aaa.hook", "zzz.hook"],
      hasPromptHint: null,
      triggerCount: null,
    },
  ],
  knownStages: ["post_draft_light_check", "pre_six_dim_review", "pre_write_prompt"],
  declaredHookCount: 3,
  enabledHookCount: 2,
  missingSources: [
    "hook 触发/命中次数（无埋点真源：注册表只声明钩子，不记录 run 历史）",
    "每个钩子的 promptHint（NovelSkillHook 无 promptHint 字段，注册表读不到）",
  ],
}

/** 有真源的投影（用于证明 N/A 不是硬编码文案）。 */
const projectionWithRealSources: MethodologyProjection = {
  stages: [
    {
      stage: "pre_write_prompt",
      hookCount: 5,
      declaredHookCount: 5,
      hookIds: ["only.hook"],
      hasPromptHint: true,
      triggerCount: 4,
    },
  ],
  knownStages: ["pre_write_prompt"],
  declaredHookCount: 5,
  enabledHookCount: 5,
  missingSources: [],
}

describe("MethodologyPanel", () => {
  afterEach(cleanup)

  it("注入假 projection：头部计数与每行「N 个钩子」都来自 projection", () => {
    render(<MethodologyPanel projection={fakeProjection} />)

    const scope = screen.getByTestId("methodology-panel-scope").textContent ?? ""
    expect(scope).toContain("有钩子的阶段 2 个")
    expect(scope).toContain("已启用钩子 2 个")
    expect(scope).toContain("声明钩子 3 个")

    expect(screen.getByTestId("methodology-stage-pre_write_prompt").textContent).toContain(
      "pre_write_prompt · 2 个钩子",
    )
    expect(screen.getByTestId("methodology-stage-pre_write_prompt").textContent).toContain(
      "aaa.hook zzz.hook",
    )
    expect(screen.getByTestId("methodology-stage-pre_six_dim_review").textContent).toContain(
      "pre_six_dim_review · 0 个钩子",
    )
    // 声明 3 / 生效 2 → 未启用 1 个必须显式说明，不能悄悄抹平。
    expect(screen.getByTestId("methodology-stage-pre_write_prompt").textContent).toContain("1 个未启用")
  })

  it("换一份 projection → UI 跟随变化（计数不硬编码）", () => {
    const { rerender } = render(<MethodologyPanel projection={fakeProjection} />)
    expect(screen.getByTestId("methodology-panel-scope").textContent).toContain("已启用钩子 2 个")

    rerender(<MethodologyPanel projection={projectionWithRealSources} />)
    expect(screen.getByTestId("methodology-panel-scope").textContent).toContain("已启用钩子 5 个")
    expect(screen.getByTestId("methodology-stage-pre_write_prompt").textContent).toContain(
      "pre_write_prompt · 5 个钩子",
    )
    expect(screen.queryByTestId("methodology-stage-pre_six_dim_review")).toBeNull()
  })

  it("缺真源的行渲染显式 N/A；有真源时不再 N/A", () => {
    const { rerender } = render(<MethodologyPanel projection={fakeProjection} />)
    expect(screen.getByTestId("methodology-na-prompt-hint-pre_write_prompt").textContent).toContain("N/A")
    expect(screen.getByTestId("methodology-na-trigger-pre_write_prompt").textContent).toContain("N/A")

    rerender(<MethodologyPanel projection={projectionWithRealSources} />)
    const promptHint = screen.getByTestId("methodology-na-prompt-hint-pre_write_prompt").textContent ?? ""
    const trigger = screen.getByTestId("methodology-na-trigger-pre_write_prompt").textContent ?? ""
    expect(promptHint).toBe("promptHint：有")
    expect(promptHint).not.toContain("N/A")
    expect(trigger).toBe("命中 4 次")
    expect(trigger).not.toContain("N/A")
  })

  it("缺真源清单逐条渲染 N/A（删掉 N/A 即红）", () => {
    render(<MethodologyPanel projection={fakeProjection} />)

    expect(screen.getByTestId("methodology-na-source-0").textContent).toContain("N/A")
    expect(screen.getByTestId("methodology-na-source-0").textContent).toContain("触发/命中次数")
    expect(screen.getByTestId("methodology-na-source-1").textContent).toContain("promptHint")
    expect(screen.queryByTestId("methodology-na-source-2")).toBeNull()
  })

  it("默认（不注入）：空注册表 → 无阶段行 + 空态 + 缺真源 N/A 仍在", () => {
    render(<MethodologyPanel />)

    expect(screen.queryByTestId("methodology-stage-pre_write_prompt")).toBeNull()
    expect(screen.queryByTestId("methodology-stage-pre_six_dim_review")).toBeNull()
    expect(screen.getByTestId("methodology-panel-empty").textContent).toContain("没有声明任何钩子")
    expect(screen.getByTestId("methodology-panel-scope").textContent).toContain("已启用钩子 0 个")
    expect(screen.getByTestId("methodology-na-source-0").textContent).toContain("N/A")
  })
})
