/**
 * curation-gate.spec — R1-d 策展闸门测试。
 * 覆盖：缺字段/无出处/摘要过短计债、题材空置（collection 粒度）与 collection 空置计债、权重与上限口径、
 * 契约非法 fail-loud、上限断言 fail-loud，以及**真实全字段面**（reference-kb-view.content-*.json 快照）
 * 债分 0（R1-a/R1-b 补料后题材空置归零；expectThemes=[{克苏鲁@world_ref},{修仙@world_ref,lexicon}]）。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  CURATION_DEBT_CAP,
  CURATION_DEBT_WEIGHTS,
  CURATION_MIN_SUMMARY_CHARS,
  CURATION_REQUIRED_FIELDS,
  CurationGateError,
  assertCurationDebtWithinCap,
  scoreCurationBatch,
  type CurationBatch,
} from "./curation-gate"
import kbRoutingView from "./kb/kb-routing-view.generated.json"
import kbContentView from "./__fixtures__/reference-kb-view.content-ec3f9b0e01c912cb.json"

const LONG_SUMMARY = "这是一段足够长的策展摘要，用于验证摘要长度阈值：".repeat(2) + "完。"

function entry(overrides: Record<string, unknown> = {}) {
  return {
    name: "xianxia-world-demo",
    collection: "world_ref",
    title: "修仙世界卡",
    lang: "zh",
    domain: ["修仙"],
    query_intent: ["lookup"],
    trust: "full",
    summary: LONG_SUMMARY,
    contentDigest: "sha256-deadbeef",
    upstream: "UNKNOWN",
    ...overrides,
  }
}

function batch(overrides: Partial<CurationBatch> = {}): CurationBatch {
  return {
    schemaVersion: 1,
    source: "test",
    expectThemes: [{ theme: "修仙", collections: ["world_ref"] }],
    expectCollections: ["world_ref"],
    entries: [entry()],
    ...overrides,
  }
}

describe("R1-d 计债规则（条目级）", () => {
  it("健康条目债分 0（自建 CC0 带 contentDigest 视为有出处）", () => {
    const score = scoreCurationBatch(batch())
    expect(score.totalDebt).toBe(0)
    expect(score.withinCap).toBe(true)
    expect(score.cap).toBe(CURATION_DEBT_CAP)
    expect(score.findings).toEqual([])
  })

  it("缺字段：8 字段中任一缺失即 +2/条，且明细点名", () => {
    const score = scoreCurationBatch(
      batch({ entries: [entry({ query_intent: undefined }), entry({ name: "e2", trust: "" })] }),
    )
    expect(score.byReason.missing_field).toBe(CURATION_DEBT_WEIGHTS.missing_field * 2)
    expect(score.findings[0]?.detail).toContain("query_intent")
    expect(score.findings[1]?.detail).toContain("trust")
    expect(CURATION_REQUIRED_FIELDS).toHaveLength(8)
  })

  it("无出处：upstream UNKNOWN/空 且无 contentDigest → +1", () => {
    const score = scoreCurationBatch(
      batch({ entries: [entry({ upstream: "", contentDigest: undefined })] }),
    )
    expect(score.byReason.no_provenance).toBe(CURATION_DEBT_WEIGHTS.no_provenance)
    // 有 contentDigest 即免债（自建内容包口径）
    expect(scoreCurationBatch(batch()).byReason.no_provenance).toBe(0)
    // 有 upstream 也免债
    expect(
      scoreCurationBatch(batch({ entries: [entry({ upstream: "org/repo", contentDigest: undefined })] }))
        .byReason.no_provenance,
    ).toBe(0)
  })

  it("摘要过短：< 50 字 → +1（空摘要不重复计债，由缺失字段覆盖）", () => {
    const short = "太短了。"
    const score = scoreCurationBatch(batch({ entries: [entry({ summary: short })] }))
    expect(score.byReason.short_summary).toBe(CURATION_DEBT_WEIGHTS.short_summary)
    expect(score.findings[0]?.detail).toContain(String(CURATION_MIN_SUMMARY_CHARS))
    expect(
      scoreCurationBatch(batch({ entries: [entry({ summary: "" })] })).byReason.short_summary,
    ).toBe(0)
  })

  it("多债并发：单条可同时计缺字段+无出处+摘要过短", () => {
    const score = scoreCurationBatch(
      batch({ entries: [entry({ lang: undefined, upstream: "UNKNOWN", contentDigest: undefined, summary: "短。" })] }),
    )
    expect(score.totalDebt).toBe(
      CURATION_DEBT_WEIGHTS.missing_field +
        CURATION_DEBT_WEIGHTS.no_provenance +
        CURATION_DEBT_WEIGHTS.short_summary,
    )
  })
})

describe("R1-d 计债规则（集合级：题材空置 / collection 空置）", () => {
  it("题材空置：题材在声明的 collection 内零命中 → +3（按 collection 粒度）", () => {
    const score = scoreCurationBatch(
      batch({
        expectThemes: [
          { theme: "克苏鲁", collections: ["world_ref"] },
          { theme: "修仙", collections: ["world_ref"] },
        ],
      }),
    )
    expect(score.byReason.theme_vacant).toBe(CURATION_DEBT_WEIGHTS.theme_vacant)
    expect(score.findings.some((f) => f.target === "克苏鲁@world_ref")).toBe(true)
    expect(score.findings.some((f) => f.target === "修仙@world_ref")).toBe(false)
  })

  it("题材空置按 collection 粒度：lexicon 覆盖不等于 world_ref 覆盖（防全局假阴性）", () => {
    const entries = [
      entry({
        name: "xianxia-term-linggen",
        collection: "lexicon",
        title: "灵根与资质",
        domain: ["修仙"],
      }),
    ]
    const score = scoreCurationBatch(
      batch({
        expectThemes: [{ theme: "修仙", collections: ["world_ref", "lexicon"] }],
        expectCollections: ["world_ref", "lexicon"],
        entries,
      }),
    )
    // world_ref 空置计债，lexicon 已覆盖免债
    expect(score.byReason.theme_vacant).toBe(CURATION_DEBT_WEIGHTS.theme_vacant)
    expect(
      score.findings.filter((f) => f.reason === "theme_vacant").map((f) => f.target),
    ).toEqual(["修仙@world_ref"])
  })

  it("题材命中面包含 name/title/domain/summary 四者之一即免债", () => {
    const scope = [{ theme: "修仙", collections: ["world_ref"] }]
    expect(scoreCurationBatch(batch({ expectThemes: scope })).byReason.theme_vacant).toBe(0)
    expect(
      scoreCurationBatch(
        batch({
          expectThemes: scope,
          entries: [
            entry({ title: "修仙九州地理", domain: ["地理"], summary: LONG_SUMMARY }),
          ],
        }),
      ).byReason.theme_vacant,
    ).toBe(0)
  })

  it("collection 空置：声明但不含条目 → +3", () => {
    const score = scoreCurationBatch(batch({ expectCollections: ["world_ref", "lexicon"] }))
    expect(score.byReason.collection_vacant).toBe(CURATION_DEBT_WEIGHTS.collection_vacant)
    expect(score.findings.some((f) => f.target === "lexicon")).toBe(true)
  })

  it("空条目批次：collection 空置 + 题材空置均触发", () => {
    const score = scoreCurationBatch(batch({ entries: [] }))
    expect(score.totalDebt).toBe(
      CURATION_DEBT_WEIGHTS.collection_vacant + CURATION_DEBT_WEIGHTS.theme_vacant,
    )
    expect(score.entryCount).toBe(0)
  })
})

describe("R1-d 契约与上限断言", () => {
  it("契约非法 fail-loud（expectThemes 为空 / 题材缺 collections / schemaVersion 错 / 未知字段）", () => {
    expect(() => scoreCurationBatch({ ...batch(), expectThemes: [] })).toThrow(CurationGateError)
    expect(() =>
      scoreCurationBatch({ ...batch(), expectThemes: [{ theme: "修仙", collections: [] }] }),
    ).toThrow(CurationGateError)
    expect(() => scoreCurationBatch({ ...batch(), schemaVersion: 2 as never })).toThrow(
      CurationGateError,
    )
    expect(() => scoreCurationBatch({ ...batch(), extra: 1 } as never)).toThrow(CurationGateError)
  })

  it("超限断言 fail-loud 并列出发现项；未超限静默通过", () => {
    expect(() => assertCurationDebtWithinCap(scoreCurationBatch(batch()))).not.toThrow()
    const dirty = scoreCurationBatch(batch({ entries: [entry({ lang: undefined })] }))
    expect(() => assertCurationDebtWithinCap(dirty)).toThrow(/债分超限/)
    expect(() => assertCurationDebtWithinCap(dirty)).toThrow(/missing_field\+2/)
  })
})

describe("R1-d 真实产物面（生成器管线门禁）", () => {
  const view = kbRoutingView as unknown as {
    builtFrom?: string
    collections?: Record<string, Array<Record<string, unknown>>>
  }
  // 门禁评分面 = 全字段内容面快照（投影面显式排除 summary/contentDigest，不可用于 8 字段计债）
  const content = kbContentView as unknown as {
    builtFrom?: string
    entryCount?: number
    entries: Array<Record<string, unknown>>
  }
  const score = scoreCurationBatch({
    schemaVersion: 1,
    source: `reference-kb-view.content-ec3f9b0e01c912cb.json@${content.builtFrom ?? "unknown"}`,
    expectThemes: [
      { theme: "克苏鲁", collections: ["world_ref"] },
      { theme: "修仙", collections: ["world_ref", "lexicon"] },
    ],
    expectCollections: ["world_ref", "lexicon", "craft", "corpus"],
    entries: content.entries,
  })

  it("现役产物债分 0（无缺字段/无出处/摘要过短/题材空置/collection 空置）", () => {
    expect(score.totalDebt).toBe(0)
    expect(score.withinCap).toBe(true)
    expect(score.findings).toEqual([])
    expect(content.builtFrom).toBe("sha256:ec3f9b0e01c912cb")
    expect(content.entryCount).toBe(80)
    expect(score.entryCount).toBeGreaterThan(70)
  })

  it("快照与投影面同源（builtFrom 一致，条目身份守恒）", () => {
    expect(content.builtFrom).toBe(view.builtFrom)
    const projectedNames = new Set(
      Object.values(view.collections ?? {})
        .flat()
        .map((e) => String(e["name"] ?? "")),
    )
    for (const name of content.entries.map((e) => String(e["name"] ?? ""))) {
      expect(projectedNames.has(name)).toBe(true)
    }
  })

  it("题材覆盖实指：world_ref 内克苏鲁 8 + 修仙世界卡 10；lexicon 内修仙词条 ≥ 44", () => {
    const worldRef = content.entries.filter((e) => e["collection"] === "world_ref")
    expect(worldRef.filter((e) => String(e["name"]).startsWith("cthulhu-")).length).toBe(8)
    expect(worldRef.filter((e) => String(e["name"]).startsWith("xianxia-world-")).length).toBe(10)
    const lexicon = content.entries.filter((e) => e["collection"] === "lexicon")
    expect(
      lexicon.filter((e) => String(e["name"]).startsWith("xianxia-")).length,
    ).toBeGreaterThanOrEqual(44)
  })

  it("闸门可负向触发：抽掉修仙世界卡后 world_ref 题材空置计债（门禁非空转）", () => {
    const withoutXianxia = content.entries.filter(
      (e) => !String(e["name"] ?? "").startsWith("xianxia-world-"),
    )
    const dirty = scoreCurationBatch({
      schemaVersion: 1,
      source: "negative-control",
      expectThemes: [
        { theme: "克苏鲁", collections: ["world_ref"] },
        { theme: "修仙", collections: ["world_ref", "lexicon"] },
      ],
      expectCollections: ["world_ref", "lexicon"],
      entries: withoutXianxia.filter((e) =>
        ["world_ref", "lexicon"].includes(String(e["collection"])),
      ),
    })
    expect(dirty.byReason.theme_vacant).toBe(CURATION_DEBT_WEIGHTS.theme_vacant)
    expect(() => assertCurationDebtWithinCap(dirty)).toThrow(/theme_vacant\+3\] 修仙@world_ref/)
  })
})
