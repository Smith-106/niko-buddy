import { describe, expect, it } from "vitest"
import {
  checkEightNodeStructure,
  checkEmotionArc,
  checkEnjoymentRhythm,
} from "./rhythm-checker"
import type { ChapterPosition } from "./chapter-positioning"

function pos(
  chapterNumber: number,
  type: ChapterPosition["type"],
  emotionIntensity: ChapterPosition["emotionIntensity"] = 8,
): ChapterPosition {
  return { chapterNumber, type, pressureLevel: 3, emotionIntensity, note: "" }
}

describe("checkEnjoymentRhythm", () => {
  it("totalChapters 为 0 时直接返回空（早退）", () => {
    expect(checkEnjoymentRhythm([], 0)).toEqual([])
    expect(checkEnjoymentRhythm([pos(1, "opening", 1)], 0)).toEqual([])
  })

  it("单章低强度 opening：逐章 + 3 章窗 + 7 章窗各报一条", () => {
    const warnings = checkEnjoymentRhythm([pos(1, "opening", 2)], 1)
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain("第1章")
    expect(warnings[0]).toContain("opening")
    expect(warnings[1]).toMatch(/第1-1章.*无高潮或转折/)
    expect(warnings[2]).toMatch(/第1-1章.*无高潮章/)
  })

  it("development 强度 3 报警、强度 4 不报（边界 emotionIntensity<=3）", () => {
    const low = checkEnjoymentRhythm([pos(1, "development", 3)], 1)
    expect(low.filter((w) => w.includes("微爽点"))).toHaveLength(1)
    const high = checkEnjoymentRhythm([pos(1, "development", 4)], 1)
    expect(high.filter((w) => w.includes("微爽点"))).toHaveLength(0)
    // 高强度 development 仍触发两个区间窗（无高潮/转折章）
    expect(high).toHaveLength(2)
  })

  it("非 opening/development 类型即使低强度也不报逐章（buildup/climax 豁免）", () => {
    expect(checkEnjoymentRhythm([pos(1, "buildup", 1)], 1).filter((w) => w.includes("微爽点"))).toHaveLength(0)
    expect(checkEnjoymentRhythm([pos(1, "climax", 1)], 1)).toEqual([])
    expect(checkEnjoymentRhythm([pos(1, "resolution", 1)], 1).filter((w) => w.includes("微爽点"))).toHaveLength(0)
  })

  it("turn 满足 3 章窗但不满足 7 章窗（turn≠climax 语义区分）", () => {
    const warnings = checkEnjoymentRhythm([pos(1, "turn"), pos(2, "turn"), pos(3, "turn")], 3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/第1-3章.*无高潮章/)
  })

  it("3 章窗内有 climax 即不报警；空窗不报警", () => {
    // 前 3 章含 climax → 静默；4-6 章空窗 → 静默
    expect(checkEnjoymentRhythm([pos(1, "climax")], 6)).toEqual([])
  })

  it("3 章窗无高潮/转折报警并钳制上界（min 建模）", () => {
    const warnings = checkEnjoymentRhythm([pos(8, "development", 9)], 8)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/第7-8章.*无高潮或转折/)
    expect(warnings[1]).toMatch(/第8-8章.*无高潮章/)
  })

  it("结尾连续 3 章收束/发展报警；被高潮打断则静默", () => {
    const bad = checkEnjoymentRhythm(
      [pos(1, "climax"), pos(2, "turn"), pos(3, "resolution"), pos(4, "resolution"), pos(5, "development")],
      5,
    )
    expect(bad).toHaveLength(2)
    expect(bad.some((w) => w.includes("结尾连续3章"))).toBe(true)
    expect(bad.some((w) => w.includes("第4-5"))).toBe(true)
    const good = checkEnjoymentRhythm(
      [pos(1, "climax"), pos(2, "turn"), pos(3, "resolution"), pos(4, "resolution"), pos(5, "climax")],
      5,
    )
    expect(good).toEqual([])
  })

  it("不足 3 章不做结尾检查", () => {
    expect(checkEnjoymentRhythm([pos(1, "climax"), pos(2, "turn")], 10)).toEqual([])
  })

  it("7 章窗上界钳制到 totalChapters", () => {
    const warnings = checkEnjoymentRhythm([pos(1, "development", 9)], 10)
    // 3 章窗第 1-3 报警 + 7 章窗第 1-7 报警；其余空窗静默
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toMatch(/第1-7章.*无高潮章/)
  })
})

