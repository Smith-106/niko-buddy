// canon-revision-diff.spec.ts —— 跨 revision 边集 diff 纯函数单测（P2）。
//
// 覆盖：新增 / 取代配对 / 无后继封顶（invalidated 空）/ 基线 / 旧数据 null 戳 /
// 多后继贪心 / 空集 / removed 防御恒空 / supersedeKey 键决策 /
// distinctRecordedRevisions / 零 LLM·invoke 机械断言。

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { CanonFact } from "./canon-graph-client"
import {
  asOfSnapshot,
  diffCanonRevisions,
  distinctRecordedRevisions,
  supersedeKey,
} from "./canon-revision-diff"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

function makeFact(overrides: Partial<CanonFact> = {}): CanonFact {
  return {
    id: "f1",
    sourceId: "ent:alice",
    targetId: "ent:bob",
    predicate: "KNOWS",
    edgeKind: "world_fact",
    validAt: 1,
    invalidAt: null,
    archived: false,
    recordedRevision: 1,
    ...overrides,
  }
}

describe("canon-revision-diff — 零 LLM / 零 invoke 机械断言", () => {
  it("纯函数：无 llm-client / invoke import，无 await invoke", () => {
    const src = readSource("canon-revision-diff.ts")
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/llm-client/)
    expect(src).not.toMatch(/from\s+["']@tauri-apps\/api/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })
})

describe("supersedeKey (内容键)", () => {
  it("包含 sourceId/targetId/predicate/edgeKind/validAt", () => {
    const key = supersedeKey(
      makeFact({
        sourceId: "ent:a",
        targetId: "ent:b",
        predicate: "P",
        edgeKind: "arc",
        validAt: 3,
      }),
    )
    expect(key).toContain("ent:a")
    expect(key).toContain("ent:b")
    expect(key).toContain("P")
    expect(key).toContain("arc")
    expect(key).toContain("3")
  })

  it("排除 invalidAt 与 recordedRevision（封顶戳/写入戳不参与配对）", () => {
    const a = makeFact({ id: "old", invalidAt: 5, recordedRevision: 1 })
    const b = makeFact({ id: "new", invalidAt: null, recordedRevision: 9 })
    expect(supersedeKey(a)).toBe(supersedeKey(b))
  })

  it("排除 id（同内容不同 id 视为同一事实本体）", () => {
    expect(supersedeKey(makeFact({ id: "x" }))).toBe(supersedeKey(makeFact({ id: "y" })))
  })

  it("validAt null 归一（undefined 与 null 等价）", () => {
    const a = makeFact({ validAt: null })
    const b = makeFact({ validAt: undefined })
    expect(supersedeKey(a)).toBe(supersedeKey(b))
  })
})

describe("asOfSnapshot (as-of 视角)", () => {
  it("rev=null → 空基线", () => {
    expect(asOfSnapshot([makeFact({ recordedRevision: 1 })], null)).toEqual([])
  })

  it("只保留 recordedRevision <= rev 的边", () => {
    const facts = [
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "b", recordedRevision: 3 }),
    ]
    expect(asOfSnapshot(facts, 2).map((f) => f.id)).toEqual(["a"])
  })

  it("旧数据无戳（null）始终保留", () => {
    const facts = [
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "legacy", recordedRevision: null }),
    ]
    expect(asOfSnapshot(facts, 1).map((f) => f.id).sort()).toEqual(["a", "legacy"])
  })
})

describe("distinctRecordedRevisions", () => {
  it("去重升序，排除 null", () => {
    const revs = distinctRecordedRevisions([
      makeFact({ id: "a", recordedRevision: 3 }),
      makeFact({ id: "b", recordedRevision: 1 }),
      makeFact({ id: "c", recordedRevision: 3 }),
      makeFact({ id: "d", recordedRevision: null }),
    ])
    expect(revs).toEqual([1, 3])
  })

  it("空集 → 空数组", () => {
    expect(distinctRecordedRevisions([])).toEqual([])
  })
})

describe("diffCanonRevisions — 新增 (added)", () => {
  it("基线→revB 全部归入 added", () => {
    const after = [
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "b", recordedRevision: 2 }),
    ]
    const res = diffCanonRevisions([], after, null, 2)
    expect(res.added.map((f) => f.id).sort()).toEqual(["a", "b"])
    expect(res.superseded).toHaveLength(0)
    expect(res.total).toBe(2)
  })

  it("窗口戳 revA < recordedRevision <= revB 的边才 added", () => {
    const before = [makeFact({ id: "old", recordedRevision: 1 })]
    const after = [
      makeFact({ id: "old", recordedRevision: 1 }),
      makeFact({ id: "new", recordedRevision: 3 }),
    ]
    const res = diffCanonRevisions(before, after, 1, 3)
    expect(res.added.map((f) => f.id)).toEqual(["new"])
    expect(res.total).toBe(1)
  })
})

