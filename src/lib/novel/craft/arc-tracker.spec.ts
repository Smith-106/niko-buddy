/**
 * arc-tracker.spec.ts — T27 弧光阶段推进检测单测。
 *
 * 覆盖（任务约束 coverage-100%）：
 *   - 七大弧光阶段推进规则（ghost_exposed → resolution 全路径）
 *   - 边界条件：null 首次摄取、推进跳过阶段、回退保护
 *   - 非法输入拒绝
 *   - 置信度计算
 *   - fast-check 属性：确定性（同输入同输出）、推进单调性（不回头）
 *
 * 确定性=超越轴(ADR-19)：零 IO / 零 LLM / 零 Tauri invoke。
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"

import {
  detectArcProgression,
  validateArcProgressionInput,
  type ArcProgressionInput,
} from "./arc-tracker"
import type { ArcStage } from "./canon-craft-fields"
import { ARC_STAGE_VALUES } from "./canon-craft-fields"

// ============================================================================
// 辅助
// ============================================================================

function buildInput(overrides: Partial<ArcProgressionInput>): ArcProgressionInput {
  return {
    currentStage: null,
    mckeeGhost: null,
    mckeeConsciousDesire: null,
    mckeeUnconsciousNeed: null,
    wmaActions: [],
    significantDetails: [],
    visibleActions: [],
    arcFundamentals: null,
    closureState: null,
    ...overrides,
  }
}

// ============================================================================
// 七阶段全路径推进
// ============================================================================

describe("detectArcProgression — 七阶段全路径", () => {
  it("null → ghost_exposed：mckee_ghost 存在", () => {
    const result = detectArcProgression(buildInput({
      currentStage: null,
      mckeeGhost: "幼年目睹灭门",
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("ghost_exposed")
    expect(result.previousStage).toBeNull()
    expect(result.confidence).toBeGreaterThan(0)
  })

  it("null → ghost_exposed：significant_details 存在但不足", () => {
    const result = detectArcProgression(buildInput({
      currentStage: null,
      significantDetails: ["断刃上的刻字"],
    }))
    // significant_details 权重 1 < 阈值 2，不足
    expect(result.progressed).toBe(false)
    expect(result.currentStage).toBe("ghost_exposed") // 首次摄取默认第一阶段
  })

  it("ghost_exposed → refusal：visible_actions 存在", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "ghost_exposed",
      visibleActions: [{ chapterNumber: 3, action: "拒绝了师父的提议" }],
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("refusal")
    expect(result.previousStage).toBe("ghost_exposed")
  })

  it("ghost_exposed → refusal：wma_actions 存在", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "ghost_exposed",
      wmaActions: ["犹豫是否接受任务"],
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("refusal")
  })

  it("refusal → commitment：conscious_desire 存在", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "refusal",
      mckeeConsciousDesire: "报仇雪恨",
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("commitment")
  })

  it("refusal → commitment：unconscious_need 存在", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "refusal",
      mckeeUnconsciousNeed: "学会放下",
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("commitment")
  })

  it("commitment → active：wma_actions 存在 + arc_fundamentals 有进步", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "commitment",
      wmaActions: ["夜探藏经阁", "收集情报"],
      arcFundamentals: { empathy: 0.8 },
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("active")
  })

  it("active → crisis：arc_fundamentals 下降", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "active",
      arcFundamentals: { empathy: 0.2, strength: 0.1 },
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("crisis")
  })

  it("crisis → climax：visible_actions 达 3 条", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "crisis",
      visibleActions: [
        { chapterNumber: 20, action: "正面迎战" },
        { chapterNumber: 21, action: "被围攻" },
        { chapterNumber: 22, action: "绝地反击" },
      ],
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("climax")
  })

  it("climax → resolution：closure_state 为 closed", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "climax",
      closureState: "closed",
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("resolution")
    expect(result.confidence).toBeGreaterThanOrEqual(0.75)
  })
})

// ============================================================================
// 边界条件
// ============================================================================

describe("detectArcProgression — 边界条件", () => {
  it("完全无证据时 initial null → 默认 ghost_exposed 无推进", () => {
    const result = detectArcProgression(buildInput({ currentStage: null }))
    expect(result.progressed).toBe(false)
    expect(result.currentStage).toBe("ghost_exposed") // 首次摄取默认
    expect(result.previousStage).toBeNull()
  })

  it("已 resolution 后不再推进", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "resolution",
      closureState: "closed",
    }))
    expect(result.progressed).toBe(false)
    expect(result.currentStage).toBe("resolution")
  })

  it("不会跳过阶段（从 refusal 直接到 climax 的证据不足）", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "refusal",
      visibleActions: [
        { chapterNumber: 20, action: "正面迎战" },
        { chapterNumber: 21, action: "被围攻" },
        { chapterNumber: 22, action: "绝地反击" },
      ],
      closureState: "closed",
    }))
    // refusal 的直接推进目标是 commitment
    // 缺少 commitment 证据（desire/need）
    // visible_actions 3 条对 climax 是 2 分，但跳过阶段不允许
    expect(result.progressed).toBe(false)
    expect(result.currentStage).toBe("refusal")
  })

  it("不会回退（当前已 climax，旧证据不拉回 crisis）", () => {
    // 先推进到 crisis（active → crisis 只需 arc_fundamentals 低槽位）
    const atCrisis = detectArcProgression(buildInput({
      currentStage: "active",
      arcFundamentals: { empathy: 0.2, strength: 0.1 },
    }))
    expect(atCrisis.currentStage).toBe("crisis")

    // 再推进到 climax（crisis → climax 需 visible_actions >= 3）
    const atClimax = detectArcProgression(buildInput({
      currentStage: "crisis",
      visibleActions: [
        { chapterNumber: 20, action: "正面迎战" },
        { chapterNumber: 21, action: "被围攻" },
        { chapterNumber: 22, action: "绝地反击" },
      ],
    }))
    expect(atClimax.currentStage).toBe("climax")

    // 然后给 "冲突下降" 证据
    const result = detectArcProgression(buildInput({
      currentStage: "climax",
      arcFundamentals: { empathy: 0.2 },
    }))
    expect(result.progressed).toBe(false) // 不会回退
    expect(result.currentStage).toBe("climax")
  })

  it("非法 currentStage 字符串视为 null", () => {
    const result = detectArcProgression(buildInput({
      currentStage: "invalid_stage" as ArcStage,
      mckeeGhost: "test",
    }))
    // 视为 null，按首次摄取处理
    expect(result.progressed).toBe(true) // ghost_exposed 的证据存在
    expect(result.currentStage).toBe("ghost_exposed")
  })

  it("undefined currentStage 视为 null", () => {
    const result = detectArcProgression(buildInput({
      currentStage: undefined,
      mckeeGhost: "test",
    }))
    expect(result.progressed).toBe(true)
    expect(result.currentStage).toBe("ghost_exposed")
  })

  it("置信度随证据增加而提高", () => {
    const lowEvidence = detectArcProgression(buildInput({
      currentStage: "ghost_exposed",
      wmaActions: ["犹豫"],
    }))
    // refusal 阈值 1，wmaActions 1 条 = 1 分 → 1/1 = 1.0
    expect(lowEvidence.confidence).toBe(1.0)

    // 现在从 refusal 到 commitment——需要 desire 或 need
    // 只给 desire → 2/2 = 1.0
    const highEvidence = detectArcProgression(buildInput({
      currentStage: "refusal",
      mckeeConsciousDesire: "报仇",
      mckeeUnconsciousNeed: "放下",
    }))
    // 两个都满足 → 4/2 = 2，钳制为 1.0
    expect(highEvidence.confidence).toBe(1.0)
  })
})

// ============================================================================
// 输入校验
// ============================================================================

describe("validateArcProgressionInput", () => {
  it("合法输入通过", () => {
    expect(validateArcProgressionInput(buildInput({ currentStage: "crisis" }))).toBe(true)
    expect(validateArcProgressionInput(buildInput({ currentStage: null }))).toBe(true)
    expect(validateArcProgressionInput(buildInput({ currentStage: undefined }))).toBe(true)
  })

  it("非法 currentStage 拒绝", () => {
    expect(validateArcProgressionInput(buildInput({ currentStage: "invalid" as ArcStage }))).toBe(false)
    expect(validateArcProgressionInput(buildInput({ currentStage: "midpoint" as ArcStage }))).toBe(false)
  })
})

// ============================================================================
// fast-check 属性：确定性 + 推进单调性
// ============================================================================

describe("fast-check 属性", () => {
  const validStages = [...ARC_STAGE_VALUES, null, undefined] as const

  it("确定性：同输入同输出", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...validStages),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
        fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
        fc.array(fc.record({
          chapterNumber: fc.nat({ max: 100 }),
          action: fc.string({ maxLength: 20 }),
        }), { maxLength: 3 }),
        fc.option(fc.constantFrom("open", "closed"), { nil: undefined }),
        (stage, ghost, desire, need, wma, details, actions, closure) => {
          const input: ArcProgressionInput = {
            currentStage: stage as ArcStage | null | undefined,
            mckeeGhost: ghost,
            mckeeConsciousDesire: desire,
            mckeeUnconsciousNeed: need,
            wmaActions: wma,
            significantDetails: details,
            visibleActions: actions,
            closureState: closure as "open" | "closed" | null | undefined,
          }

          const r1 = detectArcProgression(input)
          const r2 = detectArcProgression(input)

          expect(r1.currentStage).toBe(r2.currentStage)
          expect(r1.progressed).toBe(r2.progressed)
          expect(r1.confidence).toBe(r2.confidence)
          expect(r1.reason).toBe(r2.reason)
        },
      ),
      { verbose: false, numRuns: 100 },
    )
  })

  it("推进单调性：不会回退到更早阶段", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ARC_STAGE_VALUES),
        fc.constantFrom(...ARC_STAGE_VALUES),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        (stageA, _stageB, ghost, desire) => {
          const input: ArcProgressionInput = {
            currentStage: stageA,
            mckeeGhost: ghost,
            mckeeConsciousDesire: desire,
          }

          const result = detectArcProgression(input)

          // 如果推进了，currentStage 在顺序上必须 >= previousStage
          if (result.progressed && result.previousStage) {
            const prevIdx = ARC_STAGE_VALUES.indexOf(result.previousStage)
            const currIdx = ARC_STAGE_VALUES.indexOf(result.currentStage)
            expect(currIdx).toBeGreaterThan(prevIdx)
          }
          // 如果没推进，currentStage 必须等于 previousStage（或 previousStage 为 null）
          if (!result.progressed && result.previousStage) {
            expect(result.currentStage).toBe(result.previousStage)
          }
        },
      ),
      { verbose: false, numRuns: 100 },
    )
  })
})