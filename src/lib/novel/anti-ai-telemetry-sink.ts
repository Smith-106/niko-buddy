/**
 * anti-ai-telemetry-sink.ts — #34 反 AI 遥测 JSONL Sink
 *
 * 冻结规格: docs/p6/anti-ai-telemetry-sink-spec.md（三模型共识设计 ox/flash/hy3，2026-08-23）
 *
 * 定位: 生产调用方层 fire-and-forget 诊断工件，非会话状态真源（守 ADR-16/HARD-1）。
 *      链内落盘违反 ADR-08/19，故 sink 只在生产调用方层、只经显式同意（F-34 默认关）启动。
 *
 * 隐私口径 CWE-532: 白名单序列化（禁 spread 整报告）、不带正文/finding.message 全文/
 *      slop tier3 关键词词表/LLM err.message；行内不嵌绝对路径与项目名。
 *
 * 安全边界: 本模块**只做 type-only 导入**（anti-ai-candidate-pool 运行时依赖 node:fs，
 *      renderer 直连会运行时失败 —— ISS-020 同类地雷）。绝不 import AntiAiCandidatePool 运行时符号。
 *
 * 激活前置: 本模块本身可独立开发/契约测试；记录生效还需 T24-01 生产接线向调用方暴露
 *      memo 报告（onPoolReport 回调）。未接线前 sink 模块单例保持关闭、零 IO 零内存。
 */
import type { AntiAiAnalysisReport, AntiAiTextOrigin } from "./anti-ai-candidate-pool"
import type { SlopReport } from "./mechanical-slop-detector"
import type { AntiAiMode } from "./novel-session-status"
import type { GateVerdict } from "./rule-stack"

// ── 常量（规格 §1/§3） ──────────────────────────────────────────────────────
export const TELEMETRY_SCHEMA_VERSION = "qm-anti-ai-telemetry/1.0" as const
export const TELEMETRY_FLUSH_BATCH = 32
export const TELEMETRY_FLUSH_INTERVAL_MS = 60_000
export const TELEMETRY_SEGMENT_MAX_BYTES = 1_000_000
export const TELEMETRY_RETENTION_DAYS = 90
const SEGMENT_DIR_NAME = "telemetry/anti-ai"

// ── 行 schema 类型（规格 §2；白名单投影，禁 spread） ─────────────────────────
export interface TelemetryFactorRow {
  readonly factor: string
  readonly value: number
  readonly threshold: number
  readonly warn: boolean
  readonly unit?: "bits" | "normalized"
  readonly rawValue?: number
  readonly bucketCount?: number
}

export interface TelemetryTextMeta {
  readonly chars: number
  readonly paragraphs: number
  readonly sentences: number
}

export interface TelemetrySlopAgg {
  readonly tier3ClassCount: number
  readonly tier3HitCount: number
  readonly penalty: number
}

export interface AntiAiTelemetryLine {
  readonly v: typeof TELEMETRY_SCHEMA_VERSION
  readonly type: "pool_report"
  readonly ts: string
  readonly chapter: number
  readonly origin: AntiAiTextOrigin
  readonly factors: readonly TelemetryFactorRow[]
  readonly hasWarnings: boolean
  readonly warningCount: number
  readonly textMeta: TelemetryTextMeta
  readonly windowIndex?: number
  readonly windowCharOffset?: number
  readonly antiAiMode?: AntiAiMode
  readonly gateVerdict?: GateVerdict
  readonly slopAgg?: TelemetrySlopAgg
  readonly sessionId?: string
  readonly projectId?: string
}

/** 触发上下文。text 仅用于本地即时派生计数，sink 不持有字符串引用（隐私）。 */
export interface PoolReportContext {
  readonly chapter: number
  readonly text: string
  readonly sessionId: string
  readonly projectId?: string
  readonly windowIndex?: number
  readonly windowCharOffset?: number
  readonly antiAiMode?: AntiAiMode
  readonly gateVerdict?: GateVerdict
  readonly slopReport?: SlopReport
}

// ── 依赖注入（结构镜像 StageJournalDeps） ────────────────────────────────────
export interface TelemetrySinkDeps {
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, contents: string) => Promise<void>
  readonly createDirectory: (path: string) => Promise<void>
  readonly deleteFile?: (path: string) => Promise<void>
  readonly listFiles?: (dir: string) => Promise<readonly string[]>
  readonly now: () => Date
}

// ── 纯函数助手 ──────────────────────────────────────────────────────────────
/** 缺省归一 unknown（规格 §2）；调用方可能传 undefined（消费侧统一口径）。 */
export function normalizeOrigin(origin?: AntiAiTextOrigin): AntiAiTextOrigin {
  if (origin === "ai_draft" || origin === "user_text") return origin
  return "unknown"
}

