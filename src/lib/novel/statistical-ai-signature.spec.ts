import { describe, expect, it } from "vitest"
import {
  formatStatisticalAiSignatureFragment,
  scoreStatisticalAiSignature,
} from "./statistical-ai-signature"

describe("statistical-ai-signature", () => {
  it("returns soft experimental score", () => {
    const sig = scoreStatisticalAiSignature("他走进房间，看见桌子上的钥匙。")
    expect(sig.productHardGate).toBe(false)
    expect(sig.experimental).toBe(true)
    expect(sig.score0to1).toBeGreaterThanOrEqual(0)
    expect(sig.score0to1).toBeLessThanOrEqual(1)
    expect(["low", "mid", "high"]).toContain(sig.band)
  })

  it("fragment empty for low band or soft for higher", () => {
    const sig = scoreStatisticalAiSignature(
      "In this sense, it is worth noting that we should further explore the aforementioned paradigm.",
    )
    const frag = formatStatisticalAiSignatureFragment(sig)
    if (sig.band === "low") expect(frag).toBe("")
    else expect(frag).toContain("Track B")
  })
})
