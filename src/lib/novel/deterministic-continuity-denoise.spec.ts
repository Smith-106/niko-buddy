/**
 * deterministic-continuity-denoise.spec.ts — 三段式去噪链直接覆盖
 *（20261105-ralph-coverage-100 分支专项：此前仅经
 * deterministic-continuity-engine.spec.ts 间接覆盖；本文件补齐
 * merge/suppress 的 enabled=false、config 缺省回退、evidence 合并、
 * 低 severity dup 抑制、knowledge 遮蔽抑制等分支。）
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_DENOISE_CONFIG,
  denoiseContinuityFindings,
  fillCanonicalFamily,
  mergeContinuityFindings,
  suppressContinuityFindings,
} from "./deterministic-continuity-denoise"
import type {
  ContinuityFinding,
  ContinuityFindingType,
  ContinuitySeverity,
} from "./deterministic-continuity-engine"

function mk(
  type: ContinuityFindingType,
  ref: string,
  chapter: number,
  severity: ContinuitySeverity = "warning",
  extra: Partial<{ message: string; evidence: string }> = {},
): ContinuityFinding {
  return {
    type,
    subtype: "consistency_mechanical",
    severity,
    ref,
    message: extra.message ?? `${type}@${ref}#${chapter}`,
    chapter,
    ...(extra.evidence !== undefined ? { evidence: extra.evidence } : {}),
  }
}

describe("mergeContinuityFindings — config/evidence 分支", () => {
  it("enabled=false → 原样返回（不合并）", () => {
    const findings = fillCanonicalFamily([
      mk("timeline_drift", "character:A", 1, "info"),
      mk("timeline_drift", "character:A", 2, "warning"),
    ])
    const out = mergeContinuityFindings(findings, { ...DEFAULT_DENOISE_CONFIG, enabled: false })
    expect(out).toHaveLength(2)
    expect(out[0]!.message).not.toContain("合并")
    expect(out).not.toBe(findings)
  })

  it("缺 countDriftMaxGap → 回退默认 3（gap=2 合并）", () => {
    const merged = mergeContinuityFindings(
      fillCanonicalFamily([
        mk("set_count_drift", "subplot:队伍", 1),
        mk("set_count_drift", "subplot:队伍", 3),
      ]),
      { enabled: true, maxGap: 6 },
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.message).toContain("合并 2 条")
  })

  it("缺 maxGap → 回退默认 6（gap=5 合并）", () => {
    const merged = mergeContinuityFindings(
      fillCanonicalFamily([
        mk("timeline_drift", "character:A", 1),
        mk("timeline_drift", "character:A", 6),
      ]),
      { enabled: true, countDriftMaxGap: 3 },
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.message).toContain("合并 2 条")
  })

  it("双方都有 evidence → 逗号连接保留", () => {
    const merged = mergeContinuityFindings(
      fillCanonicalFamily([
        mk("timeline_drift", "character:A", 1, "info", { evidence: "E1", message: "M1" }),
        mk("timeline_drift", "character:A", 2, "warning", { evidence: "E2", message: "M2" }),
      ]),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.severity).toBe("warning")
    expect(merged[0]!.evidence).toBe("E1, E2")
    expect(merged[0]!.message).toBe("M1 + M2 (合并 2 条)")
  })

  it("仅后者有 evidence → 采用后者 evidence", () => {
    const merged = mergeContinuityFindings(
      fillCanonicalFamily([
        mk("timeline_drift", "character:A", 1, "info", { message: "M1" }),
        mk("timeline_drift", "character:A", 2, "warning", { evidence: "E2", message: "M2" }),
      ]),
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.evidence).toBe("E2")
  })
})

describe("suppressContinuityFindings — 抑制规则分支", () => {
  it("同键 dup 后来者 severity 更低 → 被抑制（保留 critical）", () => {
    const out = suppressContinuityFindings(
      fillCanonicalFamily([
        mk("timeline_drift", "r1", 1, "critical"),
        mk("timeline_drift", "r1", 1, "warning"),
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.severity).toBe("critical")
  })

  it("knowledge_boundary critical 同 ref 同章 → 遮蔽 lost_item warning", () => {
    const out = suppressContinuityFindings(
      fillCanonicalFamily([
        mk("knowledge_boundary", "character:阿宁", 3, "critical"),
        mk("lost_item", "character:阿宁", 3, "warning"),
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe("knowledge_boundary")
  })

  it("knowledge 遮蔽不跨章：不同章 lost_item 保留", () => {
    const out = suppressContinuityFindings(
      fillCanonicalFamily([
        mk("knowledge_boundary", "character:阿宁", 3, "critical"),
        mk("lost_item", "character:阿宁", 4, "warning"),
      ]),
    )
    expect(out).toHaveLength(2)
  })
})

describe("denoiseContinuityFindings — 链路冒烟", () => {
  it("merge+suppress 链：同 ref 连续 findings 合并且 dup 去重", () => {
    const out = denoiseContinuityFindings([
      mk("timeline_drift", "character:A", 1, "info", { evidence: "E1" }),
      mk("timeline_drift", "character:A", 2, "warning", { evidence: "E2" }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.evidence).toBe("E1, E2")
  })
})
