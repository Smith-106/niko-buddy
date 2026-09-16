/**
 * aura-homogenization.spec — 波2-C 同质化量化告警 + 声音漂移按章统计测试。
 * 覆盖：shingle Jaccard / 同质化角色对告警（阈值+排序+sharedSeeds）/
 * 无种子跳过 / 告警事件落账（可点开 evidenceRefs）/ 声音漂移按章升序 +
 * 阈值告警 + 空 seeds null 不臆造 / 非法阈值拒绝。
 */
import { describe, expect, it } from "vitest"
import { CHARACTER_ARCHETYPE_ENTRY_SCHEMA, type CharacterArchetypeEntry } from "./asset-library"
import {
  computeVoiceDrift,
  detectAuraHomogenization,
  homogenizationAlertEvents,
  jaccardSimilarity,
  voiceDriftAlertEvents,
} from "./aura-homogenization"
import { appendRunEventsToStore, loadRunEventLedgerStore, type RunEventLedgerStoreDeps } from "./run-event-ledger-store"
import { sliceRunEvents } from "./run-event-ledger"

const TS = "2026-09-16T00:00:00.000Z"

function archetype(entryId: string, auraSeeds: string[]): CharacterArchetypeEntry {
  return CHARACTER_ARCHETYPE_ENTRY_SCHEMA.parse({ entryId, archetype: `原型-${entryId}`, auraSeeds })
}

function memoryDeps(): RunEventLedgerStoreDeps {
  const files = new Map<string, string>()
  return {
    readText: async (path) => files.get(path) ?? null,
    appendText: async (path, text) => {
      files.set(path, (files.get(path) ?? "") + text)
    },
  }
}

describe("jaccardSimilarity（机械相似度）", () => {
  it("相同文本 = 1；无关文本趋低；空集 → null 不臆造", () => {
    const a = new Set(["ab", "bc"])
    expect(jaccardSimilarity(a, new Set(["ab", "bc"]))).toBe(1)
    expect(jaccardSimilarity(a, new Set(["de", "ef"]))).toBe(0)
    expect(jaccardSimilarity(new Set(), a)).toBeNull()
  })
})

describe("detectAuraHomogenization（同质化角色对告警）", () => {
  it("种子高度重叠的角色对 → 告警含相似度与 sharedSeeds（来源对可追溯）", () => {
    const alerts = detectAuraHomogenization(
      [
        archetype("arch-a", ["左手持刃的沉默剑客", "雨夜独行"]),
        archetype("arch-b", ["左手持刃的沉默剑客", "雨夜独行"]),
        archetype("arch-c", ["机械义肢的爆破手", "赌场清账人"]),
      ],
      0.5,
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ entryIdA: "arch-a", entryIdB: "arch-b", similarity: 1 })
    expect(alerts[0]?.sharedSeeds).toHaveLength(2)
  })

  it("低于阈值不告警；阈值可调；排序按相似度降序", () => {
    const entries = [
      archetype("arch-a", ["沉默的左手剑客雨夜独行"]),
      archetype("arch-b", ["沉默的左手剑客雨夜独行"]),
      archetype("arch-c", ["完全不同的爆破狂人赌徒"]),
      archetype("arch-d", ["完全不同的爆破狂人赌徒"]),
    ]
    expect(detectAuraHomogenization(entries, 0.9)).toHaveLength(2)
    const alerts = detectAuraHomogenization(entries, 0.99)
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.similarity).toBeGreaterThanOrEqual(alerts[1]?.similarity ?? 0)
    expect(alerts[0]?.entryIdA).toBe("arch-a")
  })

  it("无种子条目跳过；空输入空告警；阈值越界拒绝", () => {
    const alerts = detectAuraHomogenization([archetype("arch-a", []), archetype("arch-b", ["x"])])
    expect(alerts).toHaveLength(0)
    expect(detectAuraHomogenization([], 0.5)).toHaveLength(0)
    expect(() => detectAuraHomogenization([], 1.5)).toThrow(/threshold 越界/)
  })
})

