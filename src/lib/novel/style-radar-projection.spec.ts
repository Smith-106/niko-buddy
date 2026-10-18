/**
 * style-radar-projection.spec.ts — 风格/节奏雷达投影的**可失败**行为证据。
 *
 * 覆盖：无正文 → 全轴 N/A（不画 0 分）、有正文 → 六轴 0–100、
 * 目标节奏与代理指标不混量纲、目标风格文本不进半径、几何顶点对称与可复现、
 * 以及三条「不适用」声明（文风九维/文学分/叠量纲）。
 */
import { describe, expect, it } from "vitest"

import {
  STYLE_RADAR_NOT_APPLICABLE,
  projectStyleRadar,
  radarPoints,
  toPointsAttr,
} from "./style-radar-projection"

const SAMPLE = [
  "“你到底来不来？”林昭把门推开一条缝，风灌进来。",
  "她没有回答。走廊尽头的灯闪了一下，又灭了。",
  "他说：“那就别怪我。”话音落地，窗外的雨声忽然大起来，像有人拿指节在敲玻璃。",
].join("\n\n")

describe("无正文：全轴 N/A，不画 0 分雷达", () => {
  it("空输入 → 六轴 value 全 null、overall=null、缺正文写进 missingSources", () => {
    const p = projectStyleRadar({})
    expect(p.axes).toHaveLength(6)
    expect(p.axes.every((axis) => axis.value === null)).toBe(true)
    expect(p.usableAxisCount).toBe(0)
    expect(p.overall).toBeNull()
    expect(p.missingSources.some((m) => m.includes("章节正文"))).toBe(true)
    // 关键：不能出现「0 分」这种把缺失当零的表达
    expect(p.axes.map((a) => a.value)).not.toContain(0)
  })

  it("只有空白字符也等同无正文", () => {
    const p = projectStyleRadar({ text: "   \n\t " })
    expect(p.usableAxisCount).toBe(0)
  })
})

describe("有正文：六轴 0–100，来自机械打分器", () => {
  it("六轴都有有限值，且都在 0–100 内；overall 也在区间内", () => {
    const p = projectStyleRadar({ text: SAMPLE })
    expect(p.usableAxisCount).toBe(6)
    for (const axis of p.axes) {
      expect(axis.value).not.toBeNull()
      expect(axis.value!).toBeGreaterThanOrEqual(0)
      expect(axis.value!).toBeLessThanOrEqual(100)
    }
    expect(p.overall).not.toBeNull()
    expect(p.overall!).toBeGreaterThanOrEqual(0)
    expect(p.overall!).toBeLessThanOrEqual(100)
  })

  it("轴顺序固定为自评估六维顺序（顺序变了会红）", () => {
    const p = projectStyleRadar({ text: SAMPLE })
    expect(p.axes.map((a) => a.key)).toEqual([
      "length",
      "dialogueRatio",
      "paragraphRhythm",
      "sentenceVariety",
      "sceneBreaks",
      "openingHook",
    ])
    expect(p.axes.map((a) => a.label)).toEqual([
      "篇幅",
      "对话节奏",
      "段落节奏",
      "句式变化",
      "场景分段",
      "开篇钩子",
    ])
  })

  it("degraded（无 LLM 注入）必须如实说明，不写成已评审", () => {
    const p = projectStyleRadar({ text: SAMPLE })
    expect(p.missingSources.some((m) => m.includes("degraded"))).toBe(true)
    expect(p.missingSources.some((m) => m.includes("已评审"))).toBe(true)
  })

  it("同一正文两次投影深等（确定性）", () => {
    expect(projectStyleRadar({ text: SAMPLE })).toEqual(projectStyleRadar({ text: SAMPLE }))
  })
})

