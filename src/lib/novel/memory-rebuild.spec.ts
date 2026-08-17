import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  buildStructuredMemoryDocuments,
  isValidMemorySnapshot,
  looksLikeStableNovelEntityLabel,
} from "./memory-rebuild"

function snapshot(overrides: Partial<ChapterSnapshot> & { chapterNumber: number }): ChapterSnapshot {
  return {
    chapterId: `ch-${overrides.chapterNumber}`,
    chapterTitle: `第${overrides.chapterNumber}章`,
    summary: "",
    endingHook: "",
    characterStateChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    timelineEvents: [],
    newCanonFacts: [],
    conflicts: [],
    memorySyncedAt: undefined,
    characters: [],
    ...overrides,
  } as ChapterSnapshot
}

describe("isValidMemorySnapshot", () => {
  it("rejects null / non-finite / non-positive chapter numbers", () => {
    expect(isValidMemorySnapshot(null, [])).toBe(false)
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: Number.NaN }), [])).toBe(false)
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: 0 }), [])).toBe(false)
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: -1 }), [])).toBe(false)
  })

  it("accepts any snapshot when actual chapter list is empty", () => {
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: 99 }), [])).toBe(true)
  })

  it("bounds chapter number to maxActual + 5", () => {
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: 6 }), [1, 2, 3])).toBe(true)
    expect(isValidMemorySnapshot(snapshot({ chapterNumber: 9 }), [1, 2, 3])).toBe(false)
  })
})

describe("looksLikeStableNovelEntityLabel", () => {
  it("rejects empty / punctuation / over-long labels", () => {
    expect(looksLikeStableNovelEntityLabel("character", "")).toBe(false)
    expect(looksLikeStableNovelEntityLabel("character", "  ")).toBe(false)
    expect(looksLikeStableNovelEntityLabel("character", "林，晚")).toBe(false)
    expect(looksLikeStableNovelEntityLabel("location", "x".repeat(33))).toBe(false)
  })

  it("rejects long event labels and event-verb phrasing", () => {
    expect(looksLikeStableNovelEntityLabel("event", "x".repeat(19))).toBe(false)
    expect(looksLikeStableNovelEntityLabel("event", "发现真相")).toBe(false)
  })

  it("accepts normal entity labels", () => {
    expect(looksLikeStableNovelEntityLabel("character", "林晚")).toBe(true)
    expect(looksLikeStableNovelEntityLabel("location", "旧城区")).toBe(true)
    expect(looksLikeStableNovelEntityLabel("event", "雨夜旧屋")).toBe(true)
  })
})

