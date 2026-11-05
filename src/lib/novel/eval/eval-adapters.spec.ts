import { describe, expect, it } from "vitest"
import {
  canonFactToGoldChunk,
  computeEvalDigest,
  contextPackToAssembledView,
  edgeKindToReasonCode,
  isL3CriticalFinding,
  layerContainsTriple,
  temporalFactToPoisonChunk,
  tripleKey,
} from "./eval-adapters"
import { computeCheckpointDigestOf } from "../checkpoint-digest"
import type { CanonFact } from "../canon-graph-client"
import type { TemporalFact } from "../temporal-memory"
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type { ContextPack } from "../context-engine"

function canonFact(over: Partial<CanonFact> = {}): CanonFact {
  return {
    id: "canon-1",
    sourceId: "林默",
    targetId: "  凌霄殿 ",
    predicate: "位于",
    edgeKind: "world_fact",
    archived: false,
    ...over,
  }
}

function temporalFact(over: Partial<TemporalFact> = {}): TemporalFact {
  return {
    id: "temp-1",
    subject: "林默",
    predicate: "持有",
    object: "轩辕剑",
    validFrom: 3,
    source: "ch3",
    ...over,
  }
}

function finding(over: Partial<ContinuityFinding> = {}): ContinuityFinding {
  return {
    type: "dormant_thread",
    subtype: "consistency_mechanical",
    severity: "critical",
    ref: "character:林默",
    message: "机械不一致",
    chapter: 5,
    ...over,
  } as ContinuityFinding
}

function pack(over: Partial<ContextPack> = {}): ContextPack {
  return {
    task: "t",
    chapterGoal: "g",
    outline: "o",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
    ...over,
  } as ContextPack
}

describe("edgeKindToReasonCode", () => {
  it("hard/attribute 直映 world_fact/attribute", () => {
    expect(edgeKindToReasonCode("hard")).toBe("world_fact")
    expect(edgeKindToReasonCode("attribute")).toBe("attribute")
  })

  it("cognition 按模态细分 belief/hypothesis，缺省回落 cognition", () => {
    expect(edgeKindToReasonCode("cognition", "belief")).toBe("belief")
    expect(edgeKindToReasonCode("cognition", "hypothesis")).toBe("hypothesis")
    expect(edgeKindToReasonCode("cognition")).toBe("cognition")
    expect(edgeKindToReasonCode("cognition", null)).toBe("cognition")
    expect(edgeKindToReasonCode("cognition", "assertive")).toBe("cognition")
  })

  it("foreshadow 直映，未知 kind 原样透传", () => {
    expect(edgeKindToReasonCode("foreshadow")).toBe("foreshadow")
    expect(edgeKindToReasonCode("motivation")).toBe("motivation")
  })
})

describe("canonFactToGoldChunk", () => {
  it("sourceId→subject / targetId→object 并经规范名归一（去空白）", () => {
    const chunk = canonFactToGoldChunk(canonFact())
    expect(chunk.id).toBe("canon-1")
    expect(chunk.subject).toBe("林默")
    expect(chunk.object).toBe("凌霄殿")
    expect(chunk.predicate).toBe("位于")
    expect(chunk.tier).toBe("protected")
    expect(chunk.expectedLayer).toBe("protected")
  })

  it("显式 tier 透传", () => {
    expect(canonFactToGoldChunk(canonFact(), "draft").tier).toBe("draft")
  })
})

describe("temporalFactToPoisonChunk", () => {
  it("former 事实 → former_as_current 落 former 层", () => {
    const chunk = temporalFactToPoisonChunk(temporalFact({ former: true }))
    expect(chunk.poisonType).toBe("former_as_current")
    expect(chunk.expectedLanding).toBe("former")
    expect(chunk.subject).toBe("林默")
    expect(chunk.predicate).toBe("持有")
    expect(chunk.object).toBe("轩辕剑")
  })

  it("现行事实 → contradiction 且禁入 former 层", () => {
    const chunk = temporalFactToPoisonChunk(temporalFact())
    expect(chunk.poisonType).toBe("contradiction")
    expect(chunk.expectedLanding).toBe("excluded")
  })
})

