/** digest-aggregator 分支覆盖补齐：空壳重写为真实行为测试，每条断言都可失败。 */
import { describe, expect, it } from "vitest"

import {
  assertSourced,
  buildBriefingDigest,
  currentChapterOf,
  formatEmotionEntry,
  openDebtsOf,
  type BriefingSourceBundle,
} from "./digest-aggregator"

function bundle(overrides: Partial<BriefingSourceBundle> = {}): BriefingSourceBundle {
  return {
    status: { currentChapter: 12 },
    emotionLedger: {
      entries: [
        { chapter: 10, emotion: "焦虑", intensity: 0.6 },
        { chapter: 11, emotion: "平静", intensity: 0.2 },
      ],
    },
    foreshadowing: {
      items: [
        { id: "f-2", name: "断剑", status: "planted", plantedChapter: 4 },
        { id: "f-1", name: "旧信", status: "planted", plantedChapter: 2 },
      ],
    },
    factsRaw: null,
    behavior: {
      anomalies: [
        { character: "甲", severity: "warning", type: "overuse", message: "拔剑动作重复" },
      ],
      consistencyScores: { 甲: 0.8 },
    },
    behaviorSourcePath: "chapters/ch-0012.md",
    ...overrides,
  }
}

describe("digest-aggregator / 缺源与字段回退（分支覆盖）", () => {
  it("emotionLedger 是记录但 entries 非数组 → 无情绪断言（不臆造）", () => {
    const digest = buildBriefingDigest(bundle({ emotionLedger: {} }))
    expect(digest.assertions.some((a) => a.block === "emotion")).toBe(false)
    expect(digest.blocks).not.toContain("emotion")
    // 其它块不受影响
    expect(digest.blocks).toContain("debts")
  })

  it("情绪 entries 含非记录条目 → 该条标 UNMAPPED，不拖垮整块", () => {
    const digest = buildBriefingDigest(
      bundle({ emotionLedger: { entries: [{ chapter: 1, emotion: "喜", intensity: 0.1 }, "断章"] } }),
    )
    const second = digest.assertions.find((a) => a.id === "emotion:1")
    expect(second?.text).toContain("UNMAPPED")
    expect(second?.source.jsonPointer).toBe("/entries/1")
    expect(digest.assertions.find((a) => a.id === "emotion:0")?.text).toBe(
      "情绪曲线 第1章 情绪=喜 强度=0.1",
    )
  })

  it("情绪条目缺 emotion 字段 → 只拼现有字段（不拼 情绪=null）", () => {
    expect(formatEmotionEntry({ chapter: 3, intensity: 0.5 })).toBe("第3章 强度=0.5")
    const digest = buildBriefingDigest(bundle({ emotionLedger: { entries: [{ chapter: 3, intensity: 0.5 }] } }))
    expect(digest.assertions.find((a) => a.id === "emotion:0")?.text).toBe(
      "情绪曲线 第3章 强度=0.5",
    )
  })

  it("foreshadowing items 含非记录条目 → 跳过该条，其它债务指针保持原下标", () => {
    const debts = openDebtsOf(
      bundle({ foreshadowing: { items: ["oops", { id: "f-1", name: "旧信", status: "planted", plantedChapter: 2 }] } }),
    )
    expect(debts.map((d) => d.id)).toEqual(["f-1"])
    expect(debts[0].source.jsonPointer).toBe("/items/1")
  })

  it("伏笔缺 plantedChapter → 该条不计入债务（不猜播种章）", () => {
    const debts = openDebtsOf(
      bundle({ foreshadowing: { items: [{ id: "x", name: "无章", status: "planted" }] } }),
    )
    expect(debts).toEqual([])
  })

  it("伏笔缺 id → 回退为 item-<下标>", () => {
    const debts = openDebtsOf(
      bundle({ foreshadowing: { items: [{ name: "无名", status: "planted", plantedChapter: 3 }] } }),
    )
    expect(debts.map((d) => d.id)).toEqual(["item-0"])
    expect(debts[0].name).toBe("无名")
  })

  it("伏笔缺 name → 用 description；两者都缺 → 回退为 item-<下标>", () => {
    const debts = openDebtsOf(
      bundle({
        foreshadowing: {
          items: [
            { id: "a", description: "断剑来历", status: "planted", plantedChapter: 4 },
            { id: "b", status: "planted", plantedChapter: 5 },
          ],
        },
      }),
    )
    expect(debts.map((d) => [d.id, d.name])).toEqual([
      ["a", "断剑来历"],
      ["b", "item-1"],
    ])
  })

  it("status 缺失 → chaptersSincePlanted 为 0 且债务文本无「已过」后缀；progress 块缺席", () => {
    const digest = buildBriefingDigest(bundle({ status: null }))
    expect(digest.openDebts.map((d) => d.chaptersSincePlanted)).toEqual([0, 0])
    const debt = digest.assertions.find((a) => a.id === "debt:f-1")
    expect(debt?.text).toBe("未回收伏笔「旧信」播种于第2章")
    expect(debt?.text).not.toContain("已过")
    expect(digest.assertions.some((a) => a.id === "progress:current-chapter")).toBe(false)
    expect(digest.blocks).not.toContain("progress")
  })

  it("同播种章债务 → 按 id 码点 tiebreak", () => {
    const debts = openDebtsOf(
      bundle({
        foreshadowing: {
          items: [
            { id: "b", name: "b", status: "planted", plantedChapter: 5 },
            { id: "a", name: "a", status: "planted", plantedChapter: 5 },
          ],
        },
      }),
    )
    expect(debts.map((d) => d.id)).toEqual(["a", "b"])
  })

  it("behavior anomalies 含非记录条目 → 跳过；空记录异常走全部字段回退", () => {
    const digest = buildBriefingDigest(bundle({ behavior: { anomalies: ["oops", {}] } }))
    const behavior = digest.assertions.filter((a) => a.block === "behavior")
    expect(behavior.map((a) => a.id)).toEqual(["behavior:1"])
    // character→"?" severity→"info" kind→"unknown" message→""
    expect(behavior[0].text).toBe("行为异常 [info/unknown] ?: ")
    expect(behavior[0].claimKey).toBe("behavior/?")
  })

  it("behavior 缺 consistencyScores → 无一致性断言（不崩）", () => {
    const digest = buildBriefingDigest(bundle({ behavior: { anomalies: [] } }))
    expect(digest.assertions.filter((a) => a.block === "behavior")).toEqual([])
    expect(digest.blocks).not.toContain("behavior")
  })

  it("currentChapterOf 非记录输入直接返回 null", () => {
    expect(currentChapterOf(null)).toBeNull()
    expect(currentChapterOf(7)).toBeNull()
    expect(currentChapterOf("12")).toBeNull()
  })

  it("assertSourced 过滤无 source/空 path/空指针的断言", () => {
    const good = { kind: "fact-store" as const, path: ".novel/facts.json", jsonPointer: "/facts/0" }
    const kept = assertSourced([
      { id: "a", block: "facts", text: "t", source: good, claimKey: null },
      { id: "b", block: "facts", text: "t", source: { ...good, jsonPointer: "" }, claimKey: null },
      { id: "c", block: "facts", text: "t", source: { ...good, path: "" }, claimKey: null },
    ])
    expect(kept.map((k) => k.id)).toEqual(["a"])
  })
})
