/**
 * F-011: Voice Preservation 第二层 — voiceStyleGuide 序列化/反序列化/默认值测试。
 *
 * BookStyleProfile 新增 voiceStyleGuide 字段，测试其 JSON 序列化/反序列化
 * 完整性及默认值行为。
 */
import { describe, expect, it } from "vitest"
import type { BookStyleProfile } from "./types"

const MINIMAL_PROFILE: BookStyleProfile = {
  schemaVersion: 1,
  generatedAt: 1712345678000,
  sampledChapterIds: ["ch-001", "ch-005"],
  narrativeDensity: "中",
  descriptionWeight: "中",
  emotionRendering: "中",
  sentenceStyle: "长短句交错",
  rhetoricDensity: "低",
  transitionStyle: "自然过渡",
  narrativeVoice: "第三人称有限",
  dialogueStyle: "简洁",
  thematicHabits: "命运主题",
  constitution: "保持叙事节奏，避免过度描写",
  samples: ["样本段落1", "样本段落2"],
}

describe("F-011 voiceStyleGuide 序列化/反序列化", () => {
  it("voiceStyleGuide 可选字段 — 缺失时序列化不包含该字段", () => {
    const json = JSON.stringify(MINIMAL_PROFILE)
    const parsed = JSON.parse(json) as BookStyleProfile
    expect(parsed.voiceStyleGuide).toBeUndefined()
  })

  it("voiceStyleGuide 完整序列化/反序列化", () => {
    const profile: BookStyleProfile = {
      ...MINIMAL_PROFILE,
      voiceStyleGuide: {
        punctuationStyle: "中文引号「」",
        paragraphStyle: "首行缩进两字符",
        dialogueTagStyle: "动作描写代替说",
      },
    }
    const json = JSON.stringify(profile)
    const parsed = JSON.parse(json) as BookStyleProfile
    expect(parsed.voiceStyleGuide).toBeDefined()
    expect(parsed.voiceStyleGuide!.punctuationStyle).toBe("中文引号「」")
    expect(parsed.voiceStyleGuide!.paragraphStyle).toBe("首行缩进两字符")
    expect(parsed.voiceStyleGuide!.dialogueTagStyle).toBe("动作描写代替说")
  })

  it("voiceStyleGuide 部分字段 — 序列化后部分字段仍可读", () => {
    const profile: BookStyleProfile = {
      ...MINIMAL_PROFILE,
      voiceStyleGuide: {
        punctuationStyle: "使用中文引号",
        paragraphStyle: "",
        dialogueTagStyle: "",
      },
    }
    const json = JSON.stringify(profile)
    const parsed = JSON.parse(json) as BookStyleProfile
    expect(parsed.voiceStyleGuide!.punctuationStyle).toBe("使用中文引号")
    expect(parsed.voiceStyleGuide!.paragraphStyle).toBe("")
    expect(parsed.voiceStyleGuide!.dialogueTagStyle).toBe("")
  })

  it("voiceStyleGuide 默认值 — 新建 BookStyleProfile 时 voiceStyleGuide 可选为 undefined", () => {
    // 向后兼容：旧 profile 不含 voiceStyleGuide 仍可正常解析
    const profile: BookStyleProfile = {
      ...MINIMAL_PROFILE,
    }
    expect(profile.voiceStyleGuide).toBeUndefined()
  })

  it("voiceStyleGuide 与 constitution/samples 字段共存", () => {
    const profile: BookStyleProfile = {
      ...MINIMAL_PROFILE,
      constitution: "硬约束1，硬约束2",
      samples: ["样本A", "样本B", "样本C"],
      voiceStyleGuide: {
        punctuationStyle: "「」",
        paragraphStyle: "缩进2字符",
        dialogueTagStyle: "说+动作",
      },
    }
    expect(profile.constitution).toBeTruthy()
    expect(profile.samples).toHaveLength(3)
    expect(profile.voiceStyleGuide!.punctuationStyle).toBe("「」")
  })
})