/** 纯计数派生：字数 / 段数（非空行）/ 句数（。？！）。绝不持有正文引用。 */
export function computeTextMeta(text: string): TelemetryTextMeta {
  const chars = text.length
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0).length
  const sentences = (text.match(/[。？！!?]/g) ?? []).length
  return { chars, paragraphs, sentences }
}

/** SlopReport → 仅计数聚合；kw 词表一律丢弃（规格 §4.2）。 */
export function buildSlopAgg(report: SlopReport): TelemetrySlopAgg {
  const tier3ClassCount = report.tier3Hits?.length ?? 0
  const tier3HitCount = (report.tier3Hits ?? []).reduce((s, h) => s + (h.count ?? 0), 0)
  return { tier3ClassCount, tier3HitCount, penalty: report.slopPenalty ?? 0 }
}

/** 因子白名单投影：StatisticalFactorReport → TelemetryFactorRow（丢 description 自由文本）。 */
function projectFactors(report: AntiAiAnalysisReport): readonly TelemetryFactorRow[] {
  return report.factors.map((f) => {
    const row: TelemetryFactorRow = {
      factor: f.factor,
      value: f.value,
      threshold: f.threshold,
      warn: f.warn,
      ...(f.unit !== undefined ? { unit: f.unit } : {}),
      ...(f.rawValue !== undefined ? { rawValue: f.rawValue } : {}),
      ...(f.bucketCount !== undefined ? { bucketCount: f.bucketCount } : {}),
    }
    return row
  })
}

/** 逐字段构建行对象（禁 spread 整报告）；序列化为 JSON 字符串。 */
export function serializePoolReportLine(
  report: AntiAiAnalysisReport,
  ctx: PoolReportContext,
  deps: TelemetrySinkDeps,
): string {
  const line: AntiAiTelemetryLine = {
    v: TELEMETRY_SCHEMA_VERSION,
    type: "pool_report",
    ts: deps.now().toISOString(),
    chapter: ctx.chapter,
    origin: normalizeOrigin(report.origin),
    factors: projectFactors(report),
    hasWarnings: report.hasWarnings,
    warningCount: report.warningCount,
    textMeta: computeTextMeta(ctx.text),
    ...(ctx.windowIndex !== undefined ? { windowIndex: ctx.windowIndex } : {}),
    ...(ctx.windowCharOffset !== undefined ? { windowCharOffset: ctx.windowCharOffset } : {}),
    ...(ctx.antiAiMode !== undefined ? { antiAiMode: ctx.antiAiMode } : {}),
    ...(ctx.gateVerdict !== undefined ? { gateVerdict: ctx.gateVerdict } : {}),
    ...(ctx.slopReport !== undefined ? { slopAgg: buildSlopAgg(ctx.slopReport) } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
  }
  return JSON.stringify(line)
}

// ── 路径/命名（规格 §1） ────────────────────────────────────────────────────
import { resolve, dirname, join } from "node:path"

export function antiAiTelemetryDir(projectPath: string): string {
  return resolve(projectPath, ".novel", SEGMENT_DIR_NAME)
}

export function segmentFileName(dayUtc: string, sessionId: string, seq: number): string {
  const sid8 = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).padStart(8, "0")
  return `aa-${dayUtc}-${sid8}-${String(seq).padStart(3, "0")}.jsonl`
}

function dayUtcOf(deps: TelemetrySinkDeps): string {
  return deps.now().toISOString().slice(0, 10)
}

/** 保留期清理：删早于 N 天的段文件；deps 缺省时跳过。 */
export async function pruneExpiredSegments(
  dir: string,
  now: Date,
  deps: TelemetrySinkDeps,
  retentionDays = TELEMETRY_RETENTION_DAYS,
): Promise<number> {
  if (!deps.listFiles || !deps.deleteFile) return 0
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  let removed = 0
  for (const name of await deps.listFiles(dir)) {
    // 段名 aa-YYYYMMDD-...：日期前缀 > retention 即过期
    const m = /^aa-(\d{4})(\d{2})(\d{2})-/.exec(name)
    if (!m) continue
    const segDate = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
    if (segDate < cutoff) {
      try {
        await deps.deleteFile(join(dir, name))
        removed++
      } catch {
        /* 非致命 */
      }
    }
  }
  return removed
}

// ── Sink 实现 ──────────────────────────────────────────────────────────────
export interface AntiAiTelemetrySink {
  recordPoolReport(report: AntiAiAnalysisReport, ctx: PoolReportContext): void
  flush(): Promise<void>
  dispose(): Promise<void>
  currentSegmentPath(): string | null
}

