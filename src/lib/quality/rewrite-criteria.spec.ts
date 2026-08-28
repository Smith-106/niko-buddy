/**
 * rewrite-criteria.spec.ts — v2.6.8 D5 验收
 *
 * 覆盖：复合触发 / P0 短路 / 二分类 / 快照恢复
 */
import { describe, expect, it } from "vitest"
import { classifyRewrite, evaluateRewriteCriteria, verifySnapshotRestore } from "./rewrite-criteria"

describe("D5 改写判据 — 复合触发（非单维阈值）", () => {
  it("三软维≥2 触地板 且 中位<9.0 → 触发改写", () => {
    const r = evaluateRewriteCriteria({ softBreached: ["thril", "pacing"], overallMedian: 8.8, p0Failed: false })
    expect(r.shouldRewrite).toBe(true)
  })

  it("仅 1 软维触地板 → 不触发（非单维阈值）", () => {
    const r = evaluateRewriteCriteria({ softBreached: ["thril"], overallMedian: 8.8, p0Failed: false })
    expect(r.shouldRewrite).toBe(false)
  })

  it("中位≥9.0 → 不触发", () => {
    const r = evaluateRewriteCriteria({ softBreached: ["thril", "pacing", "pull"], overallMedian: 9.1, p0Failed: false })
    expect(r.shouldRewrite).toBe(false)
  })
})

describe("D5 改写判据 — P0 失败短路（Quality 不得覆盖 Consistency）", () => {
  it("P0 失败 → 改写被抑制（即使软维全触地板）", () => {
    const r = evaluateRewriteCriteria({ softBreached: ["thril", "pacing", "pull"], overallMedian: 8.0, p0Failed: true })
    expect(r.shouldRewrite).toBe(false)
    expect(r.reason).toContain("P0 失败短路")
  })
})

describe("D5 改写判据 — 可回滚/不可回滚二分类 + 快照锚点", () => {
  it("触锚点（人名/设定/因果）= 语义不可逆 + 需快照", () => {
    const r = classifyRewrite({ description: "改名", touchesAnchor: true, anchorType: "character_name" })
    expect(r.klass).toBe("irreversible")
    expect(r.needsSnapshot).toBe(true)
  })

  it("不触锚点 = 可回滚", () => {
    const r = classifyRewrite({ description: "调整句式", touchesAnchor: false })
    expect(r.klass).toBe("reversible")
    expect(r.needsSnapshot).toBe(false)
  })

  it("快照恢复校验：恢复后与改前一致", () => {
    expect(verifySnapshotRestore({ anchorType: "character_name", before: "阿明", after: "阿亮" }, "阿明")).toBe(true)
    expect(verifySnapshotRestore({ anchorType: "character_name", before: "阿明", after: "阿亮" }, "阿亮")).toBe(false)
  })
})
