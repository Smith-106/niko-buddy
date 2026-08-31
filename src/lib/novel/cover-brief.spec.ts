import { describe, expect, it } from "vitest"
import { buildCoverBrief, coverBriefToPrompt, validateCoverBrief, type CoverBrief, type BookCoverMeta } from "./cover-brief"

const META: BookCoverMeta = {
  title: "长夜灯",
  genre: "悬疑",
  protagonistBrief: "白发侦探，风衣立于雨夜街口",
  tone: "压抑",
  keyImagery: ["纸灯", "雨巷"],
}

describe("cover-brief（吸收自 ANWA services/image 的封面契约模式，provider 无关）", () => {
  it("已知题材走映射视觉语言", () => {
    const brief = buildCoverBrief(META)
    expect(brief.palette).toContain("暗青")
    expect(brief.composition).toContain("留白")
    expect(brief.titlePlacement).toBe("bottom")
    expect(brief.subject).toContain("纸灯")
    expect(brief.subject).toContain("白发侦探")
  })

  it("未知题材走默认视觉", () => {
    const brief = buildCoverBrief({ ...META, genre: "奇幻冒险" })
    expect(brief.composition).toContain("竖版人物居中")
    expect(brief.palette).toContain("中性色")
  })

  it("暗黑基调追加约束", () => {
    const brief = buildCoverBrief(META)
    expect(brief.constraints.some((c) => c.includes("高饱和大色块"))).toBe(true)
    const warm = buildCoverBrief({ ...META, tone: "温暖" })
    expect(warm.constraints.some((c) => c.includes("高饱和大色块"))).toBe(false)
  })

  it("validateCoverBrief：合法 brief 零错误；空 brief 逐项报错", () => {
    expect(validateCoverBrief(buildCoverBrief(META))).toEqual({ errors: [], verdict: "valid" })
    const empty: CoverBrief = {
      subject: "",
      composition: "",
      palette: "",
      moodKeywords: [],
      titlePlacement: "top",
      constraints: [],
    }
    const result = validateCoverBrief(empty)
    expect(result.verdict).toBe("invalid")
    expect(result.errors).toHaveLength(5)
  })

  it("coverBriefToPrompt 渲染完整契约", () => {
    const prompt = coverBriefToPrompt(buildCoverBrief(META), META.title)
    expect(prompt).toContain("《长夜灯》")
    expect(prompt).toContain("主体：")
    expect(prompt).toContain("1.")
    expect(prompt).toContain("书名排布：bottom")
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(buildCoverBrief(META))).toBe(JSON.stringify(buildCoverBrief(META)))
  })
})
