import { describe, expect, it } from "vitest"
import { normalizeEndpoint } from "./endpoint-normalizer"

describe("normalizeEndpoint", () => {
  it("returns an empty normalized value for blank input", () => {
    expect(normalizeEndpoint("", "chat_completions")).toEqual({ normalized: "", changed: false })
    expect(normalizeEndpoint("   ", "chat_completions")).toEqual({ normalized: "", changed: false })
    expect(normalizeEndpoint(undefined as unknown as string, "chat_completions")).toEqual({
      normalized: "",
      changed: false,
    })
  })

  it("flags a missing protocol without prepending https", () => {
    const result = normalizeEndpoint("api.example.com/v1", "chat_completions")
    expect(result.normalized).toBe("api.example.com/v1")
    expect(result.changed).toBe(false)
    expect(result.warning).toContain("http:// 或 https://")
  })

  it("strips trailing slashes when warning about the protocol", () => {
    const result = normalizeEndpoint("api.example.com/v1///", "chat_completions")
    expect(result.normalized).toBe("api.example.com/v1")
    expect(result.changed).toBe(true)
    expect(result.warning).toContain("http:// 或 https://")
  })

  it("warns about malformed URLs", () => {
    const result = normalizeEndpoint("https://exa mple.com/v1", "chat_completions")
    expect(result.normalized).toBe("https://exa mple.com/v1")
    expect(result.changed).toBe(false)
    expect(result.warning).toContain("格式不正确")
  })

  it("returns clean URLs unchanged without a warning", () => {
    const result = normalizeEndpoint("https://api.example.com/v1", "chat_completions")
    expect(result).toEqual({ normalized: "https://api.example.com/v1", changed: false, warning: undefined })
  })

  it("strips trailing slashes", () => {
    const result = normalizeEndpoint("https://api.example.com/v1///", "chat_completions")
    expect(result.normalized).toBe("https://api.example.com/v1")
    expect(result.changed).toBe(true)
  })

  it("strips request-path tails pasted by accident", () => {
    const r1 = normalizeEndpoint("https://api.example.com/v1/chat/completions", "chat_completions")
    expect(r1.normalized).toBe("https://api.example.com/v1")
    expect(r1.changed).toBe(true)
    expect(r1.warning).toContain("chat/completions")

    const r2 = normalizeEndpoint("https://api.example.com/v1/responses/", "responses")
    expect(r2.normalized).toBe("https://api.example.com/v1")
    expect(r2.warning).toContain("responses")

    const r3 = normalizeEndpoint("https://api.example.com/v1/embeddings", "chat_completions")
    expect(r3.normalized).toBe("https://api.example.com/v1")
    expect(r3.warning).toContain("embeddings")
  })

  it("strips the /messages tail only in chat_completions mode", () => {
    const stripped = normalizeEndpoint("https://api.example.com/v1/messages", "chat_completions")
    expect(stripped.normalized).toBe("https://api.example.com/v1")
    expect(stripped.warning).toContain("Anthropic 兼容路径")

    const kept = normalizeEndpoint("https://api.example.com/v1/messages", "anthropic_messages")
    expect(kept.normalized).toBe("https://api.example.com/v1/messages")
  })

  it("flags a missing version path for OpenAI-compatible modes", () => {
    const r1 = normalizeEndpoint("https://api.example.com", "chat_completions")
    expect(r1.warning).toContain("/v1")

    const r2 = normalizeEndpoint("https://api.example.com", "responses")
    expect(r2.warning).toContain("/v1")

    const r3 = normalizeEndpoint("https://api.example.com", "anthropic_messages")
    expect(r3.warning).toBeUndefined()
  })

  it("does not flag a missing version when the path already has one", () => {
    for (const path of ["/v1", "/v2", "/paas/v1", "/openai/v1", "/api/v1"]) {
      const result = normalizeEndpoint(`https://api.example.com${path}`, "chat_completions")
      expect(result.warning).toBeUndefined()
    }
  })

  it("does not double-warn when a tail was already stripped", () => {
    const result = normalizeEndpoint("https://api.example.com/v1/chat/completions", "chat_completions")
    expect(result.warning).toContain("chat/completions")
    expect(result.warning).not.toContain("缺少版本路径")
  })

  it("flags invalid IPv4-shaped hosts (defensive — Node 端不可达)", () => {
    // Node WHATWG URL 对越界/多段数字宿主直接抛错，IPv4 提示分支在当前运行时不可达（记录为不可达防御分支）
    const r1 = normalizeEndpoint("https://999.1.2.3/v1", "chat_completions")
    expect(r1.warning).toContain("格式不正确")
    const r2 = normalizeEndpoint("https://1.2.3.4.5/v1", "chat_completions")
    expect(r2.warning).toContain("格式不正确")

    const ok = normalizeEndpoint("https://192.168.1.1/v1", "chat_completions")
    expect(ok.warning).toBeUndefined()
  })

  describe("azure mode", () => {
    it("strips chat/completions and notes the change", () => {
      const result = normalizeEndpoint(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions",
        "azure",
      )
      expect(result.normalized).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt-4")
      expect(result.warning).toContain("chat/completions")
    })

    it("auto-detects azure endpoints even in non-azure modes", () => {
      const result = normalizeEndpoint(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions",
        "chat_completions",
      )
      expect(result.normalized).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt-4")
    })

    it("notes removed query parameters in azure mode", () => {
      const result = normalizeEndpoint(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4?api-version=2024-10-21",
        "azure",
      )
      expect(result.normalized).toBe("https://my-resource.openai.azure.com/openai/deployments/gpt-4")
      expect(result.warning).toContain("查询参数")
    })

    it("keeps extra path segments after chat/completions untouched (parseable but not a clean tail)", () => {
      const result = normalizeEndpoint(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions/extra junk",
        "azure",
      )
      // 空格被 WHATWG URL 编码为 %20，路径可解析但尾缀不匹配 → 不剥离、无告警
      expect(result.normalized).toContain("gpt-4")
      expect(result.normalized).toContain("extra%20junk")
      expect(result.warning).toBeUndefined()
    })
  })
})
