import { describe, expect, it } from "vitest"
import {
  buildNovelReviewActionItem,
  buildVisibleNovelReviewActionItems,
  mapNovelReviewActionSeverity,
} from "@/lib/novel-review-action-items"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"

// G2 DD-1: buildNovelReviewActionItem continuityMeta additive 透传单测
// (review-adapter.spec 测 toConsistencyReviewResult 输出 continuityMeta, 本层
// 测 buildNovelReviewActionItem 把 result.continuityMeta 透传到 action item 的
// additive spread, 非连续性 finding 无此字段零行为变更)
describe("buildNovelReviewActionItem continuityMeta 透传 (G2 DD-1)", () => {
  it("透传 continuityMeta 当 result 携带该字段 (additive spread)", () => {
    const result: NovelReviewResult = {
      severity: "error",
      type: "consistency_mechanical",
      message: "死亡角色状态矛盾",
      evidence: "",
      relatedMemory: "",
      suggestion: "修正死亡角色状态层",
      continuityMeta: { subtype: "consistency_mechanical", ref: "character:死者", chapter: 8, missingField: "lastSeenChapter" },
    }
    const item = buildNovelReviewActionItem("E:/Novel/chapter-8.md", result)
    expect(item.continuityMeta).toEqual({
      subtype: "consistency_mechanical",
      ref: "character:死者",
      chapter: 8,
      missingField: "lastSeenChapter",
    })
    expect(item.message).toBe("死亡角色状态矛盾")
    expect(item.detail).toBe("consistency_mechanical")
    expect(item.reviewSeverity).toBe("error")
    expect(item.source).toBe("review")
  })

  it("非 continuity finding 无 continuityMeta 字段零行为变更 (undefined)", () => {
    const result: NovelReviewResult = {
      severity: "warning",
      type: "character_consistency",
      message: "人物动机不连贯",
      evidence: "某段落",
      relatedMemory: "",
      suggestion: "补内心独白",
    }
    const item = buildNovelReviewActionItem("E:/Novel/chapter-8.md", result)
    // DD-1 additive: 非连续性 finding 无 continuityMeta, undefined 零行为变更
    expect(item.continuityMeta).toBeUndefined()
    expect(item.evidence).toBe("某段落")
  })

  it("severity 映射 error→high / warning→medium / info→low", () => {
    expect(mapNovelReviewActionSeverity("error")).toBe("high")
    expect(mapNovelReviewActionSeverity("warning")).toBe("medium")
    expect(mapNovelReviewActionSeverity("info")).toBe("low")
  })

  it("buildVisibleNovelReviewActionItems 过滤 ignored id 并透传 continuityMeta", () => {
    const results: NovelReviewResult[] = [
      {
        severity: "error",
        type: "consistency_mechanical",
        message: "死亡角色状态矛盾",
        evidence: "",
        relatedMemory: "",
        suggestion: "修正",
        continuityMeta: { subtype: "consistency_mechanical", ref: "character:死者", chapter: 8 },
      },
      {
        severity: "warning",
        type: "character_consistency",
        message: "动机不连贯",
        evidence: "段",
        relatedMemory: "",
        suggestion: "补",
      },
    ]
    const items = buildVisibleNovelReviewActionItems("E:/Novel/chapter-8.md", results, {})
    expect(items).toHaveLength(2)
    expect(items[0].continuityMeta?.ref).toBe("character:死者")
    expect(items[1].continuityMeta).toBeUndefined()
  })
})
