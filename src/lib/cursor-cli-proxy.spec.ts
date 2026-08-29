import { describe, expect, it } from "vitest"
import { toCursorProxyV1Endpoint, withCursorProxyEndpoint } from "./cursor-cli-proxy"

describe("cursor-cli-proxy helpers", () => {
  it("toCursorProxyV1Endpoint 追加 /v1", () => {
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765/v1")
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765/")).toBe("http://127.0.0.1:8765/v1")
  })

  it("toCursorProxyV1Endpoint 保留已有 /v1", () => {
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765/v1")).toBe("http://127.0.0.1:8765/v1")
  })

  it("withCursorProxyEndpoint 注入端点并切换 apiMode", () => {
    const base = {
      provider: "cursor-cli" as const,
      apiKey: "",
      model: "claude-3.7-sonnet",
      customEndpoint: "",
      apiMode: "chat_completions" as const,
    }
    const out = withCursorProxyEndpoint(base, "http://127.0.0.1:8765/v1")
    expect(out.customEndpoint).toBe("http://127.0.0.1:8765/v1")
    expect(out.apiMode).toBe("chat_completions")
  })
})
