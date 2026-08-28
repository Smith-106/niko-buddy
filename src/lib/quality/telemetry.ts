/**
 * telemetry.ts — v2.6.7 D2: 最小埋点（3 事件 jsonl 独立通道）
 *
 * 蓝图 `docs/p0/blueprint-v267-20260828.md` D2：
 *   - 3 事件钉死（app_launch/gen_done/crash——不混章节保存）
 *   - .novel/telemetry/ 独立 jsonl（append-only 单 writer——10MB 滚动）
 *   - 异步写零 await（Rust tokio::spawn 语义——TS 侧 fire-and-forget）
 *   - 隐私开关 invoke 前 gate（防 Rust 直写绕过）
 *   - 埋点产出不参加 Track A 硬门判定
 *
 * 执行纪律: ADR-19 零 LLM；埋点只读观测不写草稿；禁模拟数据
 */

// ============================================================================
// 埋点事件（3 事件钉死——不混章节保存）
// ============================================================================

/** 埋点事件类型（钉死 3 种——扩展需走契约门控）。 */
export type TelemetryEventType = "app_launch" | "gen_done" | "crash"

/** 埋点事件记录。 */
export interface TelemetryEvent {
  type: TelemetryEventType
  /** ISO 时间戳。 */
  ts: string
  /** 事件负载（轻量——不含正文内容防 PII）。 */
  payload: Record<string, string | number | boolean>
}

/** 事件类型白名单（拒未知类型）。 */
export const TELEMETRY_EVENT_TYPES: readonly TelemetryEventType[] = ["app_launch", "gen_done", "crash"]

/** 事件类型校验（拒未知类型——防 PII 泄漏面）。 */
export function validateTelemetryEvent(event: TelemetryEvent): string[] {
  const errors: string[] = []
  if (!TELEMETRY_EVENT_TYPES.includes(event.type)) errors.push(`未知事件类型: ${event.type}`)
  if (!event.ts || event.ts.length === 0) errors.push("ts 不能为空")
  if (!event.payload || typeof event.payload !== "object") errors.push("payload 必须为对象")
  return errors
}

// ============================================================================
// jsonl 序列化（append-only 单 writer——10MB 滚动）
// ============================================================================

/** 滚动阈值（10MB）。 */
export const TELEMETRY_ROLL_BYTES = 10 * 1024 * 1024

/** 序列化事件为 jsonl 行（纯函数——单行 JSON）。 */
export function serializeTelemetryLine(event: TelemetryEvent): string {
  return JSON.stringify(event) + "\n"
}

/**
 * 滚动判定：当前文件大小超阈值即滚动（纯函数）。
 * 返回新文件名（滚动）或 null（继续追加）。
 */
export function shouldRoll(currentSizeBytes: number, maxBytes = TELEMETRY_ROLL_BYTES): boolean {
  return currentSizeBytes >= maxBytes
}

/** 滚动文件名（时间戳后缀——纯函数）。 */
export function rollFileName(base: string, ts: string): string {
  return `${base}.${ts.replace(/[:.]/g, "-")}`
}

// ============================================================================
// 隐私开关（invoke 前 gate——防 Rust 直写绕过）
// ============================================================================

/** 隐私开关状态。 */
export type TelemetryPrivacy = "enabled" | "disabled"

/**
 * 隐私门：invoke 前检查（非仅 UI 层——防 Rust 直写绕过）。
 * 纯函数：输入开关状态，输出是否允许采集。
 */
export function privacyGate(privacy: TelemetryPrivacy): boolean {
  return privacy === "enabled"
}

/** 埋点产出不参加 Track A 硬门判定（固定声明——防误读为门控）。 */
export const TELEMETRY_TRACK_BOUNDARY = {
  track: "Track B 诊断 / Track L9 评分输入",
  excluded: "不进入 Track A 硬门判定（Consistency/Anti-AI/机械门）",
} as const