describe("isL3CriticalFinding", () => {
  it("critical + consistency_mechanical 才是 L3 信号", () => {
    expect(isL3CriticalFinding(finding())).toBe(true)
  })

  it("warning 级别或 data_gap 子类均非 L3 信号", () => {
    expect(isL3CriticalFinding(finding({ severity: "warning" }))).toBe(false)
    expect(
      isL3CriticalFinding(finding({ subtype: "data_gap", missingField: "x" } as Partial<ContinuityFinding>)),
    ).toBe(false)
    expect(isL3CriticalFinding(finding({ severity: "info" }))).toBe(false)
  })
})

describe("contextPackToAssembledView", () => {
  it("canonRules/timeline/characterStates 进 protectedCurrent", () => {
    const view = contextPackToAssembledView(
      pack({ canonRules: "规则", timeline: "线", characterStates: "态" }),
    )
    expect(view.protectedCurrent).toEqual(["规则", "线", "态"])
    expect(view.compressible).toEqual([])
    expect(view.protectedFormer).toEqual([])
    expect(view.protectedLayerAssembled).toBe(true)
  })

  it("formerFacts 独立分块拼行、空值不产生空串", () => {
    const view = contextPackToAssembledView(
      pack({
        formerFacts: [
          temporalFact({ subject: "A", predicate: "p", object: "B" }),
          temporalFact({ subject: "C", predicate: "q", object: "D" }),
        ],
        communitySummaries: "摘要",
      }),
    )
    expect(view.protectedFormer).toEqual(["A p B\nC q D"])
    expect(view.compressible).toEqual(["摘要"])
    expect(view.protectedCurrent).toEqual([])
  })

  it("空 pack 三层皆空但装配标记仍为 true", () => {
    const view = contextPackToAssembledView(pack())
    expect(view.protectedCurrent).toEqual([])
    expect(view.protectedFormer).toEqual([])
    expect(view.compressible).toEqual([])
    expect(view.protectedLayerAssembled).toBe(true)
  })
})

describe("tripleKey", () => {
  it("subject/predicate/object 以 NUL 连接且 subject 归一", () => {
    expect(tripleKey("林默", "持有", "轩辕剑")).toBe("林默\0持有\0轩辕剑")
    expect(tripleKey("  林默 ", "持有", "轩辕剑")).toBe(tripleKey("林默", "持有", "轩辕剑"))
  })

  it("不同三元组键不同", () => {
    expect(tripleKey("A", "p", "B")).not.toBe(tripleKey("A", "p", "C"))
  })
})

describe("layerContainsTriple", () => {
  it("同层文本同时包含三元才命中", () => {
    expect(layerContainsTriple(["林默持有轩辕剑"], "林默", "持有", "轩辕剑")).toBe(true)
    expect(layerContainsTriple(["林默持有青铜剑"], "林默", "持有", "轩辕剑")).toBe(false)
  })

  it("缺任一元即不命中，空层恒为 false", () => {
    expect(layerContainsTriple(["林默轩辕剑"], "林默", "持有", "轩辕剑")).toBe(false)
    expect(layerContainsTriple([], "林默", "持有", "轩辕剑")).toBe(false)
  })
})

describe("computeEvalDigest", () => {
  it("复用 computeCheckpointDigestOf（同输入同 digest）", async () => {
    const value = { s: "林默", p: "持有", o: "轩辕剑" }
    await expect(computeEvalDigest(value)).resolves.toBe(
      await computeCheckpointDigestOf(value),
    )
  })

  it("不同输入 digest 不同（内容寻址有效）", async () => {
    const a = await computeEvalDigest({ x: 1 })
    const b = await computeEvalDigest({ x: 2 })
    expect(a).not.toBe(b)
    expect(typeof a).toBe("string")
    expect(a.length).toBeGreaterThan(0)
  })
})
