import { describe, expect, it } from "vitest"
import { collectLiteraryPolishIssues } from "./deep-chapter-generation"

describe("probe literary", () => {
  it("dedupe probe", () => {
    const gates = {
      consistency: { status: "passed", findings: [
        { severity: "warning", type: "plot", message: "爽点偏弱", evidence: "", relatedMemory: "", suggestion: "" },
      ] },
      anti_ai: { status: "passed", findings: [] },
      quality: { status: "passed", findings: [
        { severity: "error", type: "plot", message: "情节断裂", evidence: "", relatedMemory: "", suggestion: "" },
        { severity: "warning", type: "thrill", message: "爽点偏弱", evidence: "", relatedMemory: "", suggestion: "" },
      ] },
      overall: "pass",
    }
    const issues = collectLiteraryPolishIssues(gates as never)
    console.log("PROBE issues:", JSON.stringify(issues.map((i) => i.message)))
    expect(issues.length).toBe(2)
  })
})
