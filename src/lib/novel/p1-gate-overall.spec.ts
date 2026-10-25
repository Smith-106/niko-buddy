// ISS-20260712-ARCH-3: GateEvaluation.overall spec 过时（代码用 pending/pass/warning 对象簇）→ 改 spec 对齐代码。
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { buildDecisionGates, emptyDecisionGates } from "./deep-chapter-decision-gates"
import type { DeepChapterGateVerdict } from "./deep-chapter-generation"

describe("ISS-20260712-ARCH-3 GateEvaluation.overall 对齐代码", () => {
  it("overall 取值域为代码实际五态（pending/pass/warning/fail/manual_review）", () => {
    const allowed: DeepChapterGateVerdict[] = ["pending", "pass", "warning", "fail", "manual_review"]
    // 空门 → pending；全 pass → pass；单 warning → warning；单 error → fail
    expect(emptyDecisionGates().overall).toBe("pending")
    expect(buildDecisionGates([], 0).overall).toBe("pass")
    const warnGates = buildDecisionGates(
      [{ severity: "warning", type: "plot", message: "w", evidence: "", relatedMemory: "", suggestion: "" }],
      0,
    )
    expect(warnGates.overall).toBe("warning")
    expect(allowed).toContain(warnGates.overall)
    const failGates = buildDecisionGates(
      [{ severity: "error", type: "consistency", message: "e", evidence: "", relatedMemory: "", suggestion: "" }],
      0,
    )
    expect(failGates.overall).toBe("fail")
  })

  it("门对象为 pending/passed/failed status + verdict 双字段（非裸字符串）", () => {
    const gates = buildDecisionGates([], 0)
    for (const k of ["consistency", "anti_ai", "quality"] as const) {
      expect(["pending", "passed", "failed"]).toContain(gates[k].status)
      expect(["pending", "pass", "warning", "fail", "manual_review"]).toContain(gates[k].verdict)
    }
    // quality error → status failed + overall fail（P0 恒硬门优先级）
    const qFail = buildDecisionGates(
      [{ severity: "error", type: "quality", message: "q", evidence: "", relatedMemory: "", suggestion: "" }],
      0,
    )
    expect(qFail.quality.status).toBe("failed")
    expect(qFail.overall).toBe("fail")
  })

  it("manual_review 接线：人工标记 + error → overall manual_review（代码对象语义）", () => {
    const g = buildDecisionGates(
      [{ severity: "error", type: "quality", message: "q", evidence: "", relatedMemory: "", suggestion: "" }],
      0,
      true,
    )
    expect(g.overall).toBe("manual_review")
  })

  it("旧 spec 若断言 overall 为布尔/仅 pass-fail 即过时 — 本 spec 锁定代码五态", () => {
    // 文档化：代码 overall 从不是 boolean，也不是二值 pass/fail。
    const g = emptyDecisionGates()
    expect(typeof g.overall).toBe("string")
    expect(g.overall).not.toBe(true as unknown as string)
    expect(g.overall).not.toBe(false as unknown as string)
  })
})