describe("目标节奏与目标风格文本：不同量纲、不进半径", () => {
  it("pressureLevel / emotionIntensity 原样透出（1–5 / 1–10），缺则 null", () => {
    const withTarget = projectStyleRadar({
      text: SAMPLE,
      target: { chapterLabel: "第 7 章", pressureLevel: 4, emotionIntensity: 8 },
    })
    expect(withTarget.target).toEqual({
      chapterLabel: "第 7 章",
      pressureLevel: 4,
      emotionIntensity: 8,
    })

    const noTarget = projectStyleRadar({ text: SAMPLE })
    expect(noTarget.target.pressureLevel).toBeNull()
    expect(noTarget.target.emotionIntensity).toBeNull()
    expect(noTarget.missingSources.some((m) => m.includes("章纲定位子弹"))).toBe(true)
  })

  it("目标节奏值不会被塞进雷达轴（量纲隔离）", () => {
    const p = projectStyleRadar({
      text: SAMPLE,
      target: { pressureLevel: 5, emotionIntensity: 10 },
    })
    expect(p.axes).toHaveLength(6)
    expect(p.axes.map((a) => a.key)).not.toContain("emotionIntensity" as never)
    expect(p.axes.map((a) => a.key)).not.toContain("pressureLevel" as never)
    // 量纲隔离的**可失败**断言：改目标节奏不得改变任何轴值（轴只来自正文机械打分）。
    const noTarget = projectStyleRadar({ text: SAMPLE })
    expect(p.axes).toEqual(noTarget.axes)
    expect(p.overall).toBe(noTarget.overall)
  })

  it("九个自由文本维全部可收集（按固定顺序），空串被丢弃", () => {
    const p = projectStyleRadar({
      text: SAMPLE,
      targetStyle: {
        narrativeVoice: "第三人称限知",
        dialogueStyle: "  ",
        sentenceStyle: "短句为主",
        emotionRendering: "以动作代替情绪词",
        narrativeDensity: "信息密度中等",
        descriptionWeight: "环境描写克制",
        rhetoricDensity: "少比喻",
        transitionStyle: "硬切",
        thematicHabits: "总写雨",
      },
    })
    expect(p.targetStyleText.map((i) => i.label)).toEqual([
      "叙事视角",
      "句式特征",
      "情绪呈现",
      "叙事密度",
      "描写比重",
      "修辞密度",
      "转场风格",
      "主题习惯",
    ])
    expect(p.targetStyleText.find((i) => i.label === "主题习惯")!.value).toBe("总写雨")
  })

  it("压力级/情绪越界（99）落 N/A，不照画", () => {
    const p = projectStyleRadar({
      text: SAMPLE,
      target: { pressureLevel: 99, emotionIntensity: -1 },
    })
    expect(p.target.pressureLevel).toBeNull()
    expect(p.target.emotionIntensity).toBeNull()
  })

  it("无目标风格 → missingSources 指出未选定风格画像", () => {
    const p = projectStyleRadar({ text: SAMPLE })
    expect(p.missingSources.some((m) => m.includes("目标风格文本"))).toBe(true)
  })
})

describe("不适用声明（防造假）", () => {
  it("三条 N/A 齐全：文风九维 / 文学分 / 叠量纲", () => {
    const p = projectStyleRadar({})
    expect(p.notApplicable.map((n) => n.id)).toEqual([
      "text-style-axes",
      "literary-score",
      "cross-scale-overlay",
    ])
    expect(STYLE_RADAR_NOT_APPLICABLE).toHaveLength(3)
    expect(p.notApplicable[0]!.reason).toContain("自由文本")
  })
})

describe("几何：顶点对称、可复现", () => {
  it("六轴满分时顶点半径一致，首个顶点在正上方", () => {
    const axes = Array.from({ length: 6 }, (_, i) => ({
      key: "length" as const,
      label: `轴${i}`,
      value: 100,
    }))
    const points = radarPoints(axes, 100, { x: 100, y: 100 })
    expect(points[0]!.x).toBeCloseTo(100, 6)
    expect(points[0]!.y).toBeCloseTo(0, 6)
    for (const p of points) {
      const r = Math.hypot(p.x - 100, p.y - 100)
      expect(r).toBeCloseTo(100, 6)
    }
  })

  it("value=null 的轴**不产生顶点**（不能落圆心，圆心就是 0 分点）", () => {
    const axes = [
      { key: "length" as const, label: "a", value: null },
      { key: "dialogeRatio" as never, label: "b", value: 100 },
    ]
    const points = radarPoints(axes, 100, { x: 0, y: 0 })
    expect(points).toHaveLength(1)
    expect(Math.hypot(points[0]!.x, points[0]!.y)).toBeCloseTo(100, 6)
  })

  it("缺值不会挤动其余顶点的角度（角度按原始轴位算）", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      key: "length" as const,
      label: `轴${i}`,
      value: i === 2 ? null : 100,
    }))
    const points = radarPoints(six, 100, { x: 0, y: 0 })
    expect(points).toHaveLength(5)
    // 第 0 轴仍在正上方；第 3 轴（原本 180°）仍在正下方
    expect(points[0]!.x).toBeCloseTo(0, 6)
    expect(points[0]!.y).toBeCloseTo(-100, 6)
    const bottom = points.find((p) => p.y > 0)
    expect(bottom!.x).toBeCloseTo(0, 6)
    expect(bottom!.y).toBeCloseTo(100, 6)
  })

  it("toPointsAttr 保留两位小数，便于稳定断言", () => {
    expect(toPointsAttr([{ x: 1.234, y: 5.678 }])).toBe("1.23,5.68")
    expect(toPointsAttr([])).toBe("")
  })
})
