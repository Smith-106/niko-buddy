import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { CharacterAura } from "./character-aura"
import {
  appendAuraSnapshot,
  applyTimeDecay,
  auraEvolutionToContextText,
  createEmptyAuraEvolutionStore,
  diffAuraFields,
  loadAuraEvolution,
  saveAuraEvolution,
  snapshotAura,
  type AuraHistoryEntry,
} from "./aura-evolution"

// vi.hoisted: 内存文件系统 mock, 控制 loadAuraEvolution 读 + saveAuraEvolution 写
// (走 @/commands/fs readFile/writeFileAtomic/createDirectory, 同 emotion-ledger.spec)。
const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const k = String(p).replace(/\\/g, "/")
      if (!files.has(k)) throw new Error(`ENOENT: ${p}`)
      return files.get(k)!
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      files.set(String(p).replace(/\\/g, "/"), c)
    }),
    createDirectory: vi.fn(async () => {}),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

function mkAura(overrides: Partial<CharacterAura> = {}): CharacterAura {
  return {
    id: "test",
    builtIn: false,
    name: "test",
    sourceNote: "",
    corpus: "",
    styleDescription: "风格A",
    behaviorRules: "规则A",
    boundaries: "",
    notes: "",
    expressionDna: "dnaA",
    mentalModel: "modelA",
    decisionHeuristics: "heurA",
    valueAntiPatterns: "antiA",
    honestyBoundaries: "boundA",
    ...overrides,
  }
}

