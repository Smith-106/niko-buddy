/**
 * canon-editor.ts — TASK-P4-29b (T29b): canon 写路径编辑（known_by/revealed_at 人工校正）
 *
 * 蓝图 §6 P4 T29b（F-01 / A-22.6）：
 *   canon 写路径编辑 UI 的纯函数逻辑层——known_by（谁知晓该事实）/ revealed_at
 *   （揭示章节）人工校正。本模块只做「校正请求 → 写路径命令」的纯函数转换与校验，
 *   UI 组件消费本模块；不直接触碰 canon 内部句柄（canon-graph-client 读出口契约：
 *   含 known_by/digest 即抛错——校正经 canon-dual-write 写路径 op 下发，句柄不外泄）。
 *
 * 执行纪律:
 *   - ADR-19 机械层零 LLM：纯函数，零 IO / 零 Tauri invoke。
 *   - Draft-first (ADR-08)：不写入运行时会话状态文件。
 *   - 写路径契约：校正 op 走 canon-dual-write（supersede_by_digest），
 *     幂等键 digest 由调用方/写路径派生，本模块不生成。
 */
import type { CanonDualWriteOp } from "./canon-dual-write"

// ============================================================================
// 类型定义
// ============================================================================

/** 认知轴角色（known_by 合法取值；与 canon 认知轴角色枚举对齐）。 */
export const KNOWN_BY_ROLES = ["protagonist", "antagonist", "narrator", "supporting", "unknown"] as const
export type KnownByRole = (typeof KNOWN_BY_ROLES)[number]

/** 人工校正请求（UI 表单 → 本模块）。 */
export interface KnownByCorrection {
  /** 目标事实幂等键（digest）。 */
  factDigest: string
  /** 校正后知晓角色集合。 */
  knownBy: KnownByRole[]
  /** 校正后揭示章节（≥1；单调性校验）。 */
  revealedAt: number
  /** 校正原因（审计）。 */
  reason: string
}

/** 校正校验结果。 */
export interface CorrectionValidation {
  ok: boolean
  errors: string[]
}

/** 校正 op 产物（写路径命令 + 审计元数据）。 */
export interface CorrectionOpResult {
  op: CanonDualWriteOp
  audit: {
    factDigest: string
    knownBy: KnownByRole[]
    revealedAt: number
    reason: string
  }
}

// ============================================================================
// 校验（纯函数）
// ============================================================================

/**
 * 校验校正请求：
 *   - knownBy 角色合法性（KNOWN_BY_ROLES 枚举）
 *   - knownBy 非空（至少一个知晓者）
 *   - revealedAt ≥ 1（章节从 1 起）
 *   - reason 非空（审计要求）
 */
export function validateCorrection(correction: KnownByCorrection): CorrectionValidation {
  const errors: string[] = []
  if (!correction.factDigest || correction.factDigest.length < 8) {
    errors.push("factDigest 缺失或过短（幂等键 ≥8 字符）")
  }
  if (correction.knownBy.length === 0) {
    errors.push("knownBy 不能为空（至少一个知晓者）")
  }
  for (const role of correction.knownBy) {
    if (!KNOWN_BY_ROLES.includes(role)) {
      errors.push(`knownBy 角色非法: ${role}（合法: ${KNOWN_BY_ROLES.join("/")}）`)
    }
  }
  if (!Number.isInteger(correction.revealedAt) || correction.revealedAt < 1) {
    errors.push("revealedAt 必须为 ≥1 的整数章节号")
  }
  if (!correction.reason || correction.reason.trim().length === 0) {
    errors.push("reason 不能为空（审计要求）")
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 单调性校验：校正后的 revealedAt 不得早于当前揭示章节（防回退）。
 * 返回 ok=false 时给出建议（当前值）。
 */
export function validateMonotonicReveal(correction: KnownByCorrection, currentRevealedAt: number): CorrectionValidation {
  const base = validateCorrection(correction)
  if (!base.ok) return base
  if (correction.revealedAt < currentRevealedAt) {
    return {
      ok: false,
      errors: [`revealedAt 回退: ${correction.revealedAt} < 当前 ${currentRevealedAt}（揭示章节只进不退）`],
    }
  }
  return { ok: true, errors: [] }
}

// ============================================================================
// 校正 op 构建（纯函数 → 写路径命令）
// ============================================================================

/**
 * 构建校正写路径 op（supersede_by_digest：以新 digest 取代旧事实，携带校正字段）。
 * 不直接改内部句柄——校正内容经 canonPayload 下发，由 canon 侧写路径落库。
 */
export function buildCorrectionOp(correction: KnownByCorrection): CorrectionOpResult {
  const validation = validateCorrection(correction)
  if (!validation.ok) {
    throw new Error(`[canon-editor] 校正请求非法: ${validation.errors.join("; ")}`)
  }
  const op: CanonDualWriteOp = {
    legacyPayload: {
      kind: "known_by_correction",
      factDigest: correction.factDigest,
      knownBy: correction.knownBy,
      revealedAt: correction.revealedAt,
      reason: correction.reason,
    },
    canonPayload: {
      kind: "supersede_by_digest",
      request: {
        oldDigest: correction.factDigest,
        capChapter: correction.revealedAt,
        newDigest: correction.factDigest,
        knownBy: correction.knownBy,
        revealedAt: correction.revealedAt,
        causedBy: `canon-editor:${correction.reason}`,
      },
    },
  }
  return {
    op,
    audit: {
      factDigest: correction.factDigest,
      knownBy: [...correction.knownBy],
      revealedAt: correction.revealedAt,
      reason: correction.reason,
    },
  }
}

/**
 * 纯函数应用校正到事实投影（UI 预览用；不落库）。
 * fact 为只读投影（不含内部句柄——读出口契约），返回校正后投影。
 */
export function applyCorrectionToFact<T extends { knownBy?: KnownByRole[]; revealedAt?: number }>(
  fact: T,
  correction: KnownByCorrection,
): T {
  return {
    ...fact,
    knownBy: [...correction.knownBy],
    revealedAt: correction.revealedAt,
  }
}
