/**
 * arc-settlement.spec.ts — G4 弧末结算编排契约层测试
 *
 * 覆盖 shouldTriggerArcSettlement (null/相等/超前/未到) 与
 * nextArcSettlementStep (空/部分/乱序/重复/全完成) 纯函数语义。
 * ADR-19: 纯函数断言, 零 IO / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import {
  ARC_SETTLEMENT_ORDER,
  nextArcSettlementStep,
  shouldTriggerArcSettlement,
  type ArcSettlementStep,
} from "./arc-settlement"

describe("shouldTriggerArcSettlement", () => {
  it("arcEndChapter 为 null 时永不触发", () => {
    expect(shouldTriggerArcSettlement(10, null)).toBe(false)
    expect(shouldTriggerArcSettlement(0, null)).toBe(false)
  })

  it("未到弧尾章不触发", () => {
    expect(shouldTriggerArcSettlement(9, 10)).toBe(false)
  })

  it("恰好等于弧尾章触发 (边界)", () => {
    expect(shouldTriggerArcSettlement(10, 10)).toBe(true)
  })

  it("超前于弧尾章仍触发", () => {
    expect(shouldTriggerArcSettlement(11, 10)).toBe(true)
    expect(shouldTriggerArcSettlement(99, 10)).toBe(true)
  })
})

describe("nextArcSettlementStep", () => {
  it("空 done 返回首步 arc_review", () => {
    expect(nextArcSettlementStep([])).toBe("arc_review")
  })

  it("按事务顺序返回下一个未完成步骤", () => {
    expect(nextArcSettlementStep(["arc_review"])).toBe("summary")
    expect(
      nextArcSettlementStep(["arc_review", "summary", "volume_summary"]),
    ).toBe("expand")
    expect(
      nextArcSettlementStep([
        "arc_review",
        "summary",
        "volume_summary",
        "expand",
      ]),
    ).toBe("new_volume")
  })

  it("done 乱序仍按事务顺序推导 (跳过已完成)", () => {
    const done: ArcSettlementStep[] = ["expand", "arc_review"]
    expect(nextArcSettlementStep(done)).toBe("summary")
  })

  it("done 重复不影响结果", () => {
    expect(
      nextArcSettlementStep(["arc_review", "arc_review", "summary"]),
    ).toBe("volume_summary")
  })

  it("全部完成返回 null", () => {
    expect(
      nextArcSettlementStep([
        "arc_review",
        "summary",
        "volume_summary",
        "expand",
        "new_volume",
      ]),
    ).toBeNull()
  })

  it("全完成乱序仍返回 null", () => {
    expect(
      nextArcSettlementStep([
        "new_volume",
        "expand",
        "summary",
        "volume_summary",
        "arc_review",
      ]),
    ).toBeNull()
  })

  it("不突变入参", () => {
    const done: ArcSettlementStep[] = ["summary"]
    const snapshot = [...done]
    nextArcSettlementStep(done)
    expect(done).toEqual(snapshot)
  })
})

describe("ARC_SETTLEMENT_ORDER", () => {
  it("事务顺序为 arc_review→summary→volume_summary→expand→new_volume", () => {
    expect([...ARC_SETTLEMENT_ORDER]).toEqual([
      "arc_review",
      "summary",
      "volume_summary",
      "expand",
      "new_volume",
    ])
  })
})
