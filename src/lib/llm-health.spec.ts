import { describe, expect, it } from "vitest"
import { assessLlmHealth } from "./llm-health"

const base = { provider: "openai" as const, apiKey: "", model: "" }

describe("assessLlmHealth — J01-T01 模型服务状态机", () => {
  it("默认空配置（openai apiKey/model 全空）→ unconfigured", () => {
    const h = assessLlmHealth(base)
    expect(h.status).toBe("unconfigured")
    expect(h.canWrite).toBe(false)
    expect(h.nextStep).toContain("AI 写作")
  })

  it("hosted provider 配齐 apiKey+model → usable", () => {
    const h = assessLlmHealth({ provider: "openai", apiKey: "sk-x", model: "gpt-4o" })
    expect(h.status).toBe("usable")
    expect(h.canWrite).toBe(true)
    expect(h.nextStep).toBeNull()
  })

  it("hosted provider 只填了 apiKey 没填 model → incomplete", () => {
    const h = assessLlmHealth({ provider: "openai", apiKey: "sk-x", model: "" })
    expect(h.status).toBe("incomplete")
    expect(h.canWrite).toBe(false)
  })

  it("CLI provider（claude-code）无需 apiKey → usable", () => {
    const h = assessLlmHealth({ provider: "claude-code", apiKey: "", model: "" })
    expect(h.status).toBe("usable")
    expect(h.canWrite).toBe(true)
  })

  it("CLI provider cursor-cli 有 model → usable；无 model → unconfigured", () => {
    expect(assessLlmHealth({ provider: "cursor-cli", apiKey: "", model: "m" }).status).toBe("usable")
    expect(assessLlmHealth({ provider: "cursor-cli", apiKey: "", model: "" }).status).toBe("unconfigured")
  })

  it("探测 auth → auth_failed，文案不含内部字段名", () => {
    const h = assessLlmHealth({ provider: "openai", apiKey: "sk-x", model: "m" }, "auth")
    expect(h.status).toBe("auth_failed")
    expect(h.label).not.toMatch(/apiKey|provider|endpoint|401/)
    expect(h.canWrite).toBe(false)
  })

  it("探测 model → model_unavailable", () => {
    const h = assessLlmHealth({ provider: "openai", apiKey: "sk-x", model: "m" }, "model")
    expect(h.status).toBe("model_unavailable")
    expect(h.canWrite).toBe(false)
  })

  it("探测 ok → usable（即使静态判定本不完整，探测结果优先）", () => {
    const h = assessLlmHealth(base, "ok")
    expect(h.status).toBe("usable")
    expect(h.canWrite).toBe(true)
  })

  it("custom provider 缺 endpoint → incomplete（非 unconfigured，因已填 model）", () => {
    const h = assessLlmHealth({ provider: "custom", apiKey: "", model: "m", customEndpoint: "" })
    expect(h.status).toBe("incomplete")
  })

  it("缺省配置（undefined / null）→ unconfigured 且不抛错", () => {
    const h = assessLlmHealth(undefined)
    expect(h.status).toBe("unconfigured")
    expect(h.canWrite).toBe(false)
    expect(h.nextStep).toContain("AI 写作")
  })

  it("已退役 antigravity-cli 无论字段是否填写或探针返回 ok 都返回 canWrite=false，且引导官方 Antigravity ACP", () => {
    const emptyLegacy = assessLlmHealth({
      provider: "antigravity-cli",
      apiKey: "",
      model: "",
    })
    expect(emptyLegacy.canWrite).toBe(false)
    expect(emptyLegacy.status).toBe("unconfigured")
    expect(emptyLegacy.nextStep).toContain("AI 写作")
    expect(emptyLegacy.nextStep).toContain("Antigravity")

    const filledLegacy = assessLlmHealth({
      provider: "antigravity-cli",
      apiKey: "sk-legacy",
      model: "gemini-3-pro",
    })
    expect(filledLegacy.canWrite).toBe(false)
    expect(filledLegacy.status).toBe("unconfigured")

    const probedOkLegacy = assessLlmHealth(
      {
        provider: "antigravity-cli",
        apiKey: "sk-legacy",
        model: "gemini-3-pro",
      },
      "ok",
    )
    expect(probedOkLegacy.canWrite).toBe(false)
    expect(probedOkLegacy.status).toBe("unconfigured")
    expect(probedOkLegacy.nextStep).toContain("Antigravity")
  })
})
