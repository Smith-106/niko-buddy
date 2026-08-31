import { describe, expect, it } from "vitest"
import { createBookSnapshot, preRestoreCheck, restoreImpactReport, type BookSnapshot } from "./book-backup"

function snapshot(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    snapshotId: "snap-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    statusVersion: "v7",
    chapters: [
      { chapter: 1, contentHash: "h1", wordCount: 3000 },
      { chapter: 2, contentHash: "h2", wordCount: 3200 },
    ],
    ...overrides,
  }
}

describe("book-backup（吸收 inkos book-backup：全书快照+pre-restore 门禁）", () => {
  it("createBookSnapshot：章节按号排序", () => {
    const snap = createBookSnapshot({
      snapshotId: "s",
      statusVersion: "v7",
      chapters: [
        { chapter: 2, contentHash: "h2", wordCount: 1 },
        { chapter: 1, contentHash: "h1", wordCount: 1 },
      ],
    })
    expect(snap.chapters.map((c) => c.chapter)).toEqual([1, 2])
  })

  it("合法快照+匹配版本 → allowed 无 error", () => {
    const check = preRestoreCheck(snapshot(), {
      statusVersion: "v7",
      chapters: [
        { chapter: 1, contentHash: "changed" },
        { chapter: 2, contentHash: "changed" },
      ],
    })
    expect(check.allowed).toBe(true)
    expect(check.errors).toEqual([])
  })

  it("空快照/重复章节/空哈希 → error 拒绝", () => {
    expect(preRestoreCheck(snapshot({ chapters: [] }), { statusVersion: "v7", chapters: [] }).allowed).toBe(false)
    const dup = preRestoreCheck(
      snapshot({ chapters: [{ chapter: 1, contentHash: "h", wordCount: 1 }, { chapter: 1, contentHash: "h", wordCount: 1 }] }),
      { statusVersion: "v7", chapters: [] },
    )
    expect(dup.errors.some((e) => e.includes("重复"))).toBe(true)
    const noHash = preRestoreCheck(
      snapshot({ chapters: [{ chapter: 1, contentHash: " ", wordCount: 1 }] }),
      { statusVersion: "v7", chapters: [] },
    )
    expect(noHash.errors.some((e) => e.includes("哈希为空"))).toBe(true)
  })

  it("版本不匹配 → warning 可覆盖", () => {
    const mismatch = preRestoreCheck(snapshot(), {
      statusVersion: "v9",
      chapters: [{ chapter: 1, contentHash: "x" }, { chapter: 2, contentHash: "y" }],
    })
    expect(mismatch.warnings.some((w) => w.includes("版本不匹配"))).toBe(true)
    expect(mismatch.allowed).toBe(true)
  })

  it("内容完全一致 → warning 无需还原", () => {
    const identical = preRestoreCheck(snapshot(), {
      statusVersion: "v7",
      chapters: [{ chapter: 1, contentHash: "h1" }, { chapter: 2, contentHash: "h2" }],
    })
    expect(identical.warnings.some((w) => w.includes("还原无效果"))).toBe(true)
  })

  it("restoreImpactReport：差异章恢复、当前独有章不受影响", () => {
    const impact = restoreImpactReport(snapshot(), {
      chapters: [{ chapter: 1, contentHash: "h1" }, { chapter: 9, contentHash: "x" }],
    })
    expect(impact.willRestore).toEqual([2])
    expect(impact.untouched).toEqual([9])
  })

  it("确定性：同输入双跑全等", () => {
    const cur = { statusVersion: "v7", chapters: [{ chapter: 1, contentHash: "a" }] }
    expect(JSON.stringify(preRestoreCheck(snapshot(), cur))).toBe(JSON.stringify(preRestoreCheck(snapshot(), cur)))
  })
})
