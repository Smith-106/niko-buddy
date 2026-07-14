import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  collectLLMMetric,
  flushMetrics,
  setMetricsFilePath,
  setMetricsTraceId,
  __clearMetricsBufferForTest,
} from "@/lib/llm-client"

/**
 * ISS-20260709-020: LLM metrics infrastructure tests.
 *
 * Verifies the buffer/flush contract: collectLLMMetric buffers synchronously
 * (safe from finally blocks), flushMetrics persists via read-modify-write_atomic,
 * and the no-file-configured path is a silent no-op. PAT-DC1: errorKind is a
 * short classification, never the raw message.
 */
describe("ISS-20260709-020 LLM metrics — collectLLMMetric + flushMetrics", () => {
  beforeEach(() => {
    setMetricsFilePath("")
    setMetricsTraceId("")
    __clearMetricsBufferForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("flushMetrics is a no-op when no file path is configured (silent degrade)", async () => {
    collectLLMMetric({
      ts: "2026-07-14T00:00:00.000Z",
      model: "test-model",
      provider: "anthropic",
      durationMs: 100,
      success: true,
    })
    const flushed = await flushMetrics()
    expect(flushed).toBe(0)
  })

  it("flushMetrics persists buffered metrics via read-modify-write_atomic", async () => {
    const readFileMock = vi.fn().mockRejectedValue(new Error("ENOENT"))
    const writeFileAtomicMock = vi.fn().mockResolvedValue(undefined)
    vi.doMock("@/commands/fs", () => ({
      readFile: readFileMock,
      writeFileAtomic: writeFileAtomicMock,
    }))

    setMetricsFilePath("/project/.novel/metrics.jsonl")
    setMetricsTraceId("run-001")
    collectLLMMetric({
      ts: "2026-07-14T00:00:00.000Z",
      model: "claude-sonnet",
      provider: "anthropic",
      durationMs: 1500,
      success: true,
    })
    collectLLMMetric({
      ts: "2026-07-14T00:00:01.000Z",
      model: "claude-sonnet",
      provider: "anthropic",
      durationMs: 800,
      success: false,
      errorKind: "timeout",
    })

    const flushed = await flushMetrics()
    expect(flushed).toBe(2)
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    const [path, contents] = writeFileAtomicMock.mock.calls[0]
    expect(path).toBe("/project/.novel/metrics.jsonl")
    // Two JSON lines, each stamped with the trace-id, separated by newline.
    const lines = contents.trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first.model).toBe("claude-sonnet")
    expect(first.traceId).toBe("run-001")
    expect(first.success).toBe(true)
    const second = JSON.parse(lines[1])
    expect(second.success).toBe(false)
    expect(second.errorKind).toBe("timeout")
    // Buffer cleared after flush.
    const secondFlush = await flushMetrics()
    expect(secondFlush).toBe(0)
    vi.doUnmock("@/commands/fs")
  })

  it("flushMetrics appends to an existing metrics file (read-modify-write)", async () => {
    const existing = JSON.stringify({
      ts: "2026-07-13T00:00:00.000Z",
      model: "old-model",
      provider: "anthropic",
      durationMs: 500,
      success: true,
      traceId: "run-000",
    }) + "\n"
    const readFileMock = vi.fn().mockResolvedValue(existing)
    const writeFileAtomicMock = vi.fn().mockResolvedValue(undefined)
    vi.doMock("@/commands/fs", () => ({
      readFile: readFileMock,
      writeFileAtomic: writeFileAtomicMock,
    }))

    setMetricsFilePath("/project/.novel/metrics.jsonl")
    collectLLMMetric({
      ts: "2026-07-14T00:00:00.000Z",
      model: "new-model",
      provider: "anthropic",
      durationMs: 200,
      success: true,
    })

    await flushMetrics()
    const [, contents] = writeFileAtomicMock.mock.calls[0]
    const lines = contents.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).model).toBe("old-model")
    expect(JSON.parse(lines[1]).model).toBe("new-model")
    vi.doUnmock("@/commands/fs")
  })
})
