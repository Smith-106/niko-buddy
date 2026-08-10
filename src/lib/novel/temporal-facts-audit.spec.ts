import { describe, expect, it } from "vitest"
import { auditTemporalFactsStatus, temporalEmptySoftGapRef } from "./temporal-facts-audit"

describe("temporal-facts-audit", () => {
  it("disabled → no gap", () => {
    const s = auditTemporalFactsStatus({ enabled: false, chapterNumber: 4, facts: [] })
    expect(s.level).toBe("disabled")
    expect(s.shouldRecordGap).toBe(false)
  })

  it("ch1 empty → skip", () => {
    const s = auditTemporalFactsStatus({ enabled: true, chapterNumber: 1, facts: [] })
    expect(s.level).toBe("skipped_ch1")
    expect(s.shouldRecordGap).toBe(false)
  })

  it("mid-chapter empty → empty_soft gap", () => {
    const s = auditTemporalFactsStatus({ enabled: true, chapterNumber: 4, facts: [] })
    expect(s.level).toBe("empty_soft")
    expect(s.shouldRecordGap).toBe(true)
    expect(s.productHardGate).toBe(false)
  })

  it("non-empty → ok", () => {
    const s = auditTemporalFactsStatus({
      enabled: true,
      chapterNumber: 4,
      facts: [{ id: "f1" } as never],
    })
    expect(s.level).toBe("ok")
    expect(s.shouldRecordGap).toBe(false)
    expect(s.factCount).toBe(1)
  })

  it("gap ref is stable", () => {
    expect(temporalEmptySoftGapRef(4)).toContain("ch4")
  })
})
