import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  detectOllamaSlmStatus,
  screenDraftWithRuleFallback,
  screenDraftWithSlm,
  verifyPovEpistemicIntegrityWithSlm,
} from "./ollama-slm-adapter"

describe("Ollama SLM Adapter & Lightweight Gatekeeper", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe("detectOllamaSlmStatus", () => {
    it("should discover available models and recommend lightweight SLM", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: "llama3:70b" },
            { name: "qwen2.5:0.5b" },
            { name: "mistral:7b" },
          ],
        }),
      } as Response)

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(true)
      expect(result.recommendedSlm).toBe("qwen2.5:0.5b")
      expect(result.installedModels).toEqual(["llama3:70b", "qwen2.5:0.5b", "mistral:7b"])
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it("should pick first model if no preference matches", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [{ name: "custom-novel-model" }],
        }),
      } as Response)

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(true)
      expect(result.recommendedSlm).toBe("custom-novel-model")
    })

    it("should handle empty models array", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response)

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(true)
      expect(result.recommendedSlm).toBeUndefined()
      expect(result.installedModels).toEqual([])
    })

    it("should handle HTTP error status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      } as Response)

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(false)
      expect(result.error).toContain("HTTP 502")
    })

    it("should handle connection error or offline status gracefully", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(false)
      expect(result.error).toContain("ECONNREFUSED")
      expect(result.installedModels).toEqual([])
    })

    it("should handle non-Error throw gracefully", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue("string failure")

      const result = await detectOllamaSlmStatus("http://localhost:11434")
      expect(result.available).toBe(false)
      expect(result.error).toBe("string failure")
    })

    it("should abort on timeout", async () => {
      vi.useFakeTimers()
      globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted."))
            })
          }
        })
      })

      const promise = detectOllamaSlmStatus("http://localhost:11434", 50)
      vi.advanceTimersByTime(100)
      const result = await promise
      expect(result.available).toBe(false)
      expect(result.error).toContain("aborted")
      vi.useRealTimers()
    })
  })

  describe("screenDraftWithRuleFallback", () => {
    it("should ignore empty prohibited terms or empty constraint brackets", () => {
      const result = screenDraftWithRuleFallback({
        draftText: "普通的一段正文",
        prohibitedTerms: ["   "],
        epistemicConstraints: ["【   】"],
      })
      expect(result.passed).toBe(true)
      expect(result.p0Violations).toHaveLength(0)
    })

    it("should pass clean drafts without prohibited terms or leaks", () => {
      const result = screenDraftWithRuleFallback({
        draftText: "夜色渐深，他在破旧的码头快步疾行，风雨交加。",
        prohibitedTerms: ["机密代号X"],
        epistemicConstraints: ["【禁止描写】：主角绝对不知晓【身世秘密】"],
      })

      expect(result.passed).toBe(true)
      expect(result.tier).toBe("rule_fallback")
      expect(result.p0Violations).toHaveLength(0)
      expect(result.p1Warnings).toHaveLength(0)
    })

    it("should detect prohibited terms and epistemic leaks", () => {
      const result = screenDraftWithRuleFallback({
        draftText: "他知道自己的身世秘密，并且大喊出了机密代号X。总而言之，一切都结束了。",
        prohibitedTerms: ["机密代号X"],
        epistemicConstraints: ["【禁止描写】：主角绝对不知晓【身世秘密】"],
      })

      expect(result.passed).toBe(false)
      expect(result.p0Violations).toEqual([
        "触发禁忌词违规：机密代号X",
        "全知视角泄露违规（角色不知晓却出现）：身世秘密",
      ])
      expect(result.p1Warnings).toContain("疑似AI套话：总而言之")
    })

    it("should handle raw constraints without brackets", () => {
      const result = screenDraftWithRuleFallback({
        draftText: "真相就是毒药来源是沈公馆。",
        epistemicConstraints: ["毒药来源"],
      })

      expect(result.passed).toBe(false)
      expect(result.p0Violations[0]).toContain("毒药来源")
    })
  })

  describe("screenDraftWithSlm", () => {
    it("should abort on timeout in screenDraftWithSlm", async () => {
      vi.useFakeTimers()
      globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted."))
            })
          }
        })
      })

      const promise = screenDraftWithSlm({
        draftText: "一段测试文本",
        timeoutMs: 50,
      })
      vi.advanceTimersByTime(100)
      const result = await promise
      expect(result.tier).toBe("rule_fallback")
      vi.useRealTimers()
    })

    it("should successfully parse JSON response from local Ollama", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            p0Violations: ["人物视点越权"],
            p1Warnings: ["用词重复"],
          }),
        }),
      } as Response)

      const result = await screenDraftWithSlm({
        draftText: "测试草稿文本",
        slmModel: "qwen2.5:0.5b",
      })

      expect(result.tier).toBe("slm_fast_gate")
      expect(result.passed).toBe(false)
      expect(result.p0Violations).toEqual(["人物视点越权"])
      expect(result.p1Warnings).toEqual(["用词重复"])
      expect(result.confidence).toBe(0.95)
    })

    it("should handle empty or malformed response gracefully by defaulting to empty arrays", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: "{}",
        }),
      } as Response)

      const result = await screenDraftWithSlm({
        draftText: "一段普通的情节叙事",
      })

      expect(result.tier).toBe("slm_fast_gate")
      expect(result.passed).toBe(true)
      expect(result.p0Violations).toEqual([])
      expect(result.p1Warnings).toEqual([])
    })

    it("should fallback to rule screening if Ollama returns non-ok status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response)

      const result = await screenDraftWithSlm({
        draftText: "含有机密词汇",
        prohibitedTerms: ["机密词汇"],
      })

      expect(result.tier).toBe("rule_fallback")
      expect(result.passed).toBe(false)
      expect(result.p0Violations).toContain("触发禁忌词违规：机密词汇")
    })

    it("should fallback to rule screening if Ollama connection times out or fails", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Timeout"))

      const result = await screenDraftWithSlm({
        draftText: "纯净草稿",
      })

      expect(result.tier).toBe("rule_fallback")
      expect(result.passed).toBe(true)
    })
  })

  describe("verifyPovEpistemicIntegrityWithSlm", () => {
    it("should instantly pass if character has no forbidden knowledge", async () => {
      const result = await verifyPovEpistemicIntegrityWithSlm({
        draftText: "任何文本",
        characterName: "侦探",
        doesNotKnowFacts: [],
      })

      expect(result.passed).toBe(true)
      expect(result.leakedFacts).toEqual([])
      expect(result.checkedBy).toBe("slm")
    })

    it("should pass when character has forbidden facts but draft does not leak them", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            p0Violations: [],
            p1Warnings: [],
          }),
        }),
      } as Response)

      const result = await verifyPovEpistemicIntegrityWithSlm({
        draftText: "今天天气晴朗，林越在湖边散步。",
        characterName: "林越",
        doesNotKnowFacts: ["沈清秋是真凶"],
      })

      expect(result.passed).toBe(true)
      expect(result.leakedFacts).toEqual([])
      expect(result.reasoning).toBeUndefined()
      expect(result.checkedBy).toBe("slm")
    })

    it("should verify and detect leaks via SLM screening", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            p0Violations: ["侦探不知晓幕后真凶却直接写明了真凶姓名"],
            p1Warnings: [],
          }),
        }),
      } as Response)

      const result = await verifyPovEpistemicIntegrityWithSlm({
        draftText: "侦探心里清楚幕后真凶就是沈清秋。",
        characterName: "侦探",
        doesNotKnowFacts: ["幕后真凶是沈清秋"],
      })

      expect(result.passed).toBe(false)
      expect(result.leakedFacts).toHaveLength(1)
      expect(result.reasoning).toContain("真凶")
      expect(result.checkedBy).toBe("slm")
    })

    it("should report checkedBy rule_fallback when falling back", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Ollama not running"))

      const result = await verifyPovEpistemicIntegrityWithSlm({
        draftText: "他知道真凶是沈清秋。",
        characterName: "侦探",
        doesNotKnowFacts: ["真凶是沈清秋"],
      })

      expect(result.passed).toBe(false)
      expect(result.checkedBy).toBe("rule_fallback")
    })
  })
})
