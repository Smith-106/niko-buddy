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
  resolveArcEndChapterForChapter,
  shouldTriggerArcSettlement,
  type ArcSettlementStep,
} from "./arc-settlement"
import type { OutlineModel } from "./outline-model"
import type { VolumeMeta } from "./volume"

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

function makeOutlineChapter(volume: number, chapter: number, arc = "") {
  return {
    id: `v${String(volume).padStart(2, "0")}c${String(chapter).padStart(3, "0")}`,
    volume,
    chapter,
    title: `第${chapter}章`,
    pov: "",
    arc,
    entities: [],
    foreshadow: { plant: [], payoff: [] },
    constraints: [],
    prose: { goal: "", scenes: [], emotion: "" },
    updatedAt: "2026-01-01",
  }
}

describe("resolveArcEndChapterForChapter", () => {
  it("非法章号或空边界来源返回 null", () => {
    expect(resolveArcEndChapterForChapter(0, { explicitArcEnds: [5] })).toBeNull()
    expect(resolveArcEndChapterForChapter(-2, { explicitArcEnds: [5] })).toBeNull()
    expect(resolveArcEndChapterForChapter(1.5, { explicitArcEnds: [5] })).toBeNull()
    expect(resolveArcEndChapterForChapter(3)).toBeNull()
    expect(resolveArcEndChapterForChapter(3, { outlineModel: null, volumes: [], explicitArcEnds: [] })).toBeNull()
  })

  it("explicitArcEnds 优先并取 >= 当前章的最小合法弧尾，不重复触发已过去弧尾", () => {
    const ends = [10, 5, -1, 15, 5]
    const snapshot = [...ends]
    expect(resolveArcEndChapterForChapter(3, { explicitArcEnds: ends })).toBe(5)
    expect(resolveArcEndChapterForChapter(5, { explicitArcEnds: ends })).toBe(5)
    expect(shouldTriggerArcSettlement(5, resolveArcEndChapterForChapter(5, { explicitArcEnds: ends }))).toBe(true)
    expect(resolveArcEndChapterForChapter(6, { explicitArcEnds: ends })).toBe(10)
    expect(shouldTriggerArcSettlement(6, resolveArcEndChapterForChapter(6, { explicitArcEnds: ends }))).toBe(false)
    expect(resolveArcEndChapterForChapter(16, { explicitArcEnds: ends })).toBeNull()
    expect(ends).toEqual(snapshot)
  })

  it("outlineModel 按同卷连续 arc 标签推导弧尾，无 arc 标签时退化到卷末章", () => {
    const outlineModel: OutlineModel = {
      schemaVersion: 2,
      updatedAt: "2026-01-01",
      volumes: [
        {
          number: 2,
          title: "第二卷",
          arc: "",
          chapters: [
            makeOutlineChapter(2, 7, ""),
            makeOutlineChapter(2, 10, ""),
          ],
        },
        {
          number: 1,
          title: "第一卷",
          arc: "初入江湖",
          chapters: [
            makeOutlineChapter(1, 3, "入门篇"),
            makeOutlineChapter(1, 1, "入门篇"),
            makeOutlineChapter(1, 2, "入门篇"),
            makeOutlineChapter(1, 4, "宗门大比"),
            makeOutlineChapter(1, 6, "宗门大比"),
            makeOutlineChapter(1, 5, "宗门大比"),
          ],
        },
      ],
    }

    // 第一卷弧段 1：Ch 1..3 ("入门篇") -> 弧尾 3
    expect(resolveArcEndChapterForChapter(1, { outlineModel })).toBe(3)
    expect(resolveArcEndChapterForChapter(3, { outlineModel })).toBe(3)
    expect(shouldTriggerArcSettlement(2, resolveArcEndChapterForChapter(2, { outlineModel }))).toBe(false)
    expect(shouldTriggerArcSettlement(3, resolveArcEndChapterForChapter(3, { outlineModel }))).toBe(true)

    // 第一卷弧段 2：Ch 4..6 ("宗门大比") -> 弧尾 6
    expect(resolveArcEndChapterForChapter(4, { outlineModel })).toBe(6)
    expect(resolveArcEndChapterForChapter(6, { outlineModel })).toBe(6)

    // 第二卷无 arc 标签，Ch 7 与区间内缺口章 Ch 8 均退化到卷末章 10
    expect(resolveArcEndChapterForChapter(7, { outlineModel })).toBe(10)
    expect(resolveArcEndChapterForChapter(8, { outlineModel })).toBe(10)
    expect(resolveArcEndChapterForChapter(10, { outlineModel })).toBe(10)

    // 超出大纲范围返回 null
    expect(resolveArcEndChapterForChapter(11, { outlineModel })).toBeNull()
  })

  it("outlineModel 未命中时回退至 volumes 卷册元数据，并取最近包含卷的 chapterRangeEnd", () => {
    const volumes: VolumeMeta[] = [
      { volumeNumber: 1, title: "第一卷", summary: "", chapterRangeStart: 1, chapterRangeEnd: 12 },
      { volumeNumber: 2, title: "子卷", summary: "", chapterRangeStart: 5, chapterRangeEnd: 8 },
      { volumeNumber: 3, title: "已过去卷", summary: "", chapterRangeStart: 1, chapterRangeEnd: 3 },
    ]
    expect(resolveArcEndChapterForChapter(4, { volumes })).toBe(12)
    expect(resolveArcEndChapterForChapter(6, { volumes })).toBe(8)
    expect(resolveArcEndChapterForChapter(8, { volumes })).toBe(8)
    expect(shouldTriggerArcSettlement(8, resolveArcEndChapterForChapter(8, { volumes }))).toBe(true)
    expect(resolveArcEndChapterForChapter(13, { volumes })).toBeNull()
  })

  it("显式 explicitArcEnds 覆盖 outlineModel 与 volumes", () => {
    const outlineModel: OutlineModel = {
      schemaVersion: 2,
      updatedAt: "2026-01-01",
      volumes: [
        { number: 1, title: "第一卷", arc: "", chapters: [makeOutlineChapter(1, 1), makeOutlineChapter(1, 10)] },
      ],
    }
    const volumes: VolumeMeta[] = [
      { volumeNumber: 1, title: "第一卷", summary: "", chapterRangeStart: 1, chapterRangeEnd: 10 },
    ]
    expect(
      resolveArcEndChapterForChapter(4, { outlineModel, volumes, explicitArcEnds: [4, 9] }),
    ).toBe(4)
  })
})