describe("checkEightNodeStructure", () => {
  const FULL = [
    "对标结构坐标：1/4 节点、中点、3/4 节点、高潮节点安排如下",
    "章首钩子：悬念开局，第一转折为激励事件",
    "1/4 格局转折 → 中点情节逆转（关键事件）→ 3/4 推进至最终高潮",
    "卷尾收束：结尾伏笔，下一卷未解决问题",
    "情绪弧线 W形，爽点节奏表：爽点类型逐章安排",
  ].join("\n")

  it("完备卷纲零警告", () => {
    expect(checkEightNodeStructure(FULL)).toEqual([])
  })

  it("空卷纲报满 9 条（每条检查各一条）", () => {
    const warnings = checkEightNodeStructure("")
    expect(warnings).toHaveLength(9)
    expect(warnings.join("\n")).toContain("对标结构坐标")
    expect(warnings.join("\n")).toContain("开篇")
    expect(warnings.join("\n")).toContain("1/4")
    expect(warnings.join("\n")).toContain("中点")
    expect(warnings.join("\n")).toContain("3/4")
    expect(warnings.join("\n")).toContain("收束")
    expect(warnings.join("\n")).toContain("下一卷")
    expect(warnings.join("\n")).toContain("情绪弧线")
    expect(warnings.join("\n")).toContain("爽点节奏")
  })

  it("同义关键词各自命中（或分支全覆盖）", () => {
    expect(checkEightNodeStructure("结构节点")).toEqual(expect.not.arrayContaining([expect.stringContaining("缺少对标结构坐标表")]))
    expect(checkEightNodeStructure("开局悬念")).toEqual(expect.not.arrayContaining([expect.stringContaining("开篇")]))
    expect(checkEightNodeStructure("激励事件")).toEqual(expect.not.arrayContaining([expect.stringContaining("1/4位置")]))
    expect(checkEightNodeStructure("情节逆转")).toEqual(expect.not.arrayContaining([expect.stringContaining("中点位置")]))
    expect(checkEightNodeStructure("最终高潮")).toEqual(expect.not.arrayContaining([expect.stringContaining("3/4位置")]))
    expect(checkEightNodeStructure("卷尾")).toEqual(expect.not.arrayContaining([expect.stringContaining("缺少收束")]))
    expect(checkEightNodeStructure("伏笔")).toEqual(expect.not.arrayContaining([expect.stringContaining("下一卷钩子")]))
    expect(checkEightNodeStructure("情绪基调")).toEqual(expect.not.arrayContaining([expect.stringContaining("情绪弧线")]))
    expect(checkEightNodeStructure("爽点类型")).toEqual(expect.not.arrayContaining([expect.stringContaining("爽点节奏表")]))
  })

  it("部分缺失只报缺失项（收束有、钩子无）", () => {
    const warnings = checkEightNodeStructure("本卷结尾已收束")
    expect(warnings.some((w) => w.includes("下一卷"))).toBe(true)
    expect(warnings.some((w) => w.includes("缺少收束"))).toBe(false)
  })
})

describe("checkEmotionArc", () => {
  it("无情绪弧线段直接返回单条缺失警告（早退）", () => {
    expect(checkEmotionArc("本卷讲了一个故事")).toEqual(["缺少情绪弧线描述，无法检查情绪起伏"])
  })

  it("完备弧线零警告（含定位分布表）", () => {
    const full = "情绪弧线：W形折线，起点→下降→回升→再降→最终回升\n情绪强度阶梯上升逐级递增\n| 章 | 定位 | 压力级 |"
    expect(checkEmotionArc(full)).toEqual([])
  })

  it("备用表头同样有效（| 章 | 定位 | 情绪强度 |）", () => {
    const full = "情绪弧线 W形 上升 情绪值\n| 章 | 定位 | 情绪强度 |"
    expect(checkEmotionArc(full)).toEqual([])
  })

  it("只有弧线段时报 W形/阶梯/数值/分布表四条", () => {
    const warnings = checkEmotionArc("本卷情绪弧线概述")
    expect(warnings).toHaveLength(4)
    expect(warnings.join("\n")).toContain("W形")
    expect(warnings.join("\n")).toContain("阶梯")
    expect(warnings.join("\n")).toContain("数值")
    expect(warnings.join("\n")).toContain("分布表")
  })

  it("同义关键词各自命中（折线/逐级/压力级/情绪变化）", () => {
    const warnings = checkEmotionArc("情绪变化：折线逐级，压力级标注")
    // W形（折线✓）阶梯（逐级✓）数值（压力级✓）均命中，只缺分布表
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("分布表")
  })

  it("情绪基调同样算弧线段入口", () => {
    const warnings = checkEmotionArc("情绪基调平稳")
    expect(warnings.length).toBeGreaterThan(1)
    expect(warnings[0]).toContain("W形")
  })
})
