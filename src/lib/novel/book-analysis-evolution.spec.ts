/**
 * book-analysis-evolution.spec — 波2-B 模块 8 拆书形象演变→aura 单向闭环测试。
 * 覆盖：锚点确定性排序合成 / 血缘内嵌 @ch / 与既有种子去重 / 容量截断 /
 * apply 返回新条目且输入不可变（单向闭环）/ 产物守恒可审计 / kb-rebuild 事件。
 */
import { describe, expect, it } from "vitest"
import {
  CHARACTER_ARCHETYPE_ENTRY_SCHEMA,
  buildLibraryArtifact,
  verifyLibraryConservation,
  type CharacterArchetypeEntry,
} from "./asset-library"
import {
  applyAuraSeedsToArchetype,
  evolutionAuraEvents,
  evolutionToAuraSeeds,
  IMAGE_EVOLUTION_TIMELINE_SCHEMA,
  type ImageEvolutionTimeline,
} from "./book-analysis-evolution"
import { appendRunEventsToStore, loadRunEventLedgerStore, type RunEventLedgerStoreDeps } from "./run-event-ledger-store"
import { sliceRunEvents } from "./run-event-ledger"

function timeline(input: { characterKey?: string; anchors?: ImageEvolutionTimeline["anchors"] }): ImageEvolutionTimeline {
  return IMAGE_EVOLUTION_TIMELINE_SCHEMA.parse({
    characterKey: input.characterKey ?? "lk-1",
    anchors: input.anchors ?? [{ chapterId: 1, anchorText: "她收起左手的短刃" }],
  })
}

const TS = "2026-09-16T00:00:00.000Z"