describe("A19 借鉴点 #3 P14 画像进化层 (零 LLM 字段 diff + time-decay)", () => {
  it("uses zero LLM calls (A19 硬验证: 无 streamChat/llm-client/await invoke)", () => {
    const src = readSource("aura-evolution.ts")
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/await\s+streamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })

  it("diffAuraFields returns empty when all P14 fields unchanged (=== 比对)", () => {
    const a = mkAura()
    const b = mkAura() // 同字段值
    expect(diffAuraFields(a, b)).toEqual([])
  })

  it("diffAuraFields detects single field change (expressionDna 变)", () => {
    const prev = mkAura()
    const curr = mkAura({ expressionDna: "dnaB" })
    const deltas = diffAuraFields(prev, curr)
    expect(deltas).toEqual(["expressionDna"])
  })

  it("diffAuraFields detects multiple field changes", () => {
    const prev = mkAura()
    const curr = mkAura({ expressionDna: "dnaB", mentalModel: "modelB", styleDescription: "风格B" })
    const deltas = diffAuraFields(prev, curr)
    expect(deltas).toContain("expressionDna")
    expect(deltas).toContain("mentalModel")
    expect(deltas).toContain("styleDescription")
    expect(deltas.length).toBe(3)
  })

  it("diffAuraFields treats undefined→value as change (首次设定)", () => {
    const prev = mkAura({ expressionDna: undefined })
    const curr = mkAura({ expressionDna: "dnaNew" })
    expect(diffAuraFields(prev, curr)).toContain("expressionDna")
  })

  it("diffAuraFields does not touch metadata fields (id/name/corpus 不参与 diff)", () => {
    const prev = mkAura()
    const curr = mkAura({ id: "other", name: "other", corpus: "other" })
    // 元数据字段变了但风格字段没变 → 空 delta
    expect(diffAuraFields(prev, curr)).toEqual([])
  })

  it("snapshotAura extracts only P14 style fields (不含元数据)", () => {
    const aura = mkAura({ id: "x", name: "x", expressionDna: "dnaX" })
    const snap = snapshotAura(aura)
    expect(snap.expressionDna).toBe("dnaX")
    expect(snap.mentalModel).toBe("modelA")
    // 元数据不在 snapshot
    expect((snap as any).id).toBeUndefined()
    expect((snap as any).name).toBeUndefined()
  })

  it("applyTimeDecay keeps only recent windowSize entries (滑动窗口)", () => {
    // 15 条历史 chapter 1-15, currentChapter=15, windowSize=10 → 保留 6-15
    const entries: AuraHistoryEntry[] = Array.from({ length: 15 }, (_, i) => ({
      chapter: i + 1,
      snapshot: {},
      fieldDeltas: ["expressionDna"],
      weight: 1,
    }))
    const decayed = applyTimeDecay(entries, 15, 10)
    expect(decayed.length).toBe(10)
    expect(decayed[0].chapter).toBe(6) // 近 10 章: 6-15
    expect(decayed[9].chapter).toBe(15)
  })

  it("applyTimeDecay assigns exponential decay weight (近期高 老章节低)", () => {
    const entries: AuraHistoryEntry[] = [
      { chapter: 5, snapshot: {}, fieldDeltas: ["x"], weight: 1 },
      { chapter: 15, snapshot: {}, fieldDeltas: ["x"], weight: 1 },
    ]
    const decayed = applyTimeDecay(entries, 15, 10)
    const recent = decayed.find((e) => e.chapter === 15)!
    const old = decayed.find((e) => e.chapter === 5)!
    expect(recent.weight).toBeCloseTo(1.0, 2) // exp(0) = 1
    expect(old.weight).toBeCloseTo(Math.exp(-0.1 * 10), 2) // exp(-1) ≈ 0.37
    expect(recent.weight).toBeGreaterThan(old.weight)
  })

  it("appendAuraSnapshot skips when no field change (避免无意义历史膨胀)", () => {
    const store = createEmptyAuraEvolutionStore()
    const snap = snapshotAura(mkAura())
    const updated = appendAuraSnapshot(store, "角色A", 1, snap, []) // fieldDeltas 空
    expect(updated.entries["角色A"]).toBeUndefined() // 未追加
  })

  it("appendAuraSnapshot appends when fieldDeltas non-empty", () => {
    const store = createEmptyAuraEvolutionStore()
    const snap = snapshotAura(mkAura())
    const updated = appendAuraSnapshot(store, "角色A", 1, snap, ["expressionDna"])
    expect(updated.entries["角色A"].length).toBe(1)
    expect(updated.entries["角色A"][0].chapter).toBe(1)
    expect(updated.entries["角色A"][0].fieldDeltas).toEqual(["expressionDna"])
  })

  it("auraEvolutionToContextText returns '' for empty history (向后兼容)", () => {
    const store = createEmptyAuraEvolutionStore()
    expect(auraEvolutionToContextText(store, "无此角色", 5)).toBe("")
  })

  it("auraEvolutionToContextText renders bullet report with chapter + fieldDeltas", () => {
    const store = createEmptyAuraEvolutionStore()
    const snap = snapshotAura(mkAura())
    const s1 = appendAuraSnapshot(store, "角色A", 3, snap, ["expressionDna", "mentalModel"])
    const text = auraEvolutionToContextText(s1, "角色A", 3)
    expect(text).toContain("角色A 画像漂移历史")
    expect(text).toContain("第3章画像变化")
    expect(text).toContain("expressionDna")
    expect(text).toContain("mentalModel")
    expect(text).toContain("权重")
  })

  it("save/load round-trip preserves store (createAtomicJsonStore MAINT-002)", async () => {
    fsMocks.files.clear()
    const store = createEmptyAuraEvolutionStore()
    const snap = snapshotAura(mkAura())
    const withEntry = appendAuraSnapshot(store, "角色A", 1, snap, ["expressionDna"])
    // 真 round-trip: save 走 mock writeFileAtomic 写入内存, load 走 mock readFile 读回。
    await saveAuraEvolution("/test-proj", withEntry)
    const loaded = await loadAuraEvolution("/test-proj")
    expect(loaded.entries["角色A"].length).toBe(1)
    expect(loaded.entries["角色A"][0].fieldDeltas).toEqual(["expressionDna"])
    expect(loaded.entries["角色A"][0].chapter).toBe(1)
    // 不存在的路径 → load 回退 createEmptyStore (readFile ENOENT → catch)
    const empty = await loadAuraEvolution("/nonexistent-test-path-aura-evo")
    expect(empty.entries).toEqual({})
  })
})
