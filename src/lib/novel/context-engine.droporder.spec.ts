import { describe, expect, it } from "vitest"
import { trimContextPack, type ContextPack } from "./context-engine"

function packWithDropOrderTargets(): ContextPack {
  const big = (ch: string, n: number) => ch.repeat(n)
  return {
    task: "写第5章",
    chapterGoal: "章节目标",
    outline: "大纲",
    recentChapterContents: [big("正", 30_000)],
    recentSummaries: [big("摘", 20_000)],
    previousChapterEnding: big("尾", 10_000),
    characterStates: big("人", 10_000),
    soulDoc: big("魂", 10_000),
    characterAuras: big("气", 10_000),
    cognitionStates: big("知", 10_000),
    foreshadowingStates: big("伏", 10_000),
    timeline: big("线", 10_000),
    relatedSettings: big("设", 5_000),
    canonRules: big("史", 8_000),
    writingStyle: big("风", 5_000),
    searchResults: big("索", 30_000),
    graphSearchResults: big("图", 30_000),
    mustDo: "必须做",
    mustAvoid: "必须避免",
    nextChapterAdvice: big("议", 5_000),
    revisionDirectives: big("修", 5_000),
    communitySummaries: big("社", 10_000),
    relatedChapters: big("联", 10_000),
    references: big("引", 10_000),
    referenceBindings: big("绑", 10_000),
    techniqueBlocks: big("技", 10_000),
  } as unknown as ContextPack
}

// §GAP-89-02 dropOrder 有序丢弃回归：超预算时低优先级检索/引用段先被裁，
// 高优先级（任务/大纲/canon/禁区）保留；guides 与 context-compact.ts
// CONTEXT_DROP_ORDER 同源顺序。
describe("trimContextPack — dropOrder 有序丢弃（§GAP-89-02）", () => {
  it("检索段（graphSearchResults/searchResults）先于人物状态被裁", () => {
    const out = trimContextPack(packWithDropOrderTargets(), 40_000)
    expect(out.removed.length).toBeGreaterThan(0)
    const labels = out.trimmedFields ?? []
    // 最先丢弃的必须是检索/引用类低优先级段
    expect(labels.length).toBeGreaterThan(0)
    expect(["图谱检索", "检索结果", "引用检索", "素材引用绑定", "关联章节", "社区摘要", "知识库引用", "技法块"]).toContain(labels[0]!)
    // 高优先级保护：任务/大纲/canon/禁区不得出现在 removed
    expect(labels).not.toContain("任务")
    const pack = out.pack as unknown as Record<string, unknown>
    expect(pack["task"]).toBe("写第5章")
    expect(pack["mustAvoid"]).toBe("必须避免")
  })

  it("记账 trimmedChars 与实际一致（R4 不变量在扩展表下保持）", () => {
    const pack = packWithDropOrderTargets()
    const before = JSON.stringify(pack).length
    const out = trimContextPack(pack, 40_000)
    expect(out.originalChars).toBe(before)
    expect(out.finalChars ?? -1).toBe(JSON.stringify(out.pack).length)
    expect(out.trimmedChars).toBe(before - (out.finalChars ?? 0))
  })

  it("保护段永不丢失：canonRules/outline/task 在深度超预算下仍存在", () => {
    const out = trimContextPack(packWithDropOrderTargets(), 20_000)
    const pack = out.pack as unknown as Record<string, unknown>
    expect(pack["task"]).toBe("写第5章")
    expect(pack["outline"]).toBe("大纲")
    expect(pack["canonRules"]).toBeDefined()
  })
})
