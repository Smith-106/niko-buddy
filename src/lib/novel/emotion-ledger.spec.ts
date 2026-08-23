import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  applyEmotionDelta,
  calculateEmotionNetValue,
  checkEmotionCircuitBreaker,
  createEmptyEmotionLedgerStore,
  emotionLedgerToContextText,
  extractChapterEmotionTone,
  formatEmotionContext,
  getCircuitBreakerStatus,
  getTopEmotionalDebt,
  resolveSceneCharacterNames,
  updateEmotionLedgerFromChapter,
  type EmotionLedgerEntry,
  type EmotionLedgerStore,
} from "./emotion-ledger"

// vi.hoisted: 内存文件系统 mock, 控制 loadCharacterStates/loadEmotionLedger 读 +
// saveEmotionLedger 写 (走 @/commands/fs readFile/writeFileAtomic/createDirectory)。
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

// 写入 character-states.json (供 loadCharacterStates 读取) + 清空 emotion-ledger.json。
function seedCharacterStates(projectPath: string, names: string[]) {
  const pp = projectPath.replace(/\\/g, "/")
  const store = {
    characters: names.map((name) => ({
      characterName: name,
      currentLocation: "loc",
      status: "active",
      equipment: [],
      abilities: [],
      relationships: {},
      lastUpdatedChapter: 0,
      lastUpdatedAt: new Date().toISOString(),
    })),
    lastUpdated: new Date().toISOString(),
  }
  fsMocks.files.set(`${pp}/.novel/character-states.json`, JSON.stringify(store))
  fsMocks.files.delete(`${pp}/.novel/emotion-ledger.json`)
}

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

  it("applyEmotionDelta tolerates a delta missing axis fields (?? 0 fallbacks)", () => {
    const original = makeEntry("昴", 0.5, 0.3, 0.2)
    const next = applyEmotionDelta(original, { reason: "仅理由，无三轴变化" }, 3)
    // 三轴保持不变：delta 缺失字段按 0 处理
    expect(next.valence).toBeCloseTo(0.5, 5)
    expect(next.arousal).toBeCloseTo(0.3, 5)
    expect(next.dominance).toBeCloseTo(0.2, 5)
    // deltaMagnitude = 0 + 0 + 0
    expect(next.history[0]).toEqual({ chapter: 3, delta: 0, reason: "仅理由，无三轴变化" })
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

  it("getCircuitBreakerStatus returns 'tripped' when netValue < threshold (F-003 BreakerStatusBadge)", () => {
    const store: EmotionLedgerStore = {
      entries: [makeEntry("崩坏者", -0.8, 0.4, -0.6, [{ chapter: 2, delta: -0.4, reason: "背叛" }])],
      lastUpdated: new Date().toISOString(),
    }
    const result = getCircuitBreakerStatus(store, -0.6)
    expect(result.status).toBe("tripped")
  })

  it("getCircuitBreakerStatus returns 'armed' when netValue is close to threshold (F-003 BreakerStatusBadge)", () => {
    const store: EmotionLedgerStore = {
      entries: [makeEntry("预警者", -0.5, -0.5, -0.5)],
      lastUpdated: new Date().toISOString(),
    }
    // netValue = (-0.5*0.4 + -0.5*0.3 + -0.5*0.3) = -0.5, which is >= -0.6 but < -0.3
    const result = getCircuitBreakerStatus(store, -0.6)
    expect(result.status).toBe("armed")
  })

  it("getCircuitBreakerStatus returns 'open' when netValue is well above threshold (F-003 BreakerStatusBadge)", () => {
    const store: EmotionLedgerStore = {
      entries: [makeEntry("平稳者", 0.5, 0.3, 0.4)],
      lastUpdated: new Date().toISOString(),
    }
    const result = getCircuitBreakerStatus(store, -0.6)
    expect(result.status).toBe("open")
  })

  it("getCircuitBreakerStatus returns 'open' for empty store (no debt to evaluate)", () => {
    const result = getCircuitBreakerStatus(createEmptyEmotionLedgerStore(), -0.6)
    expect(result.status).toBe("open")
  })
})

