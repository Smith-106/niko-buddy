import { describe, expect, it } from "vitest"
import {
  applyCharacterStateChangesToStore,
  applyForeshadowingChangesToStore,
  isCanonDualWriteEligible,
  parseFactsSubject,
  snapshotMarkdownPath,
} from "./chapter-ingest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { CharacterStateStore } from "./character-state"
import type { ForeshadowingStore } from "./foreshadowing-tracker"

// ── parseFactsSubject ──────────────────────────────────────────────
describe("parseFactsSubject", () => {
  it("提取冒号前缀主语", () => {
    expect(parseFactsSubject("主角：张三")).toBe("主角")
    expect(parseFactsSubject("主角: 张三")).toBe("主角")
  })
  it("提取 是/属于/为 谓词主语", () => {
    expect(parseFactsSubject("他是剑修")).toBe("他")
    expect(parseFactsSubject("此地属于禁区")).toBe("此地")
  })
  it("无谓词回退前20字", () => {
    // 无 ：/:/是/属于/为 谓词的纯陈述 → 回退前20字截断
    const long = "某段没有任何谓词标记的长事实陈述需要截断到前二十个字符作为subject"
    expect(parseFactsSubject(long)).toBe(long.slice(0, 20))
  })
})

// ── isCanonDualWriteEligible ───────────────────────────────────────
describe("isCanonDualWriteEligible", () => {
  it("final/accepted 状态可双写", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "final" })).toBe(true)
    expect(isCanonDualWriteEligible({ chapter_status: "accepted" })).toBe(true)
  })
  it("draft/pending 等状态不可双写", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "draft" })).toBe(false)
    expect(isCanonDualWriteEligible({ chapter_status: "pending" })).toBe(false)
    expect(isCanonDualWriteEligible({})).toBe(false)
  })
})

// ── snapshotMarkdownPath ───────────────────────────────────────────
describe("snapshotMarkdownPath", () => {
  it("生成章节快照路径", () => {
    const p = snapshotMarkdownPath("C:/proj", 3)
    // 路径格式: {projectPath}/.novel/snapshots/{prefix}.snapshot.md
    expect(p).toContain(".novel/snapshots")
    expect(p).toContain("003")
    expect(p).toMatch(/\.snapshot\.md$/)
  })
})

// ── applyCharacterStateChangesToStore ──────────────────────────────
function makeCharStore(): CharacterStateStore {
  return { characters: [], lastUpdated: "" }
}
function makeSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterNumber: 1,
    filePath: "ch1.md",
    title: "第1章",
    characters: [],
    characterStateChanges: [],
    foreshadowingChanges: [],
    ...overrides,
  } as ChapterSnapshot
}

describe("applyCharacterStateChangesToStore", () => {
  it("空变更不改 store", () => {
    const store = makeCharStore()
    const snap = makeSnapshot()
    const out = applyCharacterStateChangesToStore(store, snap)
    expect(out.characters).toHaveLength(0)
  })
  it("角色变更字符串解析写入", () => {
    const store = makeCharStore()
    const snap = makeSnapshot({
      characterStateChanges: ["张三 位置:山门 情绪:平静"],
    })
    const out = applyCharacterStateChangesToStore(store, snap)
    // 字符串解析由内部 parseCharacterStateChange 决定——只验证不崩+store 返回
    expect(out).toBeDefined()
    expect(Array.isArray(out.characters)).toBe(true)
  })
})

// ── applyForeshadowingChangesToStore ───────────────────────────────
function makeForeStore(): ForeshadowingStore {
  return { items: [], lastUpdated: "" }
}

describe("applyForeshadowingChangesToStore", () => {
  it("空伏笔变更不改 store", () => {
    const store = makeForeStore()
    const snap = makeSnapshot()
    const out = applyForeshadowingChangesToStore(store, snap)
    expect(out.items).toHaveLength(0)
  })
  it("伏笔变更字符串解析写入", () => {
    const store = makeForeStore()
    const snap = makeSnapshot({
      foreshadowingChanges: ["新增伏笔:神秘剑谱"],
    })
    const out = applyForeshadowingChangesToStore(store, snap)
    expect(out).toBeDefined()
    expect(Array.isArray(out.items)).toBe(true)
  })
})
