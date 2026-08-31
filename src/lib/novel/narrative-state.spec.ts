import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  characterView,
  declareVisibility,
  filterDeceasedObservers,
  inferLocationVisibility,
  isTemporallyCovering,
  observePublicDeclaration,
  validateTemporalOrder,
  TEMPORAL_OPEN,
  type NarrativeDeclaration,
  type NarrativeStateStore,
  type VisibilityDeclaration,
} from "./narrative-state"

function decl(overrides: Partial<NarrativeDeclaration>): NarrativeDeclaration {
  return {
    declarationId: "d1",
    entityId: "loc-cafe",
    entityType: "location",
    property: "atmosphere",
    description: "咖啡厅角落有暗门",
    modality: "fact",
    validFrom: "ch1",
    validTo: TEMPORAL_OPEN,
    recordedAt: "t1",
    ...overrides,
  }
}

function vis(overrides: Partial<VisibilityDeclaration>): VisibilityDeclaration {
  return {
    declarationId: "d1",
    characterId: "c1",
    state: "known",
    source: "explicit",
    validFrom: "ch1",
    validTo: TEMPORAL_OPEN,
    isExplicit: true,
    ...overrides,
  }
}

describe("narrative-state（吸收 underworld-graph 双时态+信息差五步过滤模式）", () => {
  it("TEMPORAL_OPEN 覆盖判断：未闭合视作无终点", () => {
    expect(isTemporallyCovering("ch1", TEMPORAL_OPEN, "ch9")).toBe(true)
    expect(isTemporallyCovering("ch1", "ch3", "ch2")).toBe(true)
    expect(isTemporallyCovering("ch1", "ch3", "ch3")).toBe(false)
  })

  it("五步过滤：known+覆盖+起点 max 生效；unknown/未覆盖被排除", () => {
    const decls = [decl({}), decl({ declarationId: "d2", property: "secret" })]
    const vs = [vis({ declarationId: "d1" }), vis({ declarationId: "d2", state: "unknown" })]
    const view = characterView(decls, vs, "c1", "ch5")
    expect(view.map((d) => d.declarationId)).toEqual(["d1"])
  })

  it("知识持续：声明已闭合（validTo 过去）但知识仍可见", () => {
    const decls = [decl({ validTo: "ch3" })]
    const view = characterView(decls, [vis({})], "c1", "ch9")
    expect(view).toHaveLength(1)
  })

  it("有效起点 = max(vis.validFrom, decl.validFrom)：可见性晚于声明则后移", () => {
    const decls = [decl({})]
    expect(characterView(decls, [vis({ validFrom: "ch5" })], "c1", "ch3")).toHaveLength(0)
    expect(characterView(decls, [vis({ validFrom: "ch5" })], "c1", "ch5")).toHaveLength(1)
  })

  it("modalityFilter 过滤模态", () => {
    const decls = [decl({ modality: "fact" }), decl({ declarationId: "d2", modality: "hypothesis", entityId: "x" })]
    const vs = [vis({}), vis({ declarationId: "d2" })]
    const onlyFact = characterView(decls, vs, "c1", "ch5", { modalityFilter: ["fact"] })
    expect(onlyFact.map((d) => d.declarationId)).toEqual(["d1"])
  })

  it("recordedAsOf retcon 隔离：之后补写的声明与可见性不可见", () => {
    const decls = [
      decl({}),
      decl({ declarationId: "d2", recordedAt: "t9", description: "事后补写" }),
    ]
    const vs = [vis({}), vis({ declarationId: "d2", recordedAt: "t9" })]
    const atT5 = characterView(decls, vs, "c1", "ch9", { recordedAsOf: "t5" })
    expect(atT5.map((d) => d.declarationId)).toEqual(["d1"])
    const atT9 = characterView(decls, vs, "c1", "ch9", { recordedAsOf: "t9" })
    expect(atT9).toHaveLength(2)
  })

  it("inferLocationVisibility：角色位于地点 → 目击地点实体全部有效声明", () => {
    const decls = [
      decl({}),
      decl({ declarationId: "d2", validFrom: "ch2" }),
      decl({ declarationId: "d3", entityId: "loc-other", validFrom: "ch2" }),
    ]
    const rels = [{ sourceId: "c1", targetId: "loc-cafe", validFrom: "ch2", validTo: TEMPORAL_OPEN }]
    const additions = inferLocationVisibility(decls, [], rels, "ch4")
    expect(additions.map((a) => a.declarationId).sort()).toEqual(["d1", "d2"])
    expect(additions.every((a) => a.source === "witnessed" && !a.isExplicit)).toBe(true)
    expect(additions[0].validFrom).toBe("ch2")
  })

  it("inferLocationVisibility 幂等：已可见不重复；撤销回填保护：曾撤销→从当前时刻起", () => {
    const decls = [decl({})]
    const rels = [{ sourceId: "c1", targetId: "loc-cafe", validFrom: "ch1", validTo: TEMPORAL_OPEN }]
    // 幂等
    const once = inferLocationVisibility(decls, [vis({ source: "explicit" })], rels, "ch3")
    expect(once).toHaveLength(0)
    // 撤销回填保护：曾有一条 validTo=ch2 的闭合记录
    const revoked: VisibilityDeclaration[] = [vis({ validTo: "ch2", source: "witnessed", isExplicit: false })]
    const again = inferLocationVisibility(decls, revoked, rels, "ch5")
    expect(again).toHaveLength(1)
    expect(again[0].validFrom).toBe("ch5")
  })

  it("declareVisibility 构造显式声明", () => {
    const v = declareVisibility({ declarationId: "d1", characterId: "c2", state: "known", validFrom: "ch1" })
    expect(v.isExplicit).toBe(true)
    expect(v.source).toBe("explicit")
    expect(v.validTo).toBe(TEMPORAL_OPEN)
  })

  it("validateTemporalOrder：时态倒置报错", () => {
    expect(validateTemporalOrder([decl({ validTo: "ch0" })])).toHaveLength(1)
    expect(validateTemporalOrder([decl({ validTo: "ch9" })])).toEqual([])
  })

  it("确定性：同输入双跑全等", () => {
    const decls = [decl({})]
    const vs = [vis({})]
    expect(JSON.stringify(characterView(decls, vs, "c1", "ch5"))).toBe(
      JSON.stringify(characterView(decls, vs, "c1", "ch5")),
    )
  })

  it("空输入安全", () => {
    expect(characterView([], [], "c1", "ch1")).toEqual([])
    expect(inferLocationVisibility([], [], [], "ch1")).toEqual([])
  })
})

