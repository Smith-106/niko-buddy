// Copyright (c) 2024 Niko-hub contributors. MIT License.

// M13-1 slice of lib/llm-client.ts: LLM + continuity metrics buffering.
// Pure logic (buffer/collect/flush); re-exported verbatim from llm-client
// so every existing import path, symbol name and signature stays compatible.

import { toErrorMessage } from "@/lib/utils"

/**
 * 单次请求的 prompt 缓存诊断。
 *
 * `startGapMs` / `idleGapMs` 是判定「缓存本该命中还是已过期」的关键：
 * 同一 prefixFingerprint 的两次请求，若 idleGapMs 小于厂商缓存 TTL
 * （Anthropic 默认 5 分钟），则本次应命中；否则缓存已过期，cacheReadTokens
 * 为 0 属预期而非异常。没有这两个值就无法区分「缓存没命中」与「缓存本就过期」。
 */
export interface LlmCacheDiagnostics {
  /** 可缓存前缀（到最后一个 cache_control 断点）的 SHA-256。 */
  prefixFingerprint?: string
  /** 该前缀的估算 token 数（决定是否达到厂商的最小可缓存长度）。 */
  prefixEstimatedTokens?: number
  /** 首 token 到达耗时；缓存命中时应显著低于未命中。 */
  firstResponseMs?: number
  /** 命中缓存的输入 token。 */
  cacheReadTokens?: number
  /** 写入缓存的输入 token（Anthropic 首次写入有溢价）。 */
  cacheWriteTokens?: number
  /** 与上一次同前缀请求的起始间隔。 */
  startGapMs?: number
  /** 与上一次同前缀请求结束的空闲间隔（判断 TTL 是否过期用这个）。 */
  idleGapMs?: number
}

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
  cache?: LlmCacheDiagnostics
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

/** 测试用：读取当前未落盘的 metric 缓冲（镜像 __clearMetricsBufferForTest）。 */
export function __peekMetricsBufferForTest(): readonly LlmMetric[] {
  return metricsBuffer
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
