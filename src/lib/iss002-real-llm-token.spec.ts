/**
 * ISS-20260719-002 真实 LLM token 集成测试 (非 mock).
 *
 * 与 iss002-real-metrics-integration.spec.ts (mock server) 互补 — 后者用
 * mock-stage2-llm 产 mock 合成 token 验证通道端到端; 本测试用真实 Anthropic-
 * wire 兼容 endpoint 产真实 LLM 计费 token, 验证 extractAnthropicUsage 在真实
 * SSE 往返下捕获真实 input/output token 落盘 metrics.jsonl.
 *
 * 触发方式 (key 不入 git, 从环境变量读, 缺则 skip):
 *   ISS002_REAL_LLM_KEY=sk-... ISS002_REAL_LLM_BASE=https://... ISS002_REAL_LLM_MODEL=claude-haiku-4-5 \
 *     node node_modules/vitest/vitest.mjs run src/lib/iss002-real-llm-token.spec.ts
 *
 * 真实 endpoint: Anthropic Messages wire (/v1/messages), message_start +
 * message_delta 事件携带 usage.input_tokens / usage.output_tokens (真实计费
 * token, 非 mock 合成). extractAnthropicUsage 解析这两个事件 → recordUsage 累加
 * → LlmMetric inputTokens/outputTokens → flushMetrics 落盘 metrics.jsonl.
 *
 * 烧真实 token (极少): haiku max_tokens 15, input~8 token, 单次请求 < 0.001 美分.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REAL_KEY = process.env.ISS002_REAL_LLM_KEY ?? ""
const REAL_BASE = process.env.ISS002_REAL_LLM_BASE ?? ""
const REAL_MODEL = process.env.ISS002_REAL_LLM_MODEL ?? "claude-haiku-4-5"

const hasRealCreds = REAL_KEY.length > 0 && REAL_BASE.length > 0
const describeOrSkip = hasRealCreds ? describe : describe.skip

describeOrSkip("ISS-20260719-002 真实 LLM token — Anthropic wire 真实 token 落盘", () => {
  let tmpDir: string
  let metricsPath: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "iss002-real-llm-"))
    metricsPath = join(tmpDir, "metrics.jsonl")

    vi.doMock("@/commands/fs", () => ({
      readFile: async (path: string): Promise<string> => {
        try {
          return readFileSync(path, "utf8")
        } catch {
          return ""
        }
      },
      writeFileAtomic: async (path: string, contents: string): Promise<void> => {
        const { writeFileSync, mkdirSync } = await import("node:fs")
        mkdirSync(join(path, ".."), { recursive: true })
        writeFileSync(path, contents, "utf8")
      },
    }))

    const { setMetricsFilePath, setMetricsTraceId, __clearMetricsBufferForTest } =
      await import("@/lib/llm-client")
    setMetricsFilePath(metricsPath)
    setMetricsTraceId("iss002-real-llm-run")
    __clearMetricsBufferForTest()
  })

  afterEach(async () => {
    vi.doUnmock("@/commands/fs")
    const { setMetricsFilePath, setMetricsTraceId, __clearMetricsBufferForTest } =
      await import("@/lib/llm-client")
    setMetricsFilePath("")
    setMetricsTraceId("")
    __clearMetricsBufferForTest()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it("真实 Anthropic endpoint streamChat → 真实 token 落盘 metrics.jsonl", async () => {
    const { streamChat, flushMetrics } = await import("@/lib/llm-client")

    // minimax provider = Anthropic-wire + customEndpoint (buildAnthropicUrl 加
    // /v1/messages) + x-api-key auth (requiresBearerAuth 不认此域名用 x-api-key,
    // gpt-load 兼容 endpoint 接受 x-api-key). 零产品代码改动复用 minimax case.
    const llmConfig = {
      provider: "minimax" as const,
      apiKey: REAL_KEY,
      model: REAL_MODEL,
      ollamaUrl: "",
      customEndpoint: REAL_BASE,
      apiMode: "chat_completions" as const,
      maxContextSize: 131072,
      reasoning: { mode: "off" as const },
    }

    let content = ""
    let streamError: Error | null = null
    await streamChat(
      llmConfig,
      [{ role: "user", content: "只回复两个字: 收到" }],
      {
        onToken: (t: string) => {
          content += t
        },
        onDone: () => undefined,
        onError: (e: Error) => {
          streamError = e
        },
      },
      AbortSignal.timeout(30000),
      { temperature: 0, max_tokens: 15 },
    )

    expect(streamError).toBeNull()
    expect(content.length).toBeGreaterThan(0)

    const flushed = await flushMetrics()
    expect(flushed).toBeGreaterThanOrEqual(1)

    const onDisk = readFileSync(metricsPath, "utf8")
    const lines = onDisk.trim().split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const record = JSON.parse(lines[lines.length - 1])
    expect(record.model).toBe(REAL_MODEL)
    expect(record.traceId).toBe("iss002-real-llm-run")
    expect(record.success).toBe(true)
    // 真实 LLM 计费 token (非 mock 合成) — message_start + message_delta 事件
    // 的 usage 经 extractAnthropicUsage 捕获. input>0 (用户消息 token), output>0
    // (模型回复 token). 证明真实 LLM 往返下 token 数据通道端到端可用.
    expect(record.inputTokens).toBeGreaterThan(0)
    expect(record.outputTokens).toBeGreaterThan(0)
  }, 45000)
})
