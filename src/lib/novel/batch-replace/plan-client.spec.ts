/** C4 冒烟覆盖：src/lib/novel/batch-replace/plan-client.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BATCH_REPLACE_OP, GATE_CONFIRM_PREFIX, GATE_DENIED_PREFIX, previewBatchReplace, applyBatchReplace, isGateRequireConfirm, isGateDenied, isTransactionRolledBack, buildEdgesFromPlan, preflightCanonEdgeGate, isPlanBlockedByCanonGate } from "./plan-client"
describe("plan-client.ts smoke", () => {
  it("exports BATCH_REPLACE_OP", () => {
    expect(BATCH_REPLACE_OP).toBeDefined()
  })
  it("exports GATE_CONFIRM_PREFIX", () => {
    expect(GATE_CONFIRM_PREFIX).toBeDefined()
  })
  it("exports GATE_DENIED_PREFIX", () => {
    expect(GATE_DENIED_PREFIX).toBeDefined()
  })
  it("exports previewBatchReplace", () => {
    expect(previewBatchReplace).toBeDefined()
  })
  it("exports applyBatchReplace", () => {
    expect(applyBatchReplace).toBeDefined()
  })
  it("exports isGateRequireConfirm", () => {
    expect(isGateRequireConfirm).toBeDefined()
  })
  it("exports isGateDenied", () => {
    expect(isGateDenied).toBeDefined()
  })
  it("exports isTransactionRolledBack", () => {
    expect(isTransactionRolledBack).toBeDefined()
  })
  it("exports buildEdgesFromPlan", () => {
    expect(buildEdgesFromPlan).toBeDefined()
  })
  it("exports preflightCanonEdgeGate", () => {
    expect(preflightCanonEdgeGate).toBeDefined()
  })
  it("exports isPlanBlockedByCanonGate", () => {
    expect(isPlanBlockedByCanonGate).toBeDefined()
  })
})