describe("buildStructuredMemoryDocuments", () => {
  it("builds all seven documents with empty snapshot list", () => {
    const docs = buildStructuredMemoryDocuments([])
    expect(Object.keys(docs)).toEqual([
      "chapter-snapshots.md",
      "character-cognition.md",
      "character-states.md",
      "foreshadowing-tracker.md",
      "timeline.md",
      "canon-facts.md",
      "conflicts.md",
    ])
    expect(docs["chapter-snapshots.md"]).toContain("章节快照记忆")
    expect(docs["character-cognition.md"]).toContain("暂无正式认知记录。")
    expect(docs["character-states.md"]).toContain("暂无正式状态记录。")
    expect(docs["foreshadowing-tracker.md"]).toContain("暂无进行中的正式伏笔。")
    expect(docs["foreshadowing-tracker.md"]).toContain("暂无已完成伏笔。")
    expect(docs["timeline.md"]).toContain("暂无正式记录。")
    expect(docs["canon-facts.md"]).toContain("暂无正式记录。")
    expect(docs["conflicts.md"]).toContain("暂无正式记录。")
  })

  it("renders chapter snapshots with all sections and fallbacks", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 2,
        summary: "雨夜抵达旧屋",
        endingHook: "门外响起脚步声。",
        characterStateChanges: ["林晚：冷静"],
        knowledgeChanges: ["林晚得知屋主失踪"],
        foreshadowingChanges: ["推进伏笔：锈钥匙"],
        timelineEvents: ["深夜十点抵达旧屋"],
      }),
      snapshot({
        chapterNumber: 1,
        summary: "",
        endingHook: "",
        characterStateChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        timelineEvents: [],
      }),
    ])
    const snapDoc = docs["chapter-snapshots.md"]
    // sorted by chapter number (1 before 2)
    expect(snapDoc.indexOf("## 第1章")).toBeLessThan(snapDoc.indexOf("## 第2章"))
    expect(snapDoc).toContain("### 摘要\n无")
    expect(snapDoc).toContain("- 无")
    expect(snapDoc).toContain("门外响起脚步声。")
  })

  it("routes uncertain knowledge into candidate section", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 3,
        knowledgeChanges: ["林晚似乎知道屋主身份"],
        characterStateChanges: [],
        foreshadowingChanges: [],
        timelineEvents: [],
        newCanonFacts: [],
        conflicts: [],
      }),
    ])
    expect(docs["character-cognition.md"]).toContain("候选区")
    expect(docs["character-cognition.md"]).toContain("第3章：林晚似乎知道屋主身份")
    expect(docs["character-cognition.md"]).not.toContain("已知：")
  })

  it("records knows/unknowns per subject with chapter sources", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 4,
        knowledgeChanges: ["林晚知道屋主是旧识", "林晚不知道锈钥匙的用途"],
      }),
      snapshot({
        chapterNumber: 5,
        knowledgeChanges: ["林晚知道屋主是旧识"],
      }),
    ])
    const doc = docs["character-cognition.md"]
    expect(doc).toContain("### 林晚")
    expect(doc).toContain("已知：屋主是旧识（来源：第4章、第5章）")
    expect(doc).toContain("未知：锈钥匙的用途（来源：第4章）")
  })

  it("records latest character states with explicit subject via colon", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 6,
        characterStateChanges: ["林晚：重伤昏迷"],
      }),
      snapshot({
        chapterNumber: 7,
        characterStateChanges: ["林晚：苏醒"],
      }),
    ])
    const doc = docs["character-states.md"]
    expect(doc).toContain("### 林晚")
    expect(doc).toContain("- 当前状态：苏醒")
    expect(doc).toContain("- 最近更新：第7章")
  })

  it("drops unimportant subjects but keeps character-matched states", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 8,
        chapterTitle: "第8章",
        characterStateChanges: [
          "守卫：警戒",
          "灰白制服人员：搜查",
        ],
      }),
    ])
    const doc = docs["character-states.md"]
    expect(doc).not.toContain("### 守卫")
    expect(doc).not.toContain("### 灰白制服人员")
  })

  it("character-state fallback picks snapshot character match", () => {
    const s = snapshot({
      chapterNumber: 9,
      chapterTitle: "第9章",
      characterStateChanges: ["林晚已经苏醒"],
      characters: ["林晚", "阿宁"],
    } as unknown as Partial<ChapterSnapshot> & { chapterNumber: number })
    const docs = buildStructuredMemoryDocuments([s])
    expect(docs["character-states.md"]).toContain("### 林晚")
    expect(docs["character-states.md"]).toContain("当前状态：林晚已经苏醒")
  })

  it("tracks foreshadowing lifecycle: planted → advanced → resolved", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增伏笔：\"锈钥匙\" 是重要信物"] }),
      snapshot({ chapterNumber: 3, foreshadowingChanges: ["推进伏笔：\"锈钥匙\" 钥匙在屋主手中"] }),
      snapshot({ chapterNumber: 5, foreshadowingChanges: ["回收伏笔：\"锈钥匙\" 打开密室"] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    const activeSection = doc.slice(doc.indexOf("## 进行中"), doc.indexOf("## 已完成"))
    const resolvedSection = doc.slice(doc.indexOf("## 已完成"))
    expect(activeSection).not.toContain("### 锈钥匙")
    expect(resolvedSection).toContain("### 锈钥匙")
    expect(resolvedSection).toContain("- 状态：已完成")
    expect(resolvedSection).toContain("- 完成章节：第5章")
    expect(resolvedSection).toContain("- 来源回查：第1章、第3章、第5章")
  })

  it("omits the completion-chapter line when the resolving snapshot has chapter 0", () => {
    // buildStructuredMemoryDocuments does not validate chapter numbers, so a
    // chapter-0 snapshot sets `existing.resolved = 0` — falsy → the
    // `if (item.resolved)` completion line is skipped (line 306 false side).
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 0, foreshadowingChanges: ["回收伏笔：\"锈钥匙\" 打开密室"] }),
    ])
    const resolvedSection = docs["foreshadowing-tracker.md"].slice(docs["foreshadowing-tracker.md"].indexOf("## 已完成"))
    expect(resolvedSection).toContain("### 锈钥匙")
    expect(resolvedSection).toContain("- 状态：已完成")
    expect(resolvedSection).not.toContain("- 完成章节：")
  })

  it("keeps advanced items in 进行中 with 推进中 status", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 2, foreshadowingChanges: ["新增伏笔：旧信"] }),
      snapshot({ chapterNumber: 4, foreshadowingChanges: ["推进伏笔：旧信 字迹呼应"] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    expect(doc).toContain("### 旧信")
    expect(doc).toContain("- 状态：推进中")
    expect(doc).not.toContain("- 完成章节：")
  })

  it("normalizes quoted foreshadowing names and routes uncertain to candidates", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 6,
        foreshadowingChanges: ["新增：“银质怀表”会成为关键信物", "推进伏笔 疑似：怀表主人"],
      }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    expect(doc).toContain("### 银质怀表")
    expect(doc).toContain("候选区")
    expect(doc).toContain("第6章：推进伏笔 疑似：怀表主人")
  })

  it("splits foreshadowing names by keywords and punctuation", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增：锈钥匙将成为关键信物"] }),
      snapshot({ chapterNumber: 2, foreshadowingChanges: ["新增：银怀表，另有一封旧信"] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    // keyword split 将 → name = 锈钥匙
    expect(doc).toContain("### 锈钥匙")
    // punctuation split → name = 银怀表
    expect(doc).toContain("### 银怀表")
  })

  it("skips empty foreshadowing lines", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["", "   "] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    expect(doc).toContain("暂无进行中的正式伏笔。")
  })

  it("skips unimportant knowledge subjects and empty text", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        knowledgeChanges: ["", "读者知道屋主身份", "守卫知道屋主身份"],
      }),
    ])
    const doc = docs["character-cognition.md"]
    expect(doc).toContain("暂无正式认知记录。")
    expect(doc).not.toContain("### 守卫")
    expect(doc).not.toContain("### 读者")
  })

  it("treats 通过/借助/编号-style subjects as unimportant", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        knowledgeChanges: ["通过林晚知道屋主身份", "12号守卫知道屋主身份"],
        characterStateChanges: ["通过阿宁得知线索"],
      }),
    ])
    const doc = docs["character-cognition.md"]
    expect(doc).not.toContain("### 通过林晚")
    expect(doc).not.toContain("### 12号守卫")
  })

  it("routes uncertain state changes to candidates and skips empty state text", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        characterStateChanges: ["", "林晚似乎陷入昏迷"],
      }),
    ])
    const doc = docs["character-states.md"]
    expect(doc).toContain("暂无正式状态记录。")
    expect(doc).toContain("候选区")
    expect(doc).toContain("第1章：林晚似乎陷入昏迷")
  })

  it("routes uncertain timeline/canon/conflict items to candidates", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        timelineEvents: ["林晚似乎听到门后动静"],
        newCanonFacts: ["屋主疑似失踪"],
        conflicts: ["两人似乎发生争执"],
      }),
    ])
    expect(docs["timeline.md"]).toContain("候选区")
    expect(docs["timeline.md"]).toContain("第1章：林晚似乎听到门后动静")
    expect(docs["canon-facts.md"]).toContain("候选区")
    expect(docs["conflicts.md"]).toContain("候选区")
  })

  it("honors keep filters on canon facts with mixed lengths", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, newCanonFacts: ["短设定", "长".repeat(120)] }),
    ])
    const doc = docs["canon-facts.md"]
    expect(doc).toContain("- 短设定（来源：第1章）")
    expect(doc).toContain("候选区")
  })

  it("sorts cognition and state entries by subject (zh-CN locale)", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        knowledgeChanges: ["阿宁知道屋主身份", "林晚知道屋主身份"],
        characterStateChanges: ["阿宁：警戒", "林晚：昏迷"],
      }),
    ])
    const cognition = docs["character-cognition.md"]
    expect(cognition.indexOf("### 林晚")).toBeGreaterThan(cognition.indexOf("### 阿宁"))
    const states = docs["character-states.md"]
    expect(states.indexOf("### 林晚")).toBeGreaterThan(states.indexOf("### 阿宁"))
  })

  it("skips unimportant subjects in the unknown branch and registers new unknown subjects", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        knowledgeChanges: ["守卫不知道屋主身份", "阿宁不知道锈钥匙的用途"],
      }),
    ])
    const doc = docs["character-cognition.md"]
    expect(doc).not.toContain("### 守卫")
    expect(doc).toContain("### 阿宁")
    expect(doc).toContain("未知：锈钥匙的用途（来源：第1章）")
  })

  it("rejects punctuation / 编号 / empty subjects in isImportantSubject", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        chapterTitle: "第1章",
        characters: ["", "林，晚", "12号"],
        characterStateChanges: ["林，晚：昏迷", "12号：警戒"],
      }),
    ])
    const doc = docs["character-states.md"]
    expect(doc).toContain("暂无正式状态记录。")
    expect(doc).not.toContain("### 林，晚")
    expect(doc).not.toContain("### 12号")
  })

  it("skips foreshadowing lines whose name normalizes empty", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增："] }),
    ])
    expect(docs["foreshadowing-tracker.md"]).toContain("暂无进行中的正式伏笔。")
  })

  it("falls back to raw text as description when quoted name consumes everything", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增：\"锈钥匙\""] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    expect(doc).toContain("### 锈钥匙")
    expect(doc).toContain("- 说明：新增：\"锈钥匙\"")
  })

  it("treats empty-string character as unimportant subject", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({
        chapterNumber: 1,
        chapterTitle: "第1章",
        characters: [""],
        characterStateChanges: ["空名状态"],
      }),
    ])
    expect(docs["character-states.md"]).toContain("暂无正式状态记录。")
  })

  it("knowledge text matching neither unknown nor know falls through", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, knowledgeChanges: ["林晚发现屋主失踪"] }),
    ])
    expect(docs["character-cognition.md"]).toContain("暂无正式认知记录。")
  })

  it("推进 after 回收 keeps resolved status", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增：\"旧信\""] }),
      snapshot({ chapterNumber: 2, foreshadowingChanges: ["回收伏笔：\"旧信\" 已烧毁"] }),
      snapshot({ chapterNumber: 3, foreshadowingChanges: ["推进伏笔：\"旧信\" 又出现"] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    const resolvedSection = doc.slice(doc.indexOf("## 已完成"))
    expect(resolvedSection).toContain("### 旧信")
    expect(resolvedSection).toContain("状态：已完成")
  })

  it("ties planted chapter ordering by name localeCompare", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, foreshadowingChanges: ["新增：\"阿宁的怀表\"", "新增：\"林晚的钥匙\""] }),
    ])
    const doc = docs["foreshadowing-tracker.md"]
    expect(doc.indexOf("### 阿宁的怀表")).toBeLessThan(doc.indexOf("### 林晚的钥匙"))
  })

  it("timeline keeps only short events, long ones go to candidates", () => {
    const longEvent = "一个".repeat(50) + "超长事件描述"
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, timelineEvents: ["短事件", longEvent] }),
    ])
    const doc = docs["timeline.md"]
    expect(doc).toContain("- 短事件（来源：第1章）")
    expect(doc).toContain("候选区")
  })

  it("canon-facts and conflicts render official entries with sources", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, newCanonFacts: ["时间线规则：白天"], conflicts: ["林晚与阿宁争执"] }),
      snapshot({ chapterNumber: 2, newCanonFacts: ["时间线规则：白天"] }),
    ])
    expect(docs["canon-facts.md"]).toContain("正式事实")
    expect(docs["canon-facts.md"]).toContain("- 时间线规则：白天（来源：第1章、第2章）")
    expect(docs["conflicts.md"]).toContain("- 林晚与阿宁争执（来源：第1章）")
  })

  it("canon-facts keep filter: long canon fact goes to candidates", () => {
    const longFact = "极长设定".repeat(30)
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, newCanonFacts: [longFact] }),
    ])
    const doc = docs["canon-facts.md"]
    expect(doc).not.toContain(`- ${longFact}（`)
    expect(doc).toContain("候选区")
  })

  it("empty raw lines and whitespace-only lines are skipped", () => {
    const docs = buildStructuredMemoryDocuments([
      snapshot({ chapterNumber: 1, timelineEvents: ["", "   ", "有效事件"] }),
    ])
    const doc = docs["timeline.md"]
    expect(doc).toContain("- 有效事件（来源：第1章）")
    expect((doc.match(/- 有效事件/g) ?? []).length).toBe(1)
  })
})
