import { describe, expect, it } from "vitest"
import { runDecisionGates } from "./gates"

describe("runDecisionGates fallback", () => {
  it("passes clean text with only optional quality warnings absent", async () => {
    const text = "他推开旧门，屋里只有钟摆声。她没有回头，只把那串钥匙攥得更紧。"
    const result = await runDecisionGates("/tmp/qmai-gates-clean", text)

    expect(result.all_passed).toBe(true)
    expect(result.max_retry).toBe(3)
    expect(result.gate_results.consistency.status).toBe("passed")
    expect(result.gate_results.anti_ai.status).toBe("passed")
    expect(result.gate_results.quality.status).toBe("passed")
  })

  it("fails consistency when cognition and setting contradictions exist", async () => {
    const text = "他不知道这件事，却知道其中的关键细节。在古代背景的京城，他拿出手机给朋友发了微信。"
    const result = await runDecisionGates("/tmp/qmai-gates-consistency", text)

    expect(result.all_passed).toBe(false)
    expect(result.gate_results.consistency.status).toBe("failed")
    expect(result.gate_results.consistency.retry_count).toBe(1)
    expect(result.gate_results.consistency.finding_count).toBeGreaterThanOrEqual(2)
    expect(result.gate_results.consistency.findings_desc.some((line) => line.includes("角色同时不知道和知道同一件事"))).toBe(true)
    expect(result.gate_results.consistency.findings_desc.some((line) => line.includes("古代背景出现现代科技"))).toBe(true)
  })

  it("fails anti_ai and warns quality on slop-heavy run-on text", async () => {
    const text = "然而，事实上，他感到一阵复杂的感动，因为这一切显然意味着某种底层逻辑正在赋能他的判断，因此他进行评估并做出选择也就是说这意味着他正在正准备以一种全方位的方式继续推进这个局面而且没有停顿"
    const result = await runDecisionGates("/tmp/qmai-gates-anti-ai", text)

    expect(result.all_passed).toBe(false)
    expect(result.gate_results.anti_ai.status).toBe("failed")
    expect(result.gate_results.anti_ai.retry_count).toBe(1)
    expect(result.gate_results.anti_ai.finding_count).toBeGreaterThan(0)
    expect(result.gate_results.quality.status).toBe("warning")
    expect(result.gate_results.quality.mechanical_findings[0]?.description).toContain("平均句长")
  })
})