describe("homogenizationAlertEvents（告警事件落账）", () => {
  it("kind=stage + payload.alert 标记；evidenceRefs 双方 entryId 可点开", async () => {
    const alerts = detectAuraHomogenization(
      [archetype("arch-a", ["沉默剑客"]), archetype("arch-b", ["沉默剑客"])],
      0.5,
    )
    const events = homogenizationAlertEvents({ alerts, ts: TS })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("stage")
    expect((events[0]?.payload as { alert?: string }).alert).toBe("aura-homogenization")
    expect(events[0]?.evidenceRefs).toEqual(["aura:arch-a", "aura:arch-b"])

    const deps = memoryDeps()
    await appendRunEventsToStore(deps, "C:/proj/ah", events)
    const ledger = await loadRunEventLedgerStore(deps, "C:/proj/ah")
    const slice = sliceRunEvents(ledger, { kind: "stage" })
    expect(slice).toHaveLength(1)
    expect((slice[0]?.payload as { pairs?: unknown[] }).pairs).toHaveLength(1)
  })

  it("无告警 → 零事件（零候选是合法结果，不制造噪声）；空 ts 拒绝", () => {
    expect(homogenizationAlertEvents({ alerts: [], ts: TS })).toHaveLength(0)
    expect(() => homogenizationAlertEvents({ alerts: [], ts: "" })).toThrow(/ts 为空/)
  })
})

describe("computeVoiceDrift（声音漂移按章统计）", () => {
  it("按章升序；与基线漂移量化；超阈值章标记 alert", () => {
    const series = computeVoiceDrift(
      [
        { chapterId: 3, voiceSeeds: ["完全陌生的冷峻旁白腔调"] },
        { chapterId: 1, voiceSeeds: ["短句急促的对白节奏", "雨声反复出现的意象"] },
        { chapterId: 2, voiceSeeds: ["短句急促的对白节奏", "雨声反复出现的意象"] },
      ],
      ["短句急促的对白节奏", "雨声反复出现的意象"],
      0.6,
    )
    expect(series.map((s) => s.chapterId)).toEqual([1, 2, 3])
    expect(series[0]?.drift).toBe(0)
    expect(series[2]?.drift).toBe(1)
    expect(series[2]?.alert).toBe(true)
    expect(series[0]?.alert).toBe(false)
  })

  it("空 voiceSeeds → null 不臆造；告警事件按告警章落账（bookId 透传）", async () => {
    const series = computeVoiceDrift(
      [
        { chapterId: 1, voiceSeeds: [] },
        { chapterId: 2, voiceSeeds: ["短句急促的对白节奏"] },
      ],
      ["完全不同的基线声音"],
      0.6,
    )
    expect(series[0]?.similarity).toBeNull()
    expect(series[0]?.drift).toBeNull()
    expect(series[0]?.alert).toBe(false)

    const events = voiceDriftAlertEvents({ series, ts: TS, bookId: "book-a" })
    expect(events).toHaveLength(1)
    expect(events[0]?.chapterId).toBe(2)
    expect(events[0]?.bookId).toBe("book-a")
    const deps = memoryDeps()
    await appendRunEventsToStore(deps, "C:/proj/vd", events)
    const ledger = await loadRunEventLedgerStore(deps, "C:/proj/vd")
    const slice = sliceRunEvents(ledger, { kind: "stage", bookId: "book-a", chapterId: 2 })
    expect(slice).toHaveLength(1)
    expect((slice[0]?.payload as { alert?: string }).alert).toBe("voice-drift")
  })

  it("阈值越界拒绝；空 ts 拒绝", () => {
    expect(() => computeVoiceDrift([], [], 1.5)).toThrow(/threshold 越界/)
    const series = computeVoiceDrift([{ chapterId: 1, voiceSeeds: ["x"] }], ["x"])
    expect(() => voiceDriftAlertEvents({ series, ts: "" })).toThrow(/ts 为空/)
  })
})