describe("diffCanonRevisions — 取代配对 (superseded)", () => {
  it("封顶旧边 + 同内容键后继 → 配对，不落入 added", () => {
    const before = [
      makeFact({ id: "old", invalidAt: 5, recordedRevision: 1, predicate: "KNOWS" }),
    ]
    const after = [
      makeFact({ id: "old", invalidAt: 5, recordedRevision: 1, predicate: "KNOWS" }),
      makeFact({ id: "new", invalidAt: null, recordedRevision: 2, predicate: "KNOWS" }),
    ]
    const res = diffCanonRevisions(before, after, 1, 2)
    expect(res.superseded).toHaveLength(1)
    expect(res.superseded[0]!.before.id).toBe("old")
    expect(res.superseded[0]!.after.id).toBe("new")
    expect(res.added).toHaveLength(0)
    expect(res.total).toBe(1)
  })

  it("多跳 supersede 贪心匹配最近前任（recordedRevision 降序）", () => {
    // 同一内容键在 before 有三个封顶前任：rev1、rev2、rev3；after 有一个后继。
    const before = [
      makeFact({ id: "old1", invalidAt: 5, recordedRevision: 1 }),
      makeFact({ id: "old2", invalidAt: 5, recordedRevision: 2 }),
      makeFact({ id: "old3", invalidAt: 5, recordedRevision: 3 }),
    ]
    const after = [
      ...before,
      makeFact({ id: "new", invalidAt: null, recordedRevision: 4 }),
    ]
    const res = diffCanonRevisions(before, after, 3, 4)
    expect(res.superseded).toHaveLength(1)
    expect(res.superseded[0]!.before.id).toBe("old3") // 最近前任
    expect(res.superseded[0]!.after.id).toBe("new")
  })

  it("未封顶的同内容键边不参与配对（保持 added）", () => {
    const before = [makeFact({ id: "old", invalidAt: null, recordedRevision: 1 })]
    const after = [
      makeFact({ id: "old", invalidAt: null, recordedRevision: 1 }),
      makeFact({ id: "new", invalidAt: null, recordedRevision: 2 }),
    ]
    const res = diffCanonRevisions(before, after, 1, 2)
    expect(res.superseded).toHaveLength(0)
    expect(res.added.map((f) => f.id)).toEqual(["new"])
  })
})

describe("diffCanonRevisions — 失效 / 移除 (预留)", () => {
  it("无后继封顶 → invalidated 恒空（本波 limitation）", () => {
    const before = [makeFact({ id: "capped", invalidAt: 5, recordedRevision: 1 })]
    const after = [makeFact({ id: "capped", invalidAt: 5, recordedRevision: 1 })]
    const res = diffCanonRevisions(before, after, 1, 1)
    expect(res.invalidated).toHaveLength(0)
  })

  it("removed 防御：append-only 快照恒空", () => {
    const before = [makeFact({ id: "a", recordedRevision: 1 })]
    const after = [
      makeFact({ id: "a", recordedRevision: 1 }),
      makeFact({ id: "b", recordedRevision: 2 }),
    ]
    const res = diffCanonRevisions(before, after, 1, 2)
    expect(res.removed).toHaveLength(0)
  })

  it("removed 防御：before ∖ after 按 id（直接入参时输出）", () => {
    const res = diffCanonRevisions(
      [makeFact({ id: "gone" })],
      [],
      1,
      2,
    )
    expect(res.removed.map((f) => f.id)).toEqual(["gone"])
  })
})

describe("diffCanonRevisions — 空集 / 组合 / changes 顺序", () => {
  it("双空 → 全空，total 0", () => {
    const res = diffCanonRevisions([], [], null, null)
    expect(res.added).toHaveLength(0)
    expect(res.superseded).toHaveLength(0)
    expect(res.changes).toHaveLength(0)
    expect(res.total).toBe(0)
  })

  it("changes 顺序：superseded → invalidated → removed → added", () => {
    const before = [
      makeFact({ id: "old", invalidAt: 5, recordedRevision: 1 }),
      makeFact({ id: "gone", recordedRevision: 1 }),
    ]
    const after = [
      makeFact({ id: "old", invalidAt: 5, recordedRevision: 1 }),
      makeFact({ id: "new", invalidAt: null, recordedRevision: 2 }),
      makeFact({ id: "pure", invalidAt: null, recordedRevision: 2, predicate: "OTHER" }),
    ]
    const res = diffCanonRevisions(before, after, 1, 2)
    expect(res.changes.map((c) => c.kind)).toEqual(["superseded", "removed", "added"])
    expect(res.added.map((f) => f.id)).toEqual(["pure"])
    expect(res.removed.map((f) => f.id)).toEqual(["gone"])
  })

  it("回填元数据 revA/revB 透传", () => {
    const res = diffCanonRevisions([], [makeFact({ recordedRevision: 2 })], 1, 2)
    expect(res.revA).toBe(1)
    expect(res.revB).toBe(2)
  })
})
