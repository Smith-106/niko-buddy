/**
 * status-schema.ts — v2.6.7 D3: 最小契约（status.json 双向硬校验）
 *
 * 蓝图 `docs/p0/blueprint-v267-20260828.md` D3：
 *   - 读/写双向硬失败校验（不静默 coerce）
 *   - schema v1 + 字段白名单拒未知字段
 *   - IPC 边界解析即校验
 *
 * 实现说明：手写轻量校验器（零新依赖——ADR-19 机械层；共识的 Zod 方案
 * 以纯函数等价实现，避免引入依赖）。
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；禁新建第二份状态文件
 */

// ============================================================================
// schema v1（字段白名单）
// ============================================================================

/** status.json 顶层字段白名单（schema v1——拒未知字段）。 */
export const STATUS_SCHEMA_V1_FIELDS = [
  "schemaVersion",
  "chapters",
  "memories",
  "settings",
  "updatedAt",
] as const

/** 章节字段白名单。 */
export const CHAPTER_FIELDS = ["id", "title", "status", "content", "knownBy", "revealedAt"] as const

/** 章节状态（Draft-first 状态机）。 */
export const CHAPTER_STATUSES = ["pending", "ready", "accepted"] as const

/** schema 版本。 */
export const STATUS_SCHEMA_VERSION = "status-schema-v1"

// ============================================================================
// 校验器（纯函数——读/写双向硬失败）
// ============================================================================

/** 校验结果。 */
export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * 校验 status.json 顶层（字段白名单 + 类型检查 + 未知字段拒绝）。
 * 硬失败语义：不静默 coerce——非法即报错。
 */
export function validateStatusSchema(data: unknown): SchemaValidationResult {
  const errors: string[] = []
  if (typeof data !== "object" || data === null) {
    return { valid: false, errors: ["status.json 顶层必须为对象"] }
  }
  const obj = data as Record<string, unknown>

  // 未知字段拒绝
  for (const key of Object.keys(obj)) {
    if (!(STATUS_SCHEMA_V1_FIELDS as readonly string[]).includes(key)) {
      errors.push(`未知字段: ${key}`)
    }
  }

  // schemaVersion 校验
  if (obj.schemaVersion !== STATUS_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${STATUS_SCHEMA_VERSION}（当前: ${String(obj.schemaVersion)}）`)
  }

  // chapters 校验（数组 + 每章字段白名单 + 状态机）
  if (obj.chapters !== undefined) {
    if (!Array.isArray(obj.chapters)) {
      errors.push("chapters 必须为数组")
    } else {
      for (const ch of obj.chapters as unknown[]) {
        if (typeof ch !== "object" || ch === null) {
          errors.push("章节必须为对象")
          continue
        }
        const c = ch as Record<string, unknown>
        for (const key of Object.keys(c)) {
          if (!(CHAPTER_FIELDS as readonly string[]).includes(key)) {
            errors.push(`章节未知字段: ${key}`)
          }
        }
        if (c.status !== undefined && !(CHAPTER_STATUSES as readonly string[]).includes(c.status as string)) {
          errors.push(`章节非法状态: ${String(c.status)}（必须为 pending/ready/accepted）`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 写路径校验（accept 回填前——硬失败：非法即拒绝写入）。
 * 纯函数：输入待写数据，输出是否可写。
 */
export function validateBeforeWrite(data: unknown): SchemaValidationResult {
  return validateStatusSchema(data)
}
