/**
 * score-migration.spec.ts — v2.6.5 D2 验收
 *
 * 覆盖：旧分保留+legacy 标记（不重算）/ schemaVersion 递增 / 迁移纯函数（幂等）
 */
import { describe, expect, it } from "vitest"
import { SCHEMA_VERSION, migrateScores, scoreWithNewBaseline, type ScoreRecord } from "./score-migration"

const oldRecord: ScoreRecord = {
  chapterId: "ch1",
  overall: 8.2,
  dimensions: { thril: 8.0, pacing: 8.5 },
  baselineVersion: "v2.6.4",
  legacy: false,
}

describe("D2 旧分迁移 — 保留 + legacy 标记（不重算不追溯）", () => {
  it("旧基线记录 → 保留原分 + legacy=true（不重算）", () => {
    const { records, stats } = migrateScores([oldRecord], "v2.6.4")
    expect(records[0].overall).toBe(8.2) // 原分保留
    expect(records[0].legacy).toBe(true)
    expect(stats.legacyMarked).toBe(1)
    expect(stats.unchanged).toBe(0)
  })

  it("schemaVersion 递增到 score-schema-v2", () => {
    const { schemaVersion } = migrateScores([oldRecord], "v2.6.4")
    expect(schemaVersion).toBe(SCHEMA_VERSION)
    expect(schemaVersion).toBe("score-schema-v2")
  })

  it("迁移幂等：已 legacy 记录再迁移不变", () => {
    const once = migrateScores([oldRecord], "v2.6.4")
    const twice = migrateScores(once.records, "v2.6.4")
    expect(twice.records[0].legacy).toBe(true)
    expect(twice.records[0].overall).toBe(8.2)
    expect(twice.stats.legacyMarked).toBe(1)
  })

  it("新基线记录原样保留（不标记）", () => {
    const newRecord = scoreWithNewBaseline({ chapterId: "ch2", overall: 9.1, dimensions: {}, baselineVersion: "v2.6.5" })
    const { records } = migrateScores([newRecord], "v2.6.4")
    expect(records[0].legacy).toBe(false)
    expect(records[0].overall).toBe(9.1)
  })

  it("迁移纯函数：同入同出（确定性）", () => {
    const a = migrateScores([oldRecord], "v2.6.4")
    const b = migrateScores([oldRecord], "v2.6.4")
    expect(a.records).toEqual(b.records)
    expect(a.stats).toEqual(b.stats)
  })
})
