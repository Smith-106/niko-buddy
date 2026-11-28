/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { LlmCacheStatsCard } from "./llm-cache-stats-card"
import type { LlmRequestTraceSnapshot } from "@/lib/llm-client"

const mocks = vi.hoisted(() => ({
  getLlmRequestTraceSnapshot: vi.fn<() => LlmRequestTraceSnapshot>(),
}))

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    getLlmRequestTraceSnapshot: mocks.getLlmRequestTraceSnapshot,
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dv = typeof opts?.defaultValue === "string" ? opts.defaultValue : key
      return dv.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ""))
    },
  }),
}))

describe("LlmCacheStatsCard", () => {
  beforeEach(() => {
    mocks.getLlmRequestTraceSnapshot.mockReturnValue({
      requests: [],
      omittedRequestCount: 0,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("空采样时展示空状态文案", () => {
    render(<LlmCacheStatsCard />)
    expect(screen.getByTestId("llm-cache-stats-card")).toBeTruthy()
    expect(screen.getByTestId("llm-cache-stats-empty")).toBeTruthy()
  })

  it("有采样时聚合展示命中率、节省 token、分通道明细与淘汰提示", () => {
    mocks.getLlmRequestTraceSnapshot.mockReturnValue({
      omittedRequestCount: 4,
      requests: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          apiMode: "anthropic_messages",
          startedAt: 100,
          finishedAt: 200,
          durationMs: 100,
          inputTokens: 1000,
          outputTokens: 50,
          cacheReadTokens: 800,
          savedTokens: 800,
          cacheHit: true,
          status: "success",
        },
        {
          provider: "openai",
          model: "gpt-4o",
          apiMode: "chat_completions",
          startedAt: 300,
          finishedAt: 400,
          durationMs: 100,
          inputTokens: 500,
          outputTokens: 20,
          cacheReadTokens: 0,
          savedTokens: 0,
          cacheHit: false,
          status: "success",
        },
      ],
    })

    render(<LlmCacheStatsCard />)
    expect(screen.getByTestId("llm-cache-hit-rate").textContent).toBe("50.0%")
    expect(screen.getByTestId("llm-cache-saved-tokens").textContent).toBe("800")
    expect(screen.getByTestId("llm-cache-total-input").textContent).toBe("1,500")
    expect(screen.getByTestId("llm-cache-provider-anthropic").textContent).toContain("1/1")
    expect(screen.getByTestId("llm-cache-provider-openai").textContent).toContain("0/1")
    expect(screen.getByTestId("llm-cache-omitted-note").textContent).toContain("4")
  })

  it("点击刷新按钮重新读取快照", () => {
    render(<LlmCacheStatsCard />)
    expect(screen.getByTestId("llm-cache-stats-empty")).toBeTruthy()

    mocks.getLlmRequestTraceSnapshot.mockReturnValue({
      omittedRequestCount: 0,
      requests: [
        {
          provider: "openai",
          model: "gpt-4o",
          apiMode: "chat_completions",
          startedAt: 10,
          finishedAt: 20,
          durationMs: 10,
          inputTokens: 400,
          cacheReadTokens: 300,
          savedTokens: 300,
          cacheHit: true,
          status: "success",
        },
      ],
    })

    fireEvent.click(screen.getByTestId("llm-cache-stats-refresh"))
    expect(screen.getByTestId("llm-cache-hit-rate").textContent).toBe("100.0%")
    expect(screen.getByTestId("llm-cache-saved-tokens").textContent).toBe("300")
  })
})