describe("narrative-state 激活增量（27 号评估 V5 共识：持久化门面/他盲修复/死亡级联）", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("observePublicDeclaration：观察者习得公开声明（inferred）", () => {
    const additions = observePublicDeclaration([], {
      declarationId: "d1",
      observerIds: ["c1", "c2"],
      storyTime: "ch3",
    })
    expect(additions).toHaveLength(2)
    expect(additions.every((a) => a.source === "inferred" && !a.isExplicit && a.validFrom === "ch3")).toBe(true)
  })

  it("observePublicDeclaration 幂等不降级：已 known 跳过；显式 unknown 尊重跳过", () => {
    const existing = [
      vis({ characterId: "c1" }), // 已 known
      vis({ characterId: "c2", state: "unknown", isExplicit: true }), // 显式否认
    ]
    const additions = observePublicDeclaration(existing, {
      declarationId: "d1",
      observerIds: ["c1", "c2", "c3"],
      storyTime: "ch3",
    })
    expect(additions.map((a) => a.characterId)).toEqual(["c3"])
  })

  it("observePublicDeclaration：显式 unknown 曾撤销区间不阻断新习得（撤销后可重新目击）", () => {
    const existing = [vis({ characterId: "c1", state: "unknown", isExplicit: true, validTo: "ch1" })]
    const additions = observePublicDeclaration(existing, {
      declarationId: "d1",
      observerIds: ["c1"],
      storyTime: "ch3",
    })
    // 显式 unknown 已闭合（validTo=ch1 < storyTime）→ 不在生效期 → 允许重新习得
    expect(additions).toHaveLength(1)
  })

  it("filterDeceasedObservers：死亡角色不再习得新知；死亡前关系保留", () => {
    const rels = [
      { sourceId: "alive", targetId: "loc1", validFrom: "ch1", validTo: TEMPORAL_OPEN },
      { sourceId: "dead", targetId: "loc1", validFrom: "ch1", validTo: TEMPORAL_OPEN },
    ]
    const deaths = [{ entityId: "dead", storyTime: "ch2" }]
    const filtered = filterDeceasedObservers(rels, deaths, "ch3")
    expect(filtered.map((r) => r.sourceId)).toEqual(["alive"])
    // 死亡前（ch1）死者仍在场
    expect(filterDeceasedObservers(rels, deaths, "ch1")).toHaveLength(2)
  })

  it("持久化门面往返：save→load 还原（mock fs）", async () => {
    const fsMocks = vi.hoisted(() => ({
      createDirectory: vi.fn(async () => {}),
      writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
      readFile: vi.fn<(path: string) => Promise<string>>(async () => {
        throw new Error("ENOENT")
      }),
    }))
    vi.mock("@/commands/fs", () => ({
      createDirectory: fsMocks.createDirectory,
      writeFileAtomic: fsMocks.writeFileAtomic,
      readFile: fsMocks.readFile,
    }))
    const { saveNarrativeState: save, loadNarrativeState: load } = await import("./narrative-state")
    let captured: string | null = null
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      captured = content
    })
    const store: NarrativeStateStore = {
      declarations: [decl({})],
      visibilities: [vis({})],
      locatedInRelations: [],
      events: [],
      lastUpdated: "t1",
    }
    await save("/proj", store)
    expect(captured).not.toBeNull()
    fsMocks.readFile.mockImplementation(async () => captured as string)
    const loaded = await load("/proj")
    expect(loaded.declarations).toHaveLength(1)
    expect(loaded.declarations[0].declarationId).toBe("d1")
  })

  it("确定性：observePublicDeclaration 双跑全等", () => {
    const input = { declarationId: "d1", observerIds: ["c1"], storyTime: "ch3" }
    expect(JSON.stringify(observePublicDeclaration([], input))).toBe(
      JSON.stringify(observePublicDeclaration([], input)),
    )
  })
})
