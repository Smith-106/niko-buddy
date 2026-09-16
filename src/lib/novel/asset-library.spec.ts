/**
 * asset-library.spec.ts — 波1 五库 EB-2 投影契约 spec 锁定.
 *
 * 覆盖: 五 schema 校验（含推进模式复用 director-modes 不复制第二真源）+
 * 确定性 contentHash（同输入恒同/条目序变化即变）+ 守恒校验（篡改即失配检出）+
 * 只读守卫（产物/条目冻结）+ kb-health（world_sample 无约束不合格/跨书混载违规）+
 * stableStringify 键序确定性.
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  AssetLibraryError,
  assertArtifactImmutable,
  buildLibraryArtifact,
  computeLibraryHash,
  probeLibraryHealth,
  stableStringify,
  verifyLibraryConservation,
  type WorldSampleEntry,
} from "./asset-library"
import { normalizeAdvanceMode } from "./director-modes"

describe("stableStringify / computeLibraryHash（确定性基座）", () => {
  it("键排序稳定：键序不同同值同串", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ a: [1, { c: 2, b: 3 }] })).toBe('{"a":[1,{"b":3,"c":2}]}')
  })

  it("hash 确定性：同输入恒同；异输入异", () => {
    expect(computeLibraryHash("x")).toBe(computeLibraryHash("x"))
    expect(computeLibraryHash("x")).not.toBe(computeLibraryHash("y"))
    expect(computeLibraryHash("x")).toMatch(/^lib-fnv1a-[0-9a-f]{8}-len\d+$/)
  })
})

describe("buildLibraryArtifact（生成器出口）", () => {
  it("条目校验 + 确定性 hash + 产物与条目冻结", () => {
    const entries = [
      { entryId: "g-1", name: "都市异能", toneTags: ["爽感"], forbidPatterns: ["眼中闪过一丝精光"], plotBeats: [] },
    ]
    const a = buildLibraryArtifact({
      libraryId: "genre_base",
      generatorVersion: "gen-1",
      generatedAt: "2026-09-12T00:00:00.000Z",
      entries,
    })
    expect(a.schemaVersion).toBe("asset-library/1.0")
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.entries[0])).toBe(true)
    expect((a.entries[0] as (typeof entries)[number]).toneTags).toEqual(["爽感"])
    // 确定性重建：同 entries 同 hash
    const again = buildLibraryArtifact({
      libraryId: "genre_base",
      generatorVersion: "gen-1",
      generatedAt: "2026-09-13T00:00:00.000Z",
      entries,
    })
    expect(again.contentHash).toBe(a.contentHash)
    expect(again.contentHash).not.toBe(computeLibraryHash(`${a.libraryId}:${stableStringify([])}`))
  })

  it("条目顺序变化 → hash 变化（守恒口径=含序指纹）", () => {
    const e1 = { entryId: "g-1", name: "A", toneTags: [], forbidPatterns: [], plotBeats: [] }
    const e2 = { entryId: "g-2", name: "B", toneTags: [], forbidPatterns: [], plotBeats: [] }
    const h12 = buildLibraryArtifact({ libraryId: "genre_base", generatorVersion: "g", generatedAt: "t", entries: [e1, e2] })
    const h21 = buildLibraryArtifact({ libraryId: "genre_base", generatorVersion: "g", generatedAt: "t", entries: [e2, e1] })
    expect(h12.contentHash).not.toBe(h21.contentHash)
  })

  it("schema 违反拒绝（非法库条目）", () => {
    expect(() =>
      buildLibraryArtifact({
        libraryId: "title_seed",
        generatorVersion: "g",
        generatedAt: "t",
        entries: [{ entryId: "", pattern: "p", constraints: [], examples: [] } as never],
      }),
    ).toThrow(AssetLibraryError)
  })

  it("推进模式库条目走 director-modes 契约（非法门引用被拒）", () => {
    const rogue = { modeId: "m", displayName: "M", phases: [{ key: "p", name: "P", entryGates: ["ghost_gate"], exitGates: [], artifacts: [] }] }
    expect(() => normalizeAdvanceMode(rogue)).toThrow(/AdvanceMode 契约违反|Invalid input/)
  })
})

describe("守恒 / 只读守卫 / kb-health（EB-2 核心）", () => {
  const worldSample: WorldSampleEntry = {
    entryId: "ws-1",
    sourceRef: "拆书-章节3",
    transferableConstraints: ["主角左利手"],
    softConstraints: ["城市多雨"],
    sceneSeeds: [],
  }

  it("守恒：重建 hash 与产物一致；篡改条目即失配", () => {
    const a = buildLibraryArtifact({
      libraryId: "world_sample",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [worldSample],
    })
    expect(verifyLibraryConservation(a).conserved).toBe(true)
    const tampered = { ...a, entries: [{ ...worldSample, transferableConstraints: ["被手改"] }] }
    expect(verifyLibraryConservation(tampered as typeof a).conserved).toBe(false)
  })

  it("只读守卫：冻结产物通过；未冻结产物抛错", () => {
    const a = buildLibraryArtifact({
      libraryId: "genre_base",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [{ entryId: "g", name: "n", toneTags: [], forbidPatterns: [], plotBeats: [] }],
    })
    expect(() => assertArtifactImmutable(a)).not.toThrow()
    const thawed = { ...a, entries: [...a.entries] }
    expect(() => assertArtifactImmutable(thawed as typeof a)).toThrow(AssetLibraryError)
  })

  it("kb-health：world_sample 无 transferableConstraints = 不合格", () => {
    const a = buildLibraryArtifact({
      libraryId: "world_sample",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [{ entryId: "ws-0", sourceRef: "s", transferableConstraints: [], softConstraints: [], sceneSeeds: [] }],
    })
    const report = probeLibraryHealth(a)
    expect(report.healthy).toBe(false)
    expect(report.violations.some((v) => v.includes("transferableConstraints"))).toBe(true)
  })

  it("kb-health：跨书混载违规；单 projectId 或无 projectId 健康", () => {
    const mixed = buildLibraryArtifact({
      libraryId: "character_archetype",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [
        { entryId: "c-1", archetype: "影子", projectId: "book-a", auraSeeds: [] },
        { entryId: "c-2", archetype: "导师", projectId: "book-b", auraSeeds: [] },
      ],
    })
    const mixedReport = probeLibraryHealth(mixed)
    expect(mixedReport.healthy).toBe(false)
    expect(mixedReport.violations.some((v) => v.includes("跨书混载"))).toBe(true)

    const clean = buildLibraryArtifact({
      libraryId: "character_archetype",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [
        { entryId: "c-1", archetype: "影子", projectId: "book-a", auraSeeds: [] },
        { entryId: "c-2", archetype: "门客", projectId: "book-a", auraSeeds: [] },
      ],
    })
    expect(probeLibraryHealth(clean).healthy).toBe(true)
  })
})