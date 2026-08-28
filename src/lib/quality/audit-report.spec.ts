/**
 * audit-report.spec.ts — v2.7.0 审计报告验收
 *
 * 覆盖：证据链完整（哈希/模型/门控明细）/ 100% 出报告
 */
import { describe, expect, it } from "vitest"
import { buildAuditReport } from "./audit-report"

describe("审计报告 — 可追溯证据链", () => {
  it("每章有哈希/模型/门控明细 → 100% 完整", () => {
    const r = buildAuditReport([
      { chapterId: "c1", verdict: "pass", gateDetail: "p0 ok; p1 ok; p2 9.0", buildHash: "h1", modelId: "m1", closedBy: "auto" },
      { chapterId: "c2", verdict: "pass", gateDetail: "p0 ok; p1 ok; p2 9.2", buildHash: "h1", modelId: "m1", closedBy: "auto" },
    ])
    expect(r.completeness).toBe(1)
    expect(r.complete).toBe(true)
  })

  it("缺哈希 → 报告不完整（可追溯性失败）", () => {
    const r = buildAuditReport([
      { chapterId: "c1", verdict: "pass", gateDetail: "p0 ok", buildHash: "", modelId: "m1", closedBy: "auto" },
    ])
    expect(r.completeness).toBe(0)
    expect(r.complete).toBe(false)
  })
})
