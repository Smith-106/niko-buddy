// Copyright (c) 2024 Niko-hub contributors. MIT License.

// M13-1 slice of lib/llm-client.ts: LLM + continuity metrics buffering.
// Pure logic (buffer/collect/flush); re-exported verbatim from llm-client
// so every existing import path, symbol name and signature stays compatible.

import { toErrorMessage } from "@/lib/utils"

export interface LlmMetric {
  ts: string
  model: string
  provider: string
  durationMs: number
  success: boolean
  errorKind?: string
  traceId?: string
  inputTokens?: number
  outputTokens?: number
}

let metricsFilePath = ""
let metricsTraceId = ""
const metricsBuffer: LlmMetric[] = []

export function setMetricsFilePath(path: string): void {
  metricsFilePath = path
}

export function setMetricsTraceId(id: string): void {
  metricsTraceId = id
}

export function collectLLMMetric(metric: LlmMetric): void {
  metricsBuffer.push({ ...metric, traceId: metric.traceId ?? metricsTraceId })
  if (metricsBuffer.length >= 500 && metricsFilePath) {
    void flushMetrics()
  }
}

export function __clearMetricsBufferForTest(): void {
  metricsBuffer.length = 0
}

export async function flushMetrics(): Promise<number> {
  if (!metricsFilePath || metricsBuffer.length === 0) return 0
  const toFlush = metricsBuffer.splice(0, metricsBuffer.length)
  try {
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    let existing = ""
    try {
      existing = await readFile(metricsFilePath)
    } catch {
      existing = ""
    }
    const lines = toFlush.map(m => JSON.stringify(m)).join("\n")
    const next = existing ? existing.replace(/\n?$/, "\n") + lines + "\n" : lines + "\n"
    await writeFileAtomic(metricsFilePath, next)
    return toFlush.length
  } catch (e) {
    console.error("[metrics] flush failed:", toErrorMessage(e))
    if (metricsBuffer.length < 1000) metricsBuffer.unshift(...toFlush)
    return 0
  }
}

export interface ContinuityMetric {
  execution_ms: number
  critical_count: number
  high_count: number
  warning_count: number
  data_gap_count: number
  overrides_hit: number
  short_circuit_hits: number
  engine_error_count: number
  gate: "consistency" | "quality" | "anti_ai"
  timestamp: string
}

let continuityMetricsFilePath = ""
const continuityMetricBuffer: ContinuityMetric[] = []

export function setContinuityMetricsFilePath(path: string): void {
  continuityMetricsFilePath = path
}

export function __clearContinuityMetricsBufferForTest(): void {
  continuityMetricBuffer.length = 0
}

export function collectContinuityMetric(metric: ContinuityMetric): void {
  continuityMetricBuffer.push(metric)
  if (continuityMetricBuffer.length >= 500 && continuityMetricsFilePath) {
    void flushContinuityMetrics()
  }
}

export async function flushContinuityMetrics(): Promise<number> {
  if (!continuityMetricsFilePath || continuityMetricBuffer.length === 0) return 0
  const toFlush = continuityMetricBuffer.splice(0, continuityMetricBuffer.length)
  try {
    const { readFile, writeFileAtomic } = await import("@/commands/fs")
    let existing = ""
    try {
      existing = await readFile(continuityMetricsFilePath)
    } catch {
      existing = ""
    }
    const lines = toFlush.map(m => JSON.stringify(m)).join("\n")
    const next = existing ? existing.replace(/\n?$/, "\n") + lines + "\n" : lines + "\n"
    await writeFileAtomic(continuityMetricsFilePath, next)
    return toFlush.length
  } catch (e) {
    console.error(
      "[continuity-metrics] flush failed:",
      toErrorMessage(e),
    )
    if (continuityMetricBuffer.length < 1000) continuityMetricBuffer.unshift(...toFlush)
    return 0
  }
}
