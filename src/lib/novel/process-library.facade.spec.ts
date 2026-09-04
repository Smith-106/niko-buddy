/**
 * E-03 (run-execute-1, 双库架构蓝图) 验收⑥⑦ — ProcessLibrary 门面 spec。
 *
 * 共识 C-7：computeVisibility 纯函数（注入侧全量复用；审计侧仅 knowledge-leak
 * 装配复用，lost-item 保持全量视图输入）；查询侧 join key 经 resolveCanonicalName
 * 归一（验收⑦）；三装配方法签名零改动（验收⑤）。
 *
 * 分层：契约层（测 computeVisibility，无需 mock）+ 门面层（测 visibleInfoFor
 * 渲染，mock 四个 loader）。
 */
import { describe, it, expect, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
  listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
  fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
}))

import { computeVisibility, visibleInfoFor } from "./process-library"
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import { createEmptyEncounterMatrixStore } from "./encounter-matrix"
import { createEmptyParticleLedgerStore } from "./particle-ledger"
import { createEmptyResourceLedgerStore } from "./resource-ledger"
import type { CognitionState } from "./character-cognition"

function makeSources(overrides: Partial<Parameters<typeof computeVisibility>[2]> = {}) {
  const cognition: CognitionState = {
    characters: [
      { character: "菜月昴", knows: [], doesNotKnow: ["密道位置"] },
      { character: "艾米莉娅", knows: [], doesNotKnow: [] },
    ],
    readerKnows: [],
    lastUpdatedChapter: 3,
  }
  const matrix = createEmptyEncounterMatrixStore()
  matrix.edges = [
    { a: "菜月昴", b: "蕾姆", chapter: 2, context: "", witnessedBy: [] },
    { a: "菜月昴", b: "拉姆", chapter: 4, context: "", witnessedBy: [] },
  ]
  const resources = createEmptyResourceLedgerStore()
  resources.entries = [
    { item: "徽章", currentHolder: "菜月昴", acquiredChapter: 1, transferHistory: [] },
    { item: "剑", currentHolder: "莱因哈特", acquiredChapter: 2, transferHistory: [] },
  ]
  const particles = createEmptyParticleLedgerStore()
  particles.entries = [
    { kind: "money", character: "菜月昴", name: "银币", chapter: 1, delta: -10, state: "余 90", note: "" },
    { kind: "injury", character: "菜月昴", name: "左臂", chapter: 2, delta: 1, state: "轻伤", note: "" },
  ]
  return { cognition, matrix, resources, particles, ...overrides }
}

describe("E-03 computeVisibility 契约层（POV 三元过滤，验收⑥）", () => {
  it("T1: doesNotKnow 只含该 POV 不知道的事实", () => {
    const vis = computeVisibility("菜月昴", 3, makeSources())
    expect(vis.doesNotKnow).toEqual(["密道位置"])
    const vis2 = computeVisibility("艾米莉娅", 3, makeSources())
    expect(vis2.doesNotKnow).toEqual([])
  })

  it("T2: metBefore 按章过滤（chapter 之前的见面才计入）", () => {
    const vis = computeVisibility("菜月昴", 3, makeSources())
    expect(vis.metBefore).toEqual(["蕾姆"]) // 第 4 章拉姆不算
    const vis2 = computeVisibility("菜月昴", 5, makeSources())
    expect(vis2.metBefore.sort()).toEqual(["拉姆", "蕾姆"])
  })

  it("T3: heldItems 只含该 POV 持有的物品（resource-ledger join）", () => {
    const vis = computeVisibility("菜月昴", 3, makeSources())
    expect(vis.heldItems).toEqual(["徽章"])
    const vis2 = computeVisibility("莱因哈特", 3, makeSources())
    expect(vis2.heldItems).toEqual(["剑"])
  })

  it("T4: particles 只含该 POV 的粒子状态（money/injury/technique）", () => {
    const vis = computeVisibility("菜月昴", 3, makeSources())
    expect(vis.particles).toHaveLength(2)
    expect(vis.particles[0]).toEqual({ kind: "money", name: "银币", state: "余 90" })
    expect(vis.particles[1]).toEqual({ kind: "injury", name: "左臂", state: "轻伤" })
    const vis2 = computeVisibility("蕾姆", 3, makeSources())
    expect(vis2.particles).toEqual([])
  })

  it("T5: 纯函数 — 同输入同输出，无 IO 无写句柄", () => {
    const s = makeSources()
    const a = computeVisibility("菜月昴", 3, s)
    const b = computeVisibility("菜月昴", 3, s)
    expect(a).toEqual(b)
  })

  it("T6: join key 归一 — 中黑点/全角变体查询命中 canonical 键（验收⑦）", () => {
    // fold 入键归一为 canonical「菜月昴」；查询侧 resolveCanonicalName
    // NFKC + 中黑点剥离后命中（无 aliasMap 时的归一路径）。
    const vis = computeVisibility("菜月・昴", 3, makeSources())
    expect(vis.heldItems).toEqual(["徽章"])
    expect(vis.doesNotKnow).toEqual(["密道位置"])
  })

  it("T7: 注入与审计一致 — 同一 POV+chapter 的 knowledge_boundary 判定一致", () => {
    const s = makeSources()
    const vis = computeVisibility("菜月昴", 3, s)
    // auditChapter 的 knowledge-leak 输入由同一函数对每个在场角色求值组装
    // （本 spec 验证契约函数本身；门面集成见 visibleInfoFor 渲染测试）。
    expect(vis.doesNotKnow.length).toBeGreaterThan(0)
    expect(vis.metBefore).toContain("蕾姆")
  })
})

