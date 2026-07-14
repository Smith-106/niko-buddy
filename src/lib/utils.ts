import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 数字补零到两位（如 1 → "01"）。通用格式化 helper。
 * 局部 padStart(2,"0") 同形变体（chapter-backup/trash 局部 const arrow）未合并——作用域不同。
 */
export function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/**
 * 错误对象 → message 字符串安全归一（PAT-DC1 脱敏核心实现，非 LLM 路径同形）。
 * error instanceof Error ? error.message : String(error)
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 字符串数组去重 + trim + 过滤空值。
 */
export function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

/**
 * 严重度枚举校验：合法值原样返回，非法回退 "warning"。
 * 含 lint 域 validateLintSeverity 同形（已合并）。
 */
export function validateSeverity(value: unknown): "error" | "warning" | "info" {
  if (value === "error" || value === "warning" || value === "info") return value
  return "warning"
}

/**
 * ISS-20260709-019: lightweight structured logger.
 *
 * Replaces scattered `console.error("[Module] msg:", err.message)` calls with
 * a uniform shape that carries level + scope + trace-id + optional context.
 * Single-user desktop app ⇒ no concurrent traces, so a module-level traceId
 * is safe (set once per session/run, threaded implicitly — NOT passed as a
 * param across 63 sites, which would violate minimize-changes).
 *
 * Output: human-readable console line by default (`[scope] message context`);
 * when NOVEL_LOG_JSON=1, emits one JSON line per call to stderr instead
 * ({ts, level, scope, traceId, message, context}) for machine consumption.
 *
 * PAT-DC1 (CWE-532): callers MUST pass already-sanitized `message` strings
 * and a `context` map with no provider credentials — this logger does NOT
 * introspect Error objects (unlike the prior `console.error(..., err)` shape
 * that could dump request URLs/headers). Use `toErrorMessage(err)` upstream.
 *
 * NOT a second truth source — status.json remains the only runtime session
 * truth. Logs are derived observability; metrics (ISS-20260709-020) live in
 * llm-client.ts.
 */
export type LogLevel = "error" | "warn" | "info"

let logTraceId = ""

/** Set the trace-id for the current run (e.g. a chapter-generation run id). */
export function setLogTraceId(id: string): void {
  logTraceId = id
}

/** Current trace-id (empty string when unset). */
export function getLogTraceId(): string {
  return logTraceId
}

function isLogJson(): boolean {
  return typeof process !== "undefined" && !!process.env && !!process.env.NOVEL_LOG_JSON
}

function emitLog(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void {
  const traceId = logTraceId
  if (isLogJson()) {
    // JSON line to stderr — machine-consumable, one object per call.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope,
      traceId,
      message,
      context: context ?? {},
    })
    // eslint-disable-next-line no-console
    console.error(line)
    return
  }
  const ctx = context && Object.keys(context).length > 0
    ? " " + JSON.stringify(context)
    : ""
  // eslint-disable-next-line no-console
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info
  fn(`[${scope}]${traceId ? ` [${traceId}]` : ""} ${message}${ctx}`)
}

export const logger = {
  error(scope: string, message: string, context?: Record<string, unknown>): void {
    emitLog("error", scope, message, context)
  },
  warn(scope: string, message: string, context?: Record<string, unknown>): void {
    emitLog("warn", scope, message, context)
  },
  info(scope: string, message: string, context?: Record<string, unknown>): void {
    emitLog("info", scope, message, context)
  },
}
