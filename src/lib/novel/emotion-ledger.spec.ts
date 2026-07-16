import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  applyEmotionDelta,
  calculateEmotionNetValue,
  checkEmotionCircuitBreaker,
  createEmptyEmotionLedgerStore,
  emotionLedgerToContextText,
  formatEmotionContext,
  getTopEmotionalDebt,
  type EmotionLedgerEntry,
  type EmotionLedgerStore,
} from "./emotion-ledger"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

function makeEntry(
  name: string,
  v: number,
  a: number,
  d: number,
  history: { chapter: number; delta: number; reason: string }[] = [],
): EmotionLedgerEntry {
  const entry: EmotionLedgerEntry = {
    characterName: name,
    valence: v,
    arousal: a,
    dominance: d,
    netValue: 0,
    lastUpdatedChapter: 1,
    history,
  }
  entry.netValue = calculateEmotionNetValue(entry)
  return entry
}

describe("A19 emotion-ledger pilot (NovelForge-v5 EmotionTracker 移植, 机械层零 LLM)", () => {
  it("uses createAtomicJsonStore for persistence (MAINT-002 同域模式, 与 emotional-arcs/resource-ledger 共享 boilerplate)", () => {
    const src = readSource("emotion-ledger.ts")
    expect(src).toMatch(/createAtomicJsonStore/)
    // Forbidden: manual atomic-write boilerplate (违反 MAINT-002 同域复用).
    expect(src).not.toMatch(/import\s*\{[^}]*\bwriteFileAtomic\b[^}]*\}/)
  })

  it("registered emotion-ledger.json via createAtomicJsonStore (F-002 atomic write path)", () => {
    const src = readSource("emotion-ledger.ts")
    expect(src).toMatch(/emotion-ledger\.json/)
  })

  it("zero LLM calls in emotion-ledger.ts (A19 机械层零 LLM 硬验证)", () => {
    const src = readSource("emotion-ledger.ts")
    // No streamChat/llm-client/invoke calls — only arithmetic + fs via store.
    expect(src).not.toMatch(/\bstreamChat\b/)
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    // invoke (Tauri IPC) only via the shared createAtomicJsonStore indirection,
    // not a direct LLM or model invoke.
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })

  it("calculateEmotionNetValue = valence*0.4 + arousal*0.3 + dominance*0.3 + history delta sum", () => {
    // No history: pure weighted base.
    const noHistory = makeEntry("A", -0.5, 0.3, -0.2, [])
    // -0.5*0.4 + 0.3*0.3 + -0.2*0.3 = -0.2 + 0.09 - 0.06 = -0.17
    expect(noHistory.netValue).toBeCloseTo(-0.17, 5)

    // With history delta accumulation.
    const withHistory = makeEntry("A", -0.5, 0.3, -0.2, [
      { chapter: 2, delta: -0.3, reason: "背叛" },
      { chapter: 3, delta: -0.1, reason: "失去" },
    ])
    // base(-0.17) + (-0.3 + -0.1) = -0.57
    expect(withHistory.netValue).toBeCloseTo(-0.57, 5)
  })

  it("calculateEmotionNetValue clamps out-of-range axis values to [-1, 1]", () => {
    // valence 5 → clamped to 1, dominance -3 → clamped to -1.
    const dirty = makeEntry("A", 5, 0, -3, [])
    // 1*0.4 + 0*0.3 + -1*0.3 = 0.1
    expect(dirty.netValue).toBeCloseTo(0.1, 5)
  })

  it("applyEmotionDelta is pure — does not mutate input, appends history, recomputes netValue", () => {
    const original = makeEntry("昴", -0.2, 0.1, 0.0, [
      { chapter: 1, delta: -0.1, reason: "初压" },
    ])
    const originalSnapshot = JSON.stringify(original)
    const next = applyEmotionDelta(
      original,
      { valence: -0.3, arousal: 0.1, dominance: -0.2, reason: "背叛" },
      2,
    )
    // Original untouched (pure).
    expect(JSON.stringify(original)).toBe(originalSnapshot)
    // History appended (now 2 entries).
    expect(next.history).toHaveLength(2)
    expect(next.history[1]).toEqual({ chapter: 2, delta: -0.4, reason: "背叛" })
    // Axes updated + clamped.
    expect(next.valence).toBeCloseTo(-0.5, 5)
    expect(next.arousal).toBeCloseTo(0.2, 5)
    expect(next.dominance).toBeCloseTo(-0.2, 5)
    expect(next.lastUpdatedChapter).toBe(2)
    // netValue recomputed (not the stale 0 placeholder).
    expect(next.netValue).not.toBe(0)
    expect(next.netValue).toBeCloseTo(calculateEmotionNetValue(next), 5)
  })

  it("getTopEmotionalDebt sorts ascending by netValue (most-negative = heaviest debt first)", () => {
    const store: EmotionLedgerStore = {
      entries: [
        makeEntry("平稳者", 0.5, 0.2, 0.3),
        makeEntry("崩坏者", -0.8, 0.4, -0.6),
        makeEntry("承压者", -0.4, 0.1, -0.2),
      ],
      lastUpdated: new Date().toISOString(),
    }
    const top2 = getTopEmotionalDebt(store, 2)
    expect(top2.map((e) => e.characterName)).toEqual(["崩坏者", "承压者"])
  })

  it("formatEmotionContext labels debt tiers by netValue threshold", () => {
    const heavy = makeEntry("崩坏者", -0.8, 0.4, -0.6)
    // Push netValue below -0.3 via history so the label is 长期承压状态.
    const heavyEntry: EmotionLedgerEntry = {
      ...heavy,
      netValue: -0.7,
    }
    expect(formatEmotionContext(heavyEntry)).toContain("长期承压状态")
    expect(formatEmotionContext(heavyEntry)).toContain("情绪净值 -0.70")

    const positive = makeEntry("积极者", 0.6, 0.2, 0.4)
    const positiveEntry: EmotionLedgerEntry = { ...positive, netValue: 0.5 }
    expect(formatEmotionContext(positiveEntry)).toContain("情绪积极状态")

    const neutral = makeEntry("平稳者", 0.0, 0.0, 0.0)
    expect(formatEmotionContext(neutral)).toContain("情绪平稳")
  })

  it("emotionLedgerToContextText returns '' for empty store (backward compatible)", () => {
    expect(emotionLedgerToContextText(createEmptyEmotionLedgerStore())).toBe("")
  })

  it("emotionLedgerToContextText renders top-5 debt entries as bullet list", () => {
    const entries = [
      makeEntry("A", -0.8, 0.4, -0.6),
      makeEntry("B", -0.5, 0.1, -0.2),
      makeEntry("C", 0.6, 0.2, 0.4),
    ]
    const store: EmotionLedgerStore = {
      entries,
      lastUpdated: new Date().toISOString(),
    }
    const text = emotionLedgerToContextText(store)
    // Two bullet lines (top-5, but only 3 entries; all rendered).
    expect(text.split("\n")).toHaveLength(3)
    expect(text).toMatch(/^- A：情绪净值/)
    // Heaviest debt (A) appears first.
    expect(text.indexOf("A：")).toBeLessThan(text.indexOf("B："))
  })

  it("checkEmotionCircuitBreaker trips when any netValue < threshold (ADR-17 fix-loop guard)", () => {
    const store: EmotionLedgerStore = {
      entries: [
        makeEntry("崩坏者", -0.8, 0.4, -0.6, [
          { chapter: 2, delta: -0.4, reason: "背叛" },
        ]),
      ],
      lastUpdated: new Date().toISOString(),
    }
    // 崩坏者 netValue ≈ base(-0.26) + (-0.4) = -0.66 < -0.6 → trips.
    const cb = checkEmotionCircuitBreaker(store, -0.6)
    expect(cb.tripped).toBe(true)
    expect(cb.reason).toContain("崩坏者")
    expect(cb.reason).toContain("SUSPEND")
  })

  it("checkEmotionCircuitBreaker does not trip when all netValues >= threshold", () => {
    const store: EmotionLedgerStore = {
      entries: [makeEntry("平稳者", 0.3, 0.1, 0.2)],
      lastUpdated: new Date().toISOString(),
    }
    const cb = checkEmotionCircuitBreaker(store, -0.6)
    expect(cb.tripped).toBe(false)
    expect(cb.reason).toBe("")
  })

  it("checkEmotionCircuitBreaker on empty store does not trip (no debt to evaluate)", () => {
    const cb = checkEmotionCircuitBreaker(createEmptyEmotionLedgerStore(), -0.6)
    expect(cb.tripped).toBe(false)
  })
})
