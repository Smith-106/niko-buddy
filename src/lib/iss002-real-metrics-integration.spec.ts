/**
 * ISS-20260719-002 真实集成测试: token 数据通道端到端落盘.
 *
 * 与 llm-metrics.spec.ts 的区别: 后者用 writeFileAtomicMock 验证"调用了 mock",
 * 本测试启动真实 mock-stage2-llm HTTP server (scripts/mock-stage2-llm.mjs,
 * 增补 final-chunk usage 字段), 用真实 fetch SSE + 真实 streamChat + 真实
 * node fs 落盘 metrics.jsonl, 验证 token 数据通道在真实 HTTP 往返下端到端可用:
 *
 *   mock server (usage final chunk) → fetch SSE → extractOpenAiUsage →
 *   recordUsage 累加 → collectLLMMetric buffer → flushMetrics read-modify-write
 *   → 真实磁盘 metrics.jsonl (含 inputTokens/outputTokens)
 *
 * Token 数字本身是 mock server 编的合成值 (非真实 LLM 计费), 但通道每一跳
 * (wire format → extraction → buffer → atomic 落盘) 都是真实代码路径, 非 mock.
 * 这验证了 ISS-002 的决策数据通道在真实 HTTP 往返下可产出 metrics.jsonl —
 * 用户下次在 Tauri 应用配真实 LLM 跑生成时, 同一通道会捕获真实 token.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const MOCK_SERVER_PATH = fileURLToPath(
  new URL("../../scripts/mock-stage2-llm.mjs", import.meta.url),
)
const MOCK_HOST = "127.0.0.1"
const MOCK_PORT = 18080

describe("ISS-20260719-002 real token channel — mock HTTP server end-to-end", () => {
  let serverProc: ReturnType<typeof spawn>
  let tmpDir: string
  let metricsPath: string

  beforeAll(async () => {
    // 启动真实 mock LLM server (独立 node 进程, 监听 18080).
    serverProc = spawn("node", [MOCK_SERVER_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    // 等待 server 就绪 (轮询端口).
    const ready = await waitForPort(MOCK_HOST, MOCK_PORT, 5000)
    if (!ready) {
      throw new Error(
        `mock-stage2-llm server did not start on ${MOCK_HOST}:${MOCK_PORT} within 5s`,
      )
    }
  }, 15000)

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "iss002-metrics-"))
    metricsPath = join(tmpDir, "metrics.jsonl")

    // 真实 node fs 实现 @/commands/fs (flushMetrics 用 readFile + writeFileAtomic).
    // 非空 path 触发真实落盘, 空目录返回 "" (read-modify-write 起步).
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
    setMetricsTraceId("iss002-integration-run")
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

  afterAll(() => {
    if (serverProc) serverProc.kill("SIGTERM")
  })

  it("streamChat 真实 HTTP SSE → token 捕获 → metrics.jsonl 真实落盘含 token 字段", async () => {
    const { streamChat, flushMetrics } = await import("@/lib/llm-client")

    const llmConfig = {
      provider: "custom" as const,
      apiKey: "",
      model: "mock-qmai",
      ollamaUrl: "",
      customEndpoint: `http://${MOCK_HOST}:${MOCK_PORT}`,
      apiMode: "chat_completions" as const,
      maxContextSize: 131072,
      reasoning: { mode: "off" as const },
    }

    let content = ""
    let streamError: Error | null = null
    await streamChat(
      llmConfig,
      [{ role: "user", content: "请生成第 1 章正文" }],
      {
        onToken: (t: string) => {
          content += t
        },
        onDone: () => undefined,
        onError: (e: Error) => {
          streamError = e
        },
      },
      AbortSignal.timeout(15000),
      { temperature: 0 },
    )

    expect(streamError).toBeNull()
    expect(content.length).toBeGreaterThan(0)

    // flushMetrics 真实落盘到磁盘 (经 vi.doMock 的 node fs).
    const flushed = await flushMetrics()
    expect(flushed).toBeGreaterThanOrEqual(1)

    // 用真实 node fs 读回落盘的 metrics.jsonl, 断言 token 字段真实持久化.
    const onDisk = readFileSync(metricsPath, "utf8")
    const lines = onDisk.trim().split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const record = JSON.parse(lines[lines.length - 1])
    expect(record.model).toBe("mock-qmai")
    expect(record.traceId).toBe("iss002-integration-run")
    expect(record.success).toBe(true)
    // 真实 token 通道: mock server final-chunk usage (prompt_tokens=42,
    // completion_tokens=ceil(text/4)) 经 extractOpenAiUsage → recordUsage →
    // LlmMetric inputTokens/outputTokens → 落盘. 非空证明端到端通道可用.
    expect(record.inputTokens).toBe(42)
    expect(typeof record.outputTokens).toBe("number")
    expect(record.outputTokens).toBeGreaterThan(0)
  })

  it("多次 streamChat 累积多记录 read-modify-write 追加落盘", async () => {
    const { streamChat, flushMetrics } = await import("@/lib/llm-client")

    const llmConfig = {
      provider: "custom" as const,
      apiKey: "",
      model: "mock-qmai",
      ollamaUrl: "",
      customEndpoint: `http://${MOCK_HOST}:${MOCK_PORT}`,
      apiMode: "chat_completions" as const,
      maxContextSize: 131072,
      reasoning: { mode: "off" as const },
    }

    for (let i = 0; i < 3; i++) {
      await streamChat(
        llmConfig,
        [{ role: "user", content: `请生成第 ${i + 1} 章正文` }],
        { onToken: () => undefined, onDone: () => undefined, onError: () => undefined },
        AbortSignal.timeout(15000),
        { temperature: 0 },
      )
    }
    await flushMetrics()

    const onDisk = readFileSync(metricsPath, "utf8")
    const lines = onDisk.trim().split("\n")
    // 3 次调用, 每次落 1 条记录 (read-modify-write 追加, 非覆盖).
    expect(lines.length).toBe(3)
    for (const line of lines) {
      const r = JSON.parse(line)
      expect(r.inputTokens).toBe(42)
      expect(r.outputTokens).toBeGreaterThan(0)
    }
  })
})

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-qmai", messages: [], stream: true }),
        signal: AbortSignal.timeout(1000),
      })
      // 任何 HTTP 响应 (即使是 4xx) 都说明端口在监听.
      res.body?.cancel()
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return false
}
