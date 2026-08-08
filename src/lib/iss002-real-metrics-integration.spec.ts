/**
 * ISS-20260719-002 真实集成测试: token 数据通道端到端落盘.
 *
 * Uses an ephemeral local port (not hard-coded 18080) so a foreign process on
 * 18080 cannot hijack the mock. SEC-02 product guard still blocks loopback HTTP
 * in production; this suite mocks getHttpFetch → native fetch for local mock only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MOCK_SERVER_PATH = fileURLToPath(
  new URL("../../scripts/mock-stage2-llm.mjs", import.meta.url),
)
const MOCK_HOST = "127.0.0.1"

vi.mock("./tauri-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tauri-fetch")>()
  return {
    ...actual,
    getHttpFetch: async () => globalThis.fetch.bind(globalThis),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: async (path: string): Promise<string> => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  },
  writeFileAtomic: async (path: string, contents: string): Promise<void> => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, "utf8")
  },
}))

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, MOCK_HOST, () => {
      const addr = s.address()
      if (!addr || typeof addr === "string") {
        s.close()
        reject(new Error("failed to reserve port"))
        return
      }
      const port = addr.port
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

describe("ISS-20260719-002 real token channel — mock HTTP server end-to-end", () => {
  let serverProc: ReturnType<typeof spawn>
  let mockPort = 0
  let tmpDir: string
  let metricsPath: string

  beforeAll(async () => {
    mockPort = await reservePort()
    serverProc = spawn("node", [MOCK_SERVER_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MOCK_STAGE2_PORT: String(mockPort),
      },
    })
    const ready = await waitForPort(MOCK_HOST, mockPort, 8000)
    if (!ready) {
      throw new Error(
        `mock-stage2-llm server did not start on ${MOCK_HOST}:${mockPort} within 8s`,
      )
    }
  }, 20000)

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "iss002-metrics-"))
    metricsPath = join(tmpDir, "metrics.jsonl")
    const { setMetricsFilePath, setMetricsTraceId, __clearMetricsBufferForTest } =
      await import("@/lib/llm-client")
    setMetricsFilePath(metricsPath)
    setMetricsTraceId("iss002-integration-run")
    __clearMetricsBufferForTest()
  })

  afterEach(async () => {
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

  function llmConfig() {
    return {
      provider: "custom" as const,
      apiKey: "mock-local-key",
      model: "mock-qmai",
      ollamaUrl: "",
      customEndpoint: `http://${MOCK_HOST}:${mockPort}/v1`,
      apiMode: "chat_completions" as const,
      maxContextSize: 131072,
      reasoning: { mode: "off" as const },
    }
  }

  it("streamChat 真实 HTTP SSE → token 捕获 → metrics.jsonl 真实落盘含 token 字段", async () => {
    const { streamChat, flushMetrics } = await import("@/lib/llm-client")

    let content = ""
    let streamError: Error | null = null
    await streamChat(
      llmConfig(),
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

    const flushed = await flushMetrics()
    expect(flushed).toBeGreaterThanOrEqual(1)

    const onDisk = readFileSync(metricsPath, "utf8")
    const lines = onDisk.trim().split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const record = JSON.parse(lines[lines.length - 1]!)
    expect(record.model).toBe("mock-qmai")
    expect(record.traceId).toBe("iss002-integration-run")
    expect(record.success).toBe(true)
    expect(record.inputTokens).toBe(42)
    expect(typeof record.outputTokens).toBe("number")
    expect(record.outputTokens).toBeGreaterThan(0)
  })

  it("多次 streamChat 累积多记录 read-modify-write 追加落盘", async () => {
    const { streamChat, flushMetrics } = await import("@/lib/llm-client")

    for (let i = 0; i < 3; i++) {
      await streamChat(
        llmConfig(),
        [{ role: "user", content: `请生成第 ${i + 1} 章正文` }],
        { onToken: () => undefined, onDone: () => undefined, onError: () => undefined },
        AbortSignal.timeout(15000),
        { temperature: 0 },
      )
    }
    await flushMetrics()

    const onDisk = readFileSync(metricsPath, "utf8")
    const lines = onDisk.trim().split("\n")
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
      res.body?.cancel()
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return false
}