interface SegmentState {
  path: string
  lines: string[]
  approxBytes: number
}

export function createAntiAiTelemetrySink(
  projectPath: string,
  sessionId: string,
  deps?: Partial<TelemetrySinkDeps>,
): AntiAiTelemetrySink {
  const d: TelemetrySinkDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    createDirectory: async () => {},
    now: () => new Date(),
    ...deps,
  }
  const dir = antiAiTelemetryDir(projectPath)
  let segment: SegmentState | null = null
  const pendingFlush = { current: null as Promise<void> | null }

  function newSegment(): SegmentState {
    const day = dayUtcOf(d)
    let seq = 0
    // 段序号：同日同会话已有多少段（防御性重建时按文件推断）
    const s: SegmentState = { path: join(dir, segmentFileName(day, sessionId, seq)), lines: [], approxBytes: 0 }
    return s
  }

  function ensureSegment(): SegmentState {
    if (!segment) segment = newSegment()
    return segment
  }

  async function doFlush(): Promise<void> {
    if (!segment || segment.lines.length === 0) return
    const seg = segment
    try {
      await d.createDirectory(dir)
      const body = seg.lines.join("\n") + "\n"
      await d.writeFile(seg.path, body)
    } catch {
      // 非致命（审计投影先例）：写失败丢缓冲尾，遥测非真源可接受
      // 此处不 rethrow，调用方 fire-and-forget
    }
  }

  // single-flight：并发 burst 下最多一个 flush 在飞
  async function singleFlightFlush(): Promise<void> {
    if (pendingFlush.current) return pendingFlush.current
    const p = doFlush().finally(() => {
      pendingFlush.current = null
    })
    pendingFlush.current = p
    return p
  }

  let timer: ReturnType<typeof setInterval> | null = null

  return {
    recordPoolReport(report, ctx) {
      const seg = ensureSegment()
      const line = serializePoolReportLine(report, ctx, d)
      seg.lines.push(line)
      seg.approxBytes += line.length + 1
      // 轮转：段超 1MB 立即 flush 并开新段
      if (seg.approxBytes >= TELEMETRY_SEGMENT_MAX_BYTES) {
        void singleFlightFlush().then(() => {
          segment = newSegment()
        })
      }
      // 满 batch 立即 flush
      if (seg.lines.length >= TELEMETRY_FLUSH_BATCH) {
        void singleFlightFlush().then(() => {
          if (segment) segment.lines = []
        })
      }
      // 惰性启动定时 flush
      if (!timer && typeof setInterval !== "undefined") {
        timer = setInterval(() => {
          void singleFlightFlush()
        }, TELEMETRY_FLUSH_INTERVAL_MS)
        if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
          ;(timer as { unref: () => void }).unref()
        }
      }
    },
    flush() {
      return singleFlightFlush()
    },
    async dispose() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await singleFlightFlush()
      // 退出时清理过期段（best-effort）
      try {
        await pruneExpiredSegments(dir, d.now(), d)
      } catch {
        /* 非致命 */
      }
    },
    currentSegmentPath() {
      return segment?.path ?? null
    },
  }
}

// ── 模块级薄壳（F-34 默认关：未 init = 关 = 零 IO 零内存） ─────────────────
let activeSink: AntiAiTelemetrySink | null = null

/** 仅显式同意后调用（F-34 口径：本地匿名 + 默认关 + 显式同意）。 */
export function initAntiAiTelemetrySink(
  projectPath: string,
  sessionId: string,
  deps?: Partial<TelemetrySinkDeps>,
): AntiAiTelemetrySink {
  activeSink = createAntiAiTelemetrySink(projectPath, sessionId, deps)
  return activeSink
}

/** null = 开关关（未初始化）；调用方据此短路。 */
export function getAntiAiTelemetrySink(): AntiAiTelemetrySink | null {
  return activeSink
}

/** 薄壳记录：未初始化时 no-op（默认关契约的运行时保证）。 */
export function recordPoolReport(report: AntiAiAnalysisReport, ctx: PoolReportContext): void {
  activeSink?.recordPoolReport(report, ctx)
}

/** 会话退出挂点（Tauri onCloseRequested / beforeunload）。 */
export async function shutdownAntiAiTelemetrySink(): Promise<void> {
  if (!activeSink) return
  await activeSink.dispose()
  activeSink = null
}

/** 仅测试用：重置模块单例（复位 F-34 关态）。 */
export function __resetAntiAiTelemetrySinkForTest(): void {
  activeSink = null
}

export { dirname }
