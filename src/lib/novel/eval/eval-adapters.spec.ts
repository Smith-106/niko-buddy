/** C4 冒烟覆盖：src/lib/novel/eval/eval-adapters.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { edgeKindToReasonCode, canonFactToGoldChunk, temporalFactToPoisonChunk, isL3CriticalFinding, contextPackToAssembledView, tripleKey, layerContainsTriple, computeEvalDigest } from "./eval-adapters"
describe("eval-adapters.ts smoke", () => {
  it("exports edgeKindToReasonCode", () => {
    expect(edgeKindToReasonCode).toBeDefined()
  })
  it("exports canonFactToGoldChunk", () => {
    expect(canonFactToGoldChunk).toBeDefined()
  })
  it("exports temporalFactToPoisonChunk", () => {
    expect(temporalFactToPoisonChunk).toBeDefined()
  })
  it("exports isL3CriticalFinding", () => {
    expect(isL3CriticalFinding).toBeDefined()
  })
  it("exports contextPackToAssembledView", () => {
    expect(contextPackToAssembledView).toBeDefined()
  })
  it("exports tripleKey", () => {
    expect(tripleKey).toBeDefined()
  })
  it("exports layerContainsTriple", () => {
    expect(layerContainsTriple).toBeDefined()
  })
  it("exports computeEvalDigest", () => {
    expect(computeEvalDigest).toBeDefined()
  })
})