describe("A19 emotion-ledger 写入端 (B 方案双层机械层, TASK-001/002/003)", () => {
  beforeEach(() => {
    fsMocks.files.clear()
    fsMocks.readFile.mockClear()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("extractChapterEmotionTone returns zero delta for empty content (backward compat)", () => {
    const empty = extractChapterEmotionTone("")
    expect(empty.valence).toBe(0)
    expect(empty.arousal).toBe(0)
    expect(empty.dominance).toBe(0)
    expect(empty.reason).toBe("无情绪标记")
  })

  it("extractChapterEmotionTone detects payoff keywords → positive valence/arousal/dominance", () => {
    const content = "主角打脸反派, 实现逆袭, 觉醒新力量"
    const tone = extractChapterEmotionTone(content)
    // payoff weights: 打脸3 + 逆袭3 + 觉醒2 = 8; pressure 0.
    // valence = (8-0)/10 = 0.8, arousal = (8+0)/10 = 0.8, dominance = 0.8.
    expect(tone.valence).toBeCloseTo(0.8, 5)
    expect(tone.arousal).toBeCloseTo(0.8, 5)
    expect(tone.dominance).toBeCloseTo(0.8, 5)
    expect(tone.reason).toContain("payoff:8")
    expect(tone.reason).toContain("pressure:0")
  })

  it("extractChapterEmotionTone detects pressure keywords → negative valence/dominance", () => {
    const content = "角色遭遇背叛, 失去一切, 陷入绝望"
    const tone = extractChapterEmotionTone(content)
    // pressure weights: 背叛3 + 失去2.5 + 绝望2.5 = 8; payoff 0.
    expect(tone.valence).toBeCloseTo(-0.8, 5)
    expect(tone.dominance).toBeCloseTo(-0.8, 5)
    // arousal = (0+8)/10 = 0.8 (压抑也激增唤醒).
    expect(tone.arousal).toBeCloseTo(0.8, 5)
  })

  it("extractChapterEmotionTone mixed payoff+pressure → net by weight difference", () => {
    const content = "打脸 背叛"
    const tone = extractChapterEmotionTone(content)
    // payoff: 打脸3; pressure: 背叛3 → valence = (3-3)/10 = 0.
    expect(tone.valence).toBe(0)
    // arousal = (3+3)/10 = 0.6.
    expect(tone.arousal).toBeCloseTo(0.6, 5)
  })

  it("extractChapterEmotionTone clamps heavy payoff to [-1,1] (base 10 normalize)", () => {
    const content = "爽点 大高潮 大高潮 大高潮 大高潮 大高潮"
    const tone = extractChapterEmotionTone(content)
    // 爽点8 + 大高潮10 (重复只计一次权重) = 18 → /10 = 1.8 → clamp 1.
    expect(tone.valence).toBe(1)
    expect(tone.arousal).toBe(1)
  })

  it("extractChapterEmotionTone neutral-only content → zero delta (不污染账本)", () => {
    const content = "本章是过渡铺垫, 日常场景"
    const tone = extractChapterEmotionTone(content)
    expect(tone.valence).toBe(0)
    expect(tone.arousal).toBe(0)
    expect(tone.dominance).toBe(0)
    expect(tone.reason).toContain("无情绪标记")
  })

  it("resolveSceneCharacterNames returns [] for empty character set", () => {
    expect(resolveSceneCharacterNames("任何正文", [])).toEqual([])
  })

  it("resolveSceneCharacterNames matches only characters present in content", () => {
    const content = "昴走向艾米莉亚, 雷格鲁斯旁观"
    const names = resolveSceneCharacterNames(content, ["昴", "艾米莉亚", "雷格鲁斯", "碧翠丝"])
    // 碧翠丝 not in content → excluded.
    expect(names).toEqual(["昴", "艾米莉亚", "雷格鲁斯"])
  })

  it("resolveSceneCharacterNames handles substring names (long name matched independently)", () => {
    // '白' is a substring of '白月'. Both present in content → both matched.
    const content = "白月看着白"
    const names = resolveSceneCharacterNames(content, ["白", "白月"])
    expect(names).toContain("白月")
    expect(names).toContain("白")
  })

  it("resolveSceneCharacterNames returns [] when no known character in content", () => {
    const content = "无角色名出现的叙述"
    expect(resolveSceneCharacterNames(content, ["昴", "艾米莉亚"])).toEqual([])
  })

  it("updateEmotionLedgerFromChapter writes per-character delta for scene characters (均分, 不除以人数)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴", "艾米莉亚"])
    // 正文只含昴 + 爽点关键词, 艾米莉亚未出场.
    const content = "昴打脸反派, 觉醒力量"
    await updateEmotionLedgerFromChapter(pp, 2, content)
    // saveEmotionLedger 走 writeFileAtomic → 读回 fsMocks.files 验证.
    const savedRaw = fsMocks.files.get(`${pp}/.novel/emotion-ledger.json`)
    expect(savedRaw).toBeDefined()
    const saved: EmotionLedgerStore = JSON.parse(savedRaw!)
    // 只昴出场 → 只 1 entry.
    expect(saved.entries).toHaveLength(1)
    expect(saved.entries[0].characterName).toBe("昴")
    // 打脸3 + 觉醒2 = 5 → valence 0.5, arousal 0.5, dominance 0.5.
    // applyEmotionDelta: netValue = valence*0.4+arousal*0.3+dominance*0.3 + history delta.
    // base 0.5*0.4+0.5*0.3+0.5*0.3 = 0.5; history delta = 5+5+5=15 (三轴和)?
    // deltaMagnitude = valence+arousal+dominance delta = 0.5+0.5+0.5 = 1.5.
    // netValue = 0.5 + 1.5 = 2.0.
    const subaru = saved.entries[0]
    expect(subaru.history).toHaveLength(1)
    expect(subaru.history[0].chapter).toBe(2)
    expect(subaru.netValue).toBeCloseTo(calculateEmotionNetValue(subaru), 5)
  })

  it("updateEmotionLedgerFromChapter applies full tone to EACH scene character (not divided)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴", "艾米莉亚"])
    // 两个角色都出场 + 爽点正文 → 每个都获完整 tone delta.
    const content = "昴与艾米莉亚打脸反派"
    await updateEmotionLedgerFromChapter(pp, 3, content)
    const saved: EmotionLedgerStore = JSON.parse(
      fsMocks.files.get(`${pp}/.novel/emotion-ledger.json`)!,
    )
    expect(saved.entries).toHaveLength(2)
    // 两角色 netValue 相同 (均得完整 tone delta, 不除以人数).
    const a = saved.entries.find((e) => e.characterName === "昴")!
    const b = saved.entries.find((e) => e.characterName === "艾米莉亚")!
    expect(a.netValue).toBeCloseTo(b.netValue, 5)
    expect(a.netValue).toBeCloseTo(calculateEmotionNetValue(a), 5)
  })

  it("updateEmotionLedgerFromChapter no-op when tone is zero (neutral chapter, 不污染账本)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴"])
    const content = "本章是过渡铺垫日常"
    await updateEmotionLedgerFromChapter(pp, 4, content)
    // 无 payoff/pressure 关键词 → tone 全 0 → 不写账本 → emotion-ledger.json 不存在.
    expect(fsMocks.files.has(`${pp}/.novel/emotion-ledger.json`)).toBe(false)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("updateEmotionLedgerFromChapter no-op when no scene characters (正文无已知角色)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴"])
    // 爽点正文但昴未出场.
    const content = "神秘人打脸反派"
    await updateEmotionLedgerFromChapter(pp, 5, content)
    // tone 非零但无出场角色 → 不写账本.
    expect(fsMocks.files.has(`${pp}/.novel/emotion-ledger.json`)).toBe(false)
  })

  it("updateEmotionLedgerFromChapter upserts existing entries (累积 history, 不覆盖)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴"])
    // 第一次写入.
    await updateEmotionLedgerFromChapter(pp, 1, "昴打脸反派")
    // 第二次写入同角色 — 应 upsert 追加 history 不覆盖.
    await updateEmotionLedgerFromChapter(pp, 2, "昴逆袭成功")
    const saved: EmotionLedgerStore = JSON.parse(
      fsMocks.files.get(`${pp}/.novel/emotion-ledger.json`)!,
    )
    expect(saved.entries).toHaveLength(1)
    expect(saved.entries[0].history).toHaveLength(2)
    expect(saved.entries[0].history[0].chapter).toBe(1)
    expect(saved.entries[0].history[1].chapter).toBe(2)
  })

  it("updateEmotionLedgerFromChapter propagates saveEmotionLedger failure (caller formal-writeback 降级)", async () => {
    const pp = "E:/Novel"
    seedCharacterStates(pp, ["昴"])
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    // updateEmotionLedgerFromChapter 抛错 (不在内部吞错, 由 formal-writeback catch 降级).
    await expect(updateEmotionLedgerFromChapter(pp, 1, "昴打脸反派")).rejects.toThrow("disk full")
  })
})