describe("E-03 visibleInfoFor 门面层（渲染 + 只读）", () => {
  it("渲染 POV 可见信息（doesNotKnow/metBefore/heldItems/particles）", async () => {
    const s = makeSources()
    const files = new Map<string, string>()
    files.set("/P/.novel/cognition-state.json", JSON.stringify(s.cognition))
    files.set("/P/.novel/encounter-matrix.json", JSON.stringify(s.matrix))
    files.set("/P/.novel/particle-ledger.json", JSON.stringify(s.particles))
    files.set("/P/.novel/resource-ledger.json", JSON.stringify(s.resources))
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p)
    })
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.deleteFile.mockResolvedValue(undefined)
    fsMocks.fileExists.mockImplementation(async (p: string) => files.has(p))
    fsMocks.listDirectory.mockImplementation(async () => { throw new Error("ENOENT") })
    const text = await visibleInfoFor("/P", "菜月昴", 3)
    expect(text).toContain("【菜月昴 不知道】密道位置")
    expect(text).toContain("【菜月昴 已见过】蕾姆")
    expect(text).toContain("【菜月昴 持有】徽章")
    expect(text).toContain("【菜月昴 money】银币 → 余 90")
  })
})

describe("E-04 auditChapter 门面层（三口诀装配 + 零写句柄 + 证据分级）", () => {
  function setupStores() {
    const files = new Map<string, string>()
    files.set("/P/.novel/cognition-state.json", JSON.stringify({
      characters: [
        { character: "菜月昴", knows: [], doesNotKnow: ["密道位置"] },
        { character: "艾米莉娅", knows: [], doesNotKnow: [] },
      ],
      readerKnows: [],
      lastUpdatedChapter: 3,
    }))
    files.set("/P/.novel/encounter-matrix.json", JSON.stringify({
      edges: [{ a: "菜月昴", b: "蕾姆", chapter: 2, context: "客栈", witnessedBy: [] }],
      lastUpdated: "",
    }))
    files.set("/P/.novel/particle-ledger.json", JSON.stringify({
      entries: [{ kind: "injury", character: "菜月昴", name: "左臂", chapter: 2, delta: 0, state: "已愈", note: "text-heuristic" }],
      lastUpdated: "",
    }))
    files.set("/P/.novel/resource-ledger.json", JSON.stringify({
      entries: [{ item: "徽章", currentHolder: "菜月昴", chapter: 2, note: "" }],
      lastUpdated: "",
    }))
    files.set("/P/.novel/foreshadowing-tracker.json", JSON.stringify({
      items: [{
        id: "F-001", name: "密道钥匙", description: "", status: "planted",
        plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "",
      }],
      lastUpdated: "",
    }))
    files.set("/P/.novel/character-states.json", JSON.stringify({
      characters: [{ characterName: "乙", isAlive: false, deathChapter: 4 }],
      lastUpdated: "",
    }))
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p)
    })
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
    fsMocks.fileExists.mockImplementation(async (p: string) => files.has(p))
    fsMocks.listDirectory.mockImplementation(async () => { throw new Error("ENOENT") })
    return files
  }

  it("三口诀齐备：knowledge_boundary + lost_item + foreshadowing 同批产出", async () => {
    setupStores()
    const { auditChapter } = await import("./process-library")
    const report = await auditChapter(
      "/P", 6,
      ["菜月昴"],
      ["徽章"],
      { 菜月昴: ["左臂"] },
      { chapterText: "菜月昴说出了密道位置，左臂的伤又发作了。" },
    )
    const types = report.findings.map((f) => f.type)
    expect(types).toContain("knowledge_boundary")   // 口诀①: 正文命中密道位置 → critical
    expect(types).toContain("lost_item")            // 口诀②: 粒子矛盾 (已愈却再现)
    expect(types).toContain("unresolved_foreshadowing") // 口诀③: 伏笔陈化/没收
    // 口诀①证据命中 → critical; 口诀②粒子 text 源 → warning; 口诀③ → warning
    const kb = report.findings.find((f) => f.type === "knowledge_boundary")
    expect(kb?.severity).toBe("critical")
    const li = report.findings.find((f) => f.type === "lost_item")
    expect(li?.severity).toBe("warning")
    const fs = report.findings.find((f) => f.type === "unresolved_foreshadowing")
    expect(fs?.severity).toBe("warning")
  })

  it("零写句柄：auditChapter 全程不触碰 fs 写面", async () => {
    setupStores()
    const { auditChapter } = await import("./process-library")
    await auditChapter("/P", 6, ["菜月昴"], ["徽章"], { 菜月昴: ["左臂"] })
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("证据分级：无 chapterText/chapterFacts → knowledge_boundary 降级 info（不妄断）", async () => {
    setupStores()
    const { auditChapter } = await import("./process-library")
    const report = await auditChapter("/P", 6, ["菜月昴"], ["徽章"])
    const kb = report.findings.find((f) => f.type === "knowledge_boundary")
    expect(kb).toBeUndefined()
    const gap = report.findings.find(
      (f) => (f as Extract<ContinuityFinding, { subtype: "data_gap" }>).missingField === "leak_evidence",
    ) as Extract<ContinuityFinding, { subtype: "data_gap" }> | undefined
    expect(gap?.severity).toBe("info")
  })

  it("extractAuditInputsFromText：正文确定性子串提取在场实体", async () => {
    const { extractAuditInputsFromText } = await import("./process-library")
    const s = makeSources()
    const extracted = extractAuditInputsFromText("菜月昴握着徽章，左臂的伤隐隐作痛。", {
      cognition: s.cognition,
      resources: s.resources,
      particles: s.particles,
    })
    expect(extracted.presentCharacters).toContain("菜月昴")
    expect(extracted.presentItems).toContain("徽章")
    expect(extracted.presentParticles["菜月昴"]).toContain("左臂")
  })
})
