import { describe, expect, it } from "vitest"
import { assembleProcessView, computeVisibility, type VisibilitySources } from "./process-library"
import type { EncounterMatrixStore } from "./encounter-matrix"
import type { ResourceLedgerStore } from "./resource-ledger"
import type { ParticleLedgerStore } from "./particle-ledger"
import type { CognitionState } from "./character-cognition"

describe("P2-IMP-16 assembleProcessView 三面装配核心（六维只读视图）", () => {
  const cognition: CognitionState = {
    characters: [{ character: "主角", doesNotKnow: ["秘密X"], knows: [] }],
    readerKnows: [],
    lastUpdatedChapter: 0,
  }
  const matrix: EncounterMatrixStore = {
    edges: [{ a: "主角", b: "配角", chapter: 1, context: "初遇", witnessedBy: [] }],
    lastUpdated: "",
  }
  const resources: ResourceLedgerStore = {
    entries: [{ item: "宝剑", currentHolder: "主角", acquiredChapter: 1, transferHistory: [] }],
    lastUpdated: "",
  }
  const particles: ParticleLedgerStore = { entries: [], lastUpdated: "" }
  const sources: VisibilitySources = { cognition, matrix, resources, particles }

  const summariesStore = {
    entries: [
      { chapter: 1, happened: "主角登场", stateChanges: [{ kind: "location", entity: "主角", change: "入城" }], keyReveals: [], endingHook: "" },
      { chapter: 2, happened: "遇配角", stateChanges: [], keyReveals: [], endingHook: "" },
    ],
    lastUpdated: "",
  }

  it("六维结构齐全：doesNotKnow/metBefore/heldItems/particles + stateDelta/recentSummaries", () => {
    const view = assembleProcessView("主角", 3, sources, "past", summariesStore)
    expect(view.doesNotKnow).toEqual(["秘密X"])
    expect(view.metBefore).toEqual(["配角"])
    expect(view.heldItems).toEqual(["宝剑"])
    expect(view.particles).toEqual([])
    expect(view.stateDelta).toContain("近")
    expect(view.recentSummaries).toContain("主角登场")
  })

  it("前四维与 computeVisibility 等值（装配核心复用契约函数）", () => {
    const view = assembleProcessView("主角", 3, sources, "past", null)
    const direct = computeVisibility("主角", 3, sources, "past")
    expect(view.doesNotKnow).toEqual(direct.doesNotKnow)
    expect(view.metBefore).toEqual(direct.metBefore)
    expect(view.heldItems).toEqual(direct.heldItems)
    expect(view.particles).toEqual(direct.particles)
  })

  it("summariesStore 缺失 → stateDelta/recentSummaries 空字符串（字节级降级）", () => {
    const view = assembleProcessView("主角", 3, sources, "past", null)
    expect(view.stateDelta).toBe("")
    expect(view.recentSummaries).toBe("")
  })

  it("三面同源：同 pov/chapter/sources 调用 assembleProcessView 两次结果等值（口径一致）", () => {
    const a = assembleProcessView("主角", 3, sources, "past", summariesStore)
    const b = assembleProcessView("主角", 3, sources, "past", summariesStore)
    expect(a).toEqual(b)
  })

  it("recentWindow 截断生效：仅取最近 1 章", () => {
    const view = assembleProcessView("主角", 3, sources, "past", summariesStore, 1)
    // 近 1 章 = 第 2 章
    expect(view.recentSummaries).toContain("遇配角")
    expect(view.recentSummaries).not.toContain("主角登场")
  })
})
