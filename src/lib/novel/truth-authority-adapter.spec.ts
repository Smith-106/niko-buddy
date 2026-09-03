/**
 * truth-authority-adapter.spec.ts — 48/49 号 §六-① truth-authority 生产接线 spec 锁定.
 *
 * 50 号报告 S0 行动项: 49 号 6 项补齐 spec 补测（C 视角 3/3 全票 claimed-only 修正）。
 * 覆盖: deriveTruthEntries 分级映射 / entryId 对齐 / runTruthAuthorityCheck 冲突→warning / 空事实→[]。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  deriveTruthEntries,
  runTruthAuthorityCheck,
} from "./truth-authority-adapter"
import type { ChapterSnapshot } from "./chapter-ingest"

function snapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch3",
    chapterNumber: 3,
    summary: "测试章",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  }
}

describe("deriveTruthEntries（48/49 号 §六-① 接线）", () => {
  it("newCanonFacts → established，entryId 对齐 ch{N}-fact{i}", () => {
    const s = snapshot({ newCanonFacts: ["林澈是青霜剑主", "旧屋主人是沈伯"] })
    const entries = deriveTruthEntries(s)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      entryId: "ch3-fact0",
      level: "established",
      revision: 0,
    })
    expect(entries[1].entryId).toBe("ch3-fact1")
    // entryId 与 buildCanonDualWriteOps 的 episode id 对齐（审计链一致性）
    expect(entries[0].statement).toBe("林澈是青霜剑主")
  })

  it("beliefFacts → hypothesis，entryId 含 modality 前缀", () => {
    const s = snapshot({
      beliefFacts: [{ subject: "小晴", predicate: "认为", object: "旧屋主人是沈伯" }],
    })
    const entries = deriveTruthEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe("hypothesis")
    expect(entries[0].entryId).toContain("ch3-belief-小晴")
    expect(entries[0].statement).toBe("小晴认为旧屋主人是沈伯")
  })

  it("hypothesisFacts → hypothesis，与 belief 键空间分离", () => {
    const s = snapshot({
      hypothesisFacts: [{ subject: "主角", predicate: "推测", object: "屋内有人跟踪" }],
    })
    const entries = deriveTruthEntries(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe("hypothesis")
    expect(entries[0].entryId).toContain("ch3-hyp-主角")
  })

  it("无任何事实 → 空数组", () => {
    expect(deriveTruthEntries(snapshot())).toHaveLength(0)
  })
})

describe("runTruthAuthorityCheck（接线入口）", () => {
  it("同级最高冲突（双 established 同主题）→ severity error warning", () => {
    const s = snapshot({
      newCanonFacts: ["林澈是青霜剑主", "林澈是赤焰刀主"],
    })
    const warnings = runTruthAuthorityCheck(s)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].type).toBe("truth_authority_conflict")
    expect(warnings[0].message).toContain("同级最高")
    expect(warnings[0].message).toContain("established")
  })

  it("无冲突 → 空数组（不产生噪声 warning）", () => {
    const s = snapshot({
      newCanonFacts: ["林澈是青霜剑主"],
      hypothesisFacts: [{ subject: "小晴", predicate: "认为", object: "旧屋主人是沈伯" }],
    })
    expect(runTruthAuthorityCheck(s)).toHaveLength(0)
  })

  it("无事实 → 空数组", () => {
    expect(runTruthAuthorityCheck(snapshot())).toHaveLength(0)
  })
})
