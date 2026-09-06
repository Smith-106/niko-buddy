/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收① — trust 分级纯函数 spec。
 *
 * 共识 C-1/C-2/C-3：trust = NormalizeADR ⊕ LicensePolicy = min（GOV-TRUST-01/03）；
 * 派生结果不写回凭证（BND-PRM-08），消费点即时计算；AGPL→blocked 且不进检索
 * （GOV-TRUST-02/05）；未知 license → blocked（保守默认，GOV-TRUST-06）。
 */
import { describe, it, expect } from "vitest"
import {
  normalizeADR,
  licensePolicy,
  synthesizeTrust,
  gradeTrust,
  isRetrievable,
  filterByTrust,
  dispositionOf,
  validateTrustThresholds,
  TRUST_SEED_LOCK,
} from "./trust-grader"

describe("E-06 normalizeADR（GOV-TRUST-01 档位化）", () => {
  it("≥0.8 → full；0.5≤x<0.8 → reference_only；<0.5 → blocked", () => {
    expect(normalizeADR(0.9)).toBe("full")
    expect(normalizeADR(0.8)).toBe("full")
    expect(normalizeADR(0.79)).toBe("reference_only")
    expect(normalizeADR(0.5)).toBe("reference_only")
    expect(normalizeADR(0.49)).toBe("blocked")
    expect(normalizeADR(0)).toBe("blocked")
  })

  it("非法入参（NaN/越界）→ throw（不静默降级）", () => {
    expect(() => normalizeADR(NaN)).toThrow()
    expect(() => normalizeADR(1.5)).toThrow()
    expect(() => normalizeADR(-0.1)).toThrow()
  })

  it("阈值可配置（zod 校验，GOV-TRUST-04）", () => {
    const custom = validateTrustThresholds({ adrFullMin: 0.9, adrReferenceMin: 0.6 })
    expect(normalizeADR(0.85, custom)).toBe("reference_only")
    expect(normalizeADR(0.95, custom)).toBe("full")
    // strict：拒绝未知键
    expect(() => validateTrustThresholds({ adrFullMin: 0.8, adrReferenceMin: 0.5, extra: 1 })).toThrow()
    expect(TRUST_SEED_LOCK).toBe("trust-thresholds-v1")
  })
})

describe("E-06 licensePolicy（GOV-TRUST-02 查表）", () => {
  it("CC-BY/公共领域 → full", () => {
    expect(licensePolicy("CC-BY")).toBe("full")
    expect(licensePolicy("CC0")).toBe("full")
    expect(licensePolicy("public-domain")).toBe("full")
  })

  it("MIT/Apache → reference_only", () => {
    expect(licensePolicy("MIT")).toBe("reference_only")
    expect(licensePolicy("Apache-2.0")).toBe("reference_only")
  })

  it("AGPL/GPL → blocked（仅模式借鉴，铁律③）", () => {
    expect(licensePolicy("AGPL-3.0")).toBe("blocked")
    expect(licensePolicy("GPL-3.0")).toBe("blocked")
    expect(licensePolicy("GPL-2.0")).toBe("blocked")
  })

  it("未知/未声明 → blocked（保守默认，GOV-TRUST-06）", () => {
    expect(licensePolicy("unknown")).toBe("blocked")
    expect(licensePolicy("")).toBe("blocked")
    expect(licensePolicy("  ")).toBe("blocked")
    expect(licensePolicy("Proprietary")).toBe("blocked")
  })
})

describe("E-06 synthesizeTrust（GOV-TRUST-03 min 语义）", () => {
  it("min 合成：full⊕reference_only=reference_only；reference_only⊕blocked=blocked", () => {
    expect(synthesizeTrust("full", "full")).toBe("full")
    expect(synthesizeTrust("full", "reference_only")).toBe("reference_only")
    expect(synthesizeTrust("reference_only", "full")).toBe("reference_only")
    expect(synthesizeTrust("reference_only", "blocked")).toBe("blocked")
    expect(synthesizeTrust("blocked", "full")).toBe("blocked")
  })
})

describe("E-06 gradeTrust 表驱动（验收①：已知 (adr, license) → 期望档）", () => {
  it("全组合真值表", () => {
    expect(gradeTrust({ adrScore: 0.9, license: "CC-BY" }).grade).toBe("full")
    expect(gradeTrust({ adrScore: 0.9, license: "AGPL-3.0" }).grade).toBe("blocked")
    expect(gradeTrust({ adrScore: 0.2, license: "CC-BY" }).grade).toBe("blocked")
    expect(gradeTrust({ adrScore: 0.9, license: "unknown" }).grade).toBe("blocked")
    expect(gradeTrust({ adrScore: 0.6, license: "MIT" }).grade).toBe("reference_only")
    expect(gradeTrust({ adrScore: 0.6, license: "AGPL-3.0" }).grade).toBe("blocked")
    expect(gradeTrust({ adrScore: 0.9, license: "Apache-2.0" }).grade).toBe("reference_only")
  })

  it("AGPL→blocked 且 isRetrievable=false（GOV-TRUST-05）", () => {
    const { grade } = gradeTrust({ adrScore: 0.95, license: "AGPL-3.0" })
    expect(grade).toBe("blocked")
    expect(isRetrievable(grade)).toBe(false)
    expect(dispositionOf(grade)).toBe("quarantine")
  })

  it("full 档 isRetrievable=true；dispositionOf 正常", () => {
    expect(isRetrievable("full")).toBe(true)
    expect(isRetrievable("reference_only")).toBe(true)
    expect(dispositionOf("full")).toBe("normal")
  })
})

describe("E-06 filterByTrust（blocked 不进检索视图）", () => {
  it("剔除 blocked 条目，保留 full/reference_only/无 trust 字段条目", () => {
    const items = [
      { path: "a", trust: "full" as const },
      { path: "b", trust: "blocked" as const },
      { path: "c", trust: "reference_only" as const },
      { path: "d" },
    ]
    const filtered = filterByTrust(items)
    expect(filtered.map((i) => i.path)).toEqual(["a", "c", "d"])
  })
})

describe("P1-IMP-06 buildTrustGradeMap + trustKeyOfPath", () => {
  it("tech 条目零入表（K-11 安全不变量）", async () => {
    const { buildTrustGradeMap } = await import("./trust-grader")
    const map = buildTrustGradeMap({
      collections: {
        tech: [{ collection: "tech", name: "leak", trust: "full" }],
        craft: [{ collection: "craft", name: "ok", trust: "reference_only" }],
      },
    })
    expect(map["tech/leak"]).toBeUndefined()
    expect(map["leak"]).toBeUndefined()
    expect(map["craft/ok"]).toBe("reference_only")
  })

  it("键双写 collection/name 与 name；歧义保留首遇不静默覆盖", async () => {
    const { buildTrustGradeMap } = await import("./trust-grader")
    const map = buildTrustGradeMap({
      collections: {
        craft: [{ collection: "craft", name: "X", trust: "full" }],
        lexicon: [{ collection: "lexicon", name: "X", trust: "reference_only" }],
      },
    })
    expect(map["craft/x"]).toBe("full")
    expect(map["lexicon/x"]).toBe("reference_only")
    // name 单键保留首遇
    expect(map["x"]).toBe("full")
  })

  it("trustKeyOfPath 归一化（反斜杠/前导点/大小写）", async () => {
    const { trustKeyOfPath } = await import("./trust-grader")
    expect(trustKeyOfPath(".\\Craft\\X.md")).toBe("craft/x.md")
    expect(trustKeyOfPath("./Lexicon/Y.json")).toBe("lexicon/y.json")
  })
})