function archetype(): CharacterArchetypeEntry {
  return CHARACTER_ARCHETYPE_ENTRY_SCHEMA.parse({
    entryId: "arch-1",
    archetype: "冷面剑客",
    auraSeeds: [],
  })
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

describe("evolutionToAuraSeeds（单向合成）", () => {
  it("乱序锚点 → 确定性排序合成；种子内嵌血缘 @ch", () => {
    const s = evolutionToAuraSeeds({
      timeline: timeline({
        anchors: [
          { chapterId: 3, anchorText: "她烧掉了过去的名字" },
          { chapterId: 1, anchorText: "她收起左手的短刃" },
          { chapterId: 2, anchorText: "她学会沉默" },
        ],
      }),
    })
    expect(s.seeds).toEqual(["她收起左手的短刃@ch1", "她学会沉默@ch2", "她烧掉了过去的名字@ch3"])
    expect(s.lineage.map((l) => l.chapterId)).toEqual([1, 2, 3])
    expect(s.truncatedAnchors).toBe(0)
    expect(s.seedsAdded).toBe(3)
  })

  it("与既有种子去重（同种子不计入新增）", () => {
    const s = evolutionToAuraSeeds({
      timeline: timeline({
        anchors: [
          { chapterId: 1, anchorText: "她收起左手的短刃" },
          { chapterId: 2, anchorText: "她学会沉默" },
        ],
      }),
      existingSeeds: ["她收起左手的短刃@ch1"],
    })
    expect(s.seeds).toEqual(["她学会沉默@ch2"])
    expect(s.seedsAdded).toBe(1)
  })

  it("容量截断：maxSeeds=2 → 溢出锚点确定性丢弃并计数", () => {
    const s = evolutionToAuraSeeds({
      timeline: timeline({
        anchors: [
          { chapterId: 1, anchorText: "a" },
          { chapterId: 2, anchorText: "b" },
          { chapterId: 3, anchorText: "c" },
        ],
      }),
      maxSeeds: 2,
    })
    expect(s.seeds).toEqual(["a@ch1", "b@ch2"])
    expect(s.truncatedAnchors).toBe(1)
  })

  it("schema 违反（空锚点序列）拒绝；maxSeeds 越界拒绝", () => {
    expect(() => evolutionToAuraSeeds({ timeline: timeline({ anchors: [] }) })).toThrow()
    expect(() =>
      evolutionToAuraSeeds({ timeline: timeline({}), maxSeeds: 33 }),
    ).toThrow(/maxSeeds 越界/)
  })
})

describe("applyAuraSeedsToArchetype（单向闭环机械面）", () => {
  it("返回新条目并入种子；输入条目不变（单向：timeline→seeds 只此方向）", () => {
    const entry = archetype()
    const snapshot = JSON.parse(JSON.stringify(entry))
    const s = evolutionToAuraSeeds({
      timeline: timeline({ anchors: [{ chapterId: 1, anchorText: "她收起左手的短刃" }] }),
    })
    const next = applyAuraSeedsToArchetype(entry, s)
    expect(next.auraSeeds).toEqual(["她收起左手的短刃@ch1"])
    expect(JSON.parse(JSON.stringify(entry))).toEqual(snapshot)
    // 单向断言：调用后输入条目未获得任何 timeline 反向引用（无回写通道）
    expect((next as unknown as Record<string, unknown>).anchors).toBeUndefined()
    expect((entry as unknown as Record<string, unknown>).anchors).toBeUndefined()
  })

  it("溢出 fail-loud：既有 32 种子满容量再并入 → 拒绝（不静默丢种子）", () => {
    const entry = CHARACTER_ARCHETYPE_ENTRY_SCHEMA.parse({
      entryId: "arch-full",
      archetype: "x",
      auraSeeds: Array.from({ length: 32 }, (_, i) => `旧种子${i}@ch0`),
    })
    const s = evolutionToAuraSeeds({
      timeline: timeline({ anchors: [{ chapterId: 1, anchorText: "新种子" }] }),
      existingSeeds: entry.auraSeeds,
    })
    // 合成期容量纪律：existing 32 已满 → 合成不产出新种子（截断计数=1）
    expect(s.seeds).toHaveLength(0)
    expect(s.truncatedAnchors).toBe(1)
    // 绕过合成纪律直灌 → apply 端 fail-loud（不静默丢）
    expect(() =>
      applyAuraSeedsToArchetype(entry, { seeds: ["新种子@ch1"], lineage: [], truncatedAnchors: 0, seedsAdded: 1 }),
    ).toThrow(/越界/)
  })

  it("并入后条目可经 buildLibraryArtifact 重建产物且守恒（角色库投影可审计）", () => {
    const entry = archetype()
    const s = evolutionToAuraSeeds({
      timeline: timeline({ anchors: [{ chapterId: 4, anchorText: "她烧掉了过去的名字" }] }),
    })
    const next = applyAuraSeedsToArchetype(entry, s)
    const artifact = buildLibraryArtifact({
      libraryId: "character_archetype",
      generatorVersion: "book-analysis-evolution/1.0",
      generatedAt: TS,
      entries: [next],
    })
    expect(verifyLibraryConservation(artifact).conserved).toBe(true)
    expect(artifact.entries[0]).toMatchObject({ auraSeeds: ["她烧掉了过去的名字@ch4"] })
  })
})

describe("evolutionAuraEvents（kb 产物更新事件落账）", () => {
  it("kind=kb-rebuild；evidenceRefs 逐条血缘可点开；store 落账可切片", async () => {
    const timelineIn = timeline({
      anchors: [
        { chapterId: 1, anchorText: "她收起左手的短刃" },
        { chapterId: 2, anchorText: "她学会沉默" },
      ],
    })
    const s = evolutionToAuraSeeds({ timeline: timelineIn })
    const events = evolutionAuraEvents({ timeline: timelineIn, synthesis: s, ts: TS })
    expect(events[0]?.kind).toBe("kb-rebuild")
    expect(events[0]?.evidenceRefs).toEqual(["aura-seed:lk-1@ch1", "aura-seed:lk-1@ch2"])

    const deps = memoryDeps()
    await appendRunEventsToStore(deps, "C:/proj/ev", events)
    const ledger = await loadRunEventLedgerStore(deps, "C:/proj/ev")
    const slice = sliceRunEvents(ledger, { kind: "kb-rebuild" })
    expect(slice).toHaveLength(1)
    expect((slice[0]?.payload as { characterKey?: string }).characterKey).toBe("lk-1")
    expect((slice[0]?.payload as { seedsAdded?: number }).seedsAdded).toBe(2)
  })

  it("空 ts 拒绝（零时钟纪律）", () => {
    const timelineIn = timeline({})
    const s = evolutionToAuraSeeds({ timeline: timelineIn })
    expect(() => evolutionAuraEvents({ timeline: timelineIn, synthesis: s, ts: "" })).toThrow(/ts 为空/)
  })
})