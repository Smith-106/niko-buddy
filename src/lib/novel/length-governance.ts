/**
 * R-inkos-9 (24→25 审计落地): LengthGovernance — 章节字数软硬界治理.
 *
 * 吸收来源：reference/inkos packages/core/src/models/length-governance.ts
 * （LengthSpec: target/softMin/softMax/hardMin/hardMax/countingMode；
 * LengthTelemetry: writerCount/postReviseCount/finalCount/repairApplied；
 * LengthWarning）。25 号审计 hy3 value 7：QMAI 硬编码 3000-5000 字，
 * 无可配置软硬界。
 *
 * 定位：章节字数治理的确定性引擎层——软界 warn（可过）、硬界 error（阻断），
 * 双计数模式（zh_chars 中文字符 / en_words 英文词），遥测结构供审计。
 */

export type LengthCountingMode = "zh_chars" | "en_words"

export interface LengthSpec {
  target: number
  softMin: number
  softMax: number
  hardMin: number
  hardMax: number
  countingMode: LengthCountingMode
}

export function validateLengthSpec(spec: LengthSpec): string[] {
  const errors: string[] = []
  const { target, softMin, softMax, hardMin, hardMax } = spec
  if (!(softMin <= target && target <= softMax)) {
    errors.push(`target ${target} 须落在软界 [${softMin}, ${softMax}] 内`)
  }
  if (!(hardMin <= softMin)) errors.push(`hardMin ${hardMin} 不得超过 softMin ${softMin}`)
  if (!(softMax <= hardMax)) errors.push(`softMax ${softMax} 不得超过 hardMax ${hardMax}`)
  return errors
}

/** 按计数模式统计字数：zh_chars 仅计 CJK 字符；en_words 计 ASCII 词。 */
export function countByMode(text: string, mode: LengthCountingMode): number {
  if (mode === "zh_chars") {
    return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  }
  return (text.match(/[a-zA-Z0-9]+/g) ?? []).length
}

export type LengthLevel = "within" | "soft_violation" | "hard_violation"

export interface LengthEvaluation {
  count: number
  level: LengthLevel
  /** hard 违规 → block；soft 违规 → warn；within → ok。 */
  action: "ok" | "warn" | "block"
  reason?: string
}

/**
 * 确定性字数治理：硬界外 → hard_violation/block；软界外（含在硬界内）→
 * soft_violation/warn；否则 within/ok。相同输入必产生相同输出。
 */
export function evaluateLength(text: string, spec: LengthSpec): LengthEvaluation {
  const count = countByMode(text, spec.countingMode)
  const modeLabel = spec.countingMode === "zh_chars" ? "中文字符" : "英文词"
  if (count < spec.hardMin) {
    return {
      count,
      level: "hard_violation",
      action: "block",
      reason: `${modeLabel}数 ${count} 低于硬下限 ${spec.hardMin}（不足半章量级）`,
    }
  }
  if (count > spec.hardMax) {
    return {
      count,
      level: "hard_violation",
      action: "block",
      reason: `${modeLabel}数 ${count} 超过硬上限 ${spec.hardMax}（注水超限）`,
    }
  }
  if (count < spec.softMin) {
    return {
      count,
      level: "soft_violation",
      action: "warn",
      reason: `${modeLabel}数 ${count} 低于软下限 ${spec.softMin}（偏短）`,
    }
  }
  if (count > spec.softMax) {
    return {
      count,
      level: "soft_violation",
      action: "warn",
      reason: `${modeLabel}数 ${count} 超过软上限 ${spec.softMax}（偏长）`,
    }
  }
  return { count, level: "within", action: "ok" }
}

/** 章节字数遥测（吸收 inkos LengthTelemetry 结构，供审计流水）。 */
export interface LengthTelemetry {
  chapter: number
  target: number
  countingMode: LengthCountingMode
  writerCount: number
  postReviseCount: number
  finalCount: number
  repairApplied: boolean
  lengthWarning: boolean
}

export function buildLengthTelemetry(
  chapter: number,
  spec: LengthSpec,
  counts: { writer: number; postRevise: number; final: number },
  repairApplied: boolean,
): LengthTelemetry {
  const finalEval = evaluateLengthByCount(counts.final, spec)
  return {
    chapter,
    target: spec.target,
    countingMode: spec.countingMode,
    writerCount: counts.writer,
    postReviseCount: counts.postRevise,
    finalCount: counts.final,
    repairApplied,
    lengthWarning: finalEval.action !== "ok",
  }
}

/** 仅按已知计数评估（避免重复 countByMode；供遥测/复评路径）。 */
export function evaluateLengthByCount(
  count: number,
  spec: LengthSpec,
): LengthEvaluation {
  return evaluateLengthByCountImpl(count, spec)
}

function evaluateLengthByCountImpl(
  count: number,
  spec: LengthSpec,
): LengthEvaluation {
  const modeLabel = spec.countingMode === "zh_chars" ? "中文字符" : "英文词"
  if (count < spec.hardMin) {
    return { count, level: "hard_violation", action: "block", reason: `${modeLabel}数 ${count} 低于硬下限 ${spec.hardMin}` }
  }
  if (count > spec.hardMax) {
    return { count, level: "hard_violation", action: "block", reason: `${modeLabel}数 ${count} 超过硬上限 ${spec.hardMax}` }
  }
  if (count < spec.softMin) {
    return { count, level: "soft_violation", action: "warn", reason: `${modeLabel}数 ${count} 低于软下限 ${spec.softMin}` }
  }
  if (count > spec.softMax) {
    return { count, level: "soft_violation", action: "warn", reason: `${modeLabel}数 ${count} 超过软上限 ${spec.softMax}` }
  }
  return { count, level: "within", action: "ok" }
}
