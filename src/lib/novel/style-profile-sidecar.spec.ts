import { describe, expect, it, vi } from "vitest"
import type { BookStyleProfile } from "./book-analysis/types"

// Mock loadStyleProfile so loadStyleProfileSidecar 的失败/成功路径可控。
const loadStyleProfileMock = vi.hoisted(() => vi.fn())
vi.mock("./book-analysis/result-loader", () => ({
  loadStyleProfile: loadStyleProfileMock,
}))

import {
  loadStyleProfileSidecar,
  renderStyleProfileSidecar,
} from "./style-profile-sidecar"

function makeProfile(overrides: Partial<BookStyleProfile> = {}): BookStyleProfile {
  return {
    schemaVersion: 1,
    generatedAt: 0,
    sampledChapterIds: [],
    narrativeDensity: "中密度",
    descriptionWeight: "克制",
    emotionRendering: "内敛",
    sentenceStyle: "短句为主",
    rhetoricDensity: "低频比喻",
    transitionStyle: "画面切接",
    narrativeVoice: "第三人称限知",
    dialogueStyle: "简短对白",
    thematicHabits: "命运与责任",
    constitution: "保持短句；避免过度抒情；对白简短。",
    samples: ["第一段模仿锚点。", "第二段模仿锚点。", "第三段（应被截断）。"],
    ...overrides,
  }
}

describe("renderStyleProfileSidecar", () => {
  it("无 styleProfile 时返回空串", () => {
    expect(renderStyleProfileSidecar({})).toBe("")
    expect(renderStyleProfileSidecar({ styleProfile: undefined })).toBe("")
  })

  it("有 styleProfile 时返回含标题/风格宪法/关键维度/模仿锚点的文本块", () => {
    const text = renderStyleProfileSidecar({
      styleProfile: makeProfile(),
      sourceBook: "demo-book",
    })

    expect(text).toContain("# 风格画像辅助 (P14 sidecar)")
    expect(text).toContain("源作品：demo-book")
    // 风格宪法完整保留
    expect(text).toContain("## 风格宪法（硬约束）")
    expect(text).toContain("保持短句；避免过度抒情；对白简短。")
    // 关键维度
    expect(text).toContain("## 关键维度")
    expect(text).toContain("叙事视角：第三人称限知")
    expect(text).toContain("对白风格：简短对白")
    expect(text).toContain("句式特征：短句为主")
    // few-shot 锚点
    expect(text).toContain("## 模仿锚点（few-shot）")
    expect(text).toContain("第一段模仿锚点。")
  })

  it("samples 只保留前 2 段，第三段被截断", () => {
    const text = renderStyleProfileSidecar({ styleProfile: makeProfile() })
    expect(text).toContain("第一段模仿锚点。")
    expect(text).toContain("第二段模仿锚点。")
    expect(text).not.toContain("第三段")
  })

  it("关键维度为空时不渲染该节", () => {
    const text = renderStyleProfileSidecar({
      styleProfile: makeProfile({
        narrativeVoice: "",
        dialogueStyle: "",
        sentenceStyle: "",
      }),
    })
    expect(text).not.toContain("## 关键维度")
  })

  it("无 sourceBook 时不渲染源作品行", () => {
    const text = renderStyleProfileSidecar({ styleProfile: makeProfile() })
    expect(text).not.toContain("源作品：")
  })
})

describe("loadStyleProfileSidecar", () => {
  it("bookPath undefined 返回空 input", async () => {
    const input = await loadStyleProfileSidecar(undefined)
    expect(input).toEqual({})
    expect(loadStyleProfileMock).not.toHaveBeenCalled()
  })

  it("loadStyleProfile 返回 null 时返回空 input", async () => {
    loadStyleProfileMock.mockResolvedValueOnce(null)
    const input = await loadStyleProfileSidecar("/some/book-analysis/book-1")
    expect(input).toEqual({})
  })

  it("loadStyleProfile 成功时返回 styleProfile + sourceBook", async () => {
    const profile = makeProfile()
    loadStyleProfileMock.mockResolvedValueOnce(profile)
    const input = await loadStyleProfileSidecar("/some/book-analysis/book-1")
    expect(input.styleProfile).toBe(profile)
    expect(input.sourceBook).toBe("book-1")
  })

  it("loadStyleProfile 抛错时非阻断降级为空 input", async () => {
    loadStyleProfileMock.mockRejectedValueOnce(new Error("disk gone"))
    const input = await loadStyleProfileSidecar("/some/book-analysis/book-1")
    expect(input).toEqual({})
  })
})
