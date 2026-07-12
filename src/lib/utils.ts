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
