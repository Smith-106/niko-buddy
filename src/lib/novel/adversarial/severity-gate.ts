/**
 * severity-gate.ts — v2.6.5 D1: 评分核心（severity + 维度清单）
 *
 * 蓝图 `docs/p0/blueprint-v265-20260826.md` D1：
 *   - severity 枚举仅 hard_block/suggestion（非法值编译报错）
 *   - degraded×severity 降级封顶：降级永不触发硬否决（封顶 ≤ 阈值-1）
 *   - 维度清单 manifest 状态机（待检→比对中→判定→可申诉→终态）
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；Draft-first
 */

// ============================================================================
// severity（D1 核心）
// ============================================================================

/** 判定严重度（仅两值——非法值编译报错）。 */
export type Severity = "hard_block" | "suggestion"

/** 降级状态。 */
export type DegradedState = "ok" | "degraded"

/** 判定结果。 */
export interface SeverityVerdict {
  severity: Severity
  degraded: DegradedState
  /** 降级封顶说明（degraded 且原判 hard_block 时必填）。 */
  cappedReason?: string
}

/**
 * severity 判定 + 降级封顶：
 *   - 正常路径：severity 由调用方给出（模型置信度/规则引擎）
 *   - 降级路径：severity 封顶为 suggestion（降级永不触发硬否决——封顶 ≤ 阈值-1）
 */
export function evaluateSeverity(rawSeverity: Severity, degraded: DegradedState): SeverityVerdict {
  if (degraded === "degraded" && rawSeverity === "hard_block") {
    return {
      severity: "suggestion",
      degraded,
      cappedReason: "降级封顶：检测降级时永不触发硬否决（封顶 ≤ 阈值-1）",
    }
  }
  return { severity: rawSeverity, degraded }
}

// ============================================================================
// 维度清单 manifest（D1 状态机）
// ============================================================================

/** 检测维度（跨模块对齐：指纹/判官/L9/anti-ai）。 */
export const DIMENSION_IDS = ["author_fingerprint", "judge_pool", "l9_gate", "anti_ai"] as const
export type DimensionId = (typeof DIMENSION_IDS)[number]

/** 维度状态（状态机）。 */
export type DimensionState = "pending" | "comparing" | "passed" | "degraded" | "blocked" | "appealable" | "final"

/** 维度条目。 */
export interface DimensionEntry {
  id: DimensionId
  /** 阈值（白话描述）。 */
  threshold: string
  /** 状态。 */
  state: DimensionState
  /** 状态说明。 */
  note?: string
}

/** 合法状态迁移表（非法迁移 throw）。 */
const TRANSITIONS: Record<DimensionState, DimensionState[]> = {
  pending: ["comparing"],
  comparing: ["passed", "degraded", "blocked"],
  passed: ["appealable", "final"],
  degraded: ["comparing", "final"],
  blocked: ["appealable"],
  appealable: ["final", "comparing"],
  final: [],
}

/** 维度清单（manifest 状态机）。 */
export class DimensionManifest {
  private entries = new Map<DimensionId, DimensionEntry>()

  constructor(initial: DimensionEntry[] = []) {
    for (const e of initial) this.entries.set(e.id, e)
  }

  /** 状态迁移（非法迁移 throw）。 */
  transition(id: DimensionId, to: DimensionState): void {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`[severity-gate] 未知维度: ${id}`)
    const allowed = TRANSITIONS[entry.state]
    if (!allowed.includes(to)) {
      throw new Error(`[severity-gate] 非法迁移: ${id} ${entry.state} → ${to}`)
    }
    entry.state = to
  }

  /** 查询维度。 */
  get(id: DimensionId): DimensionEntry | undefined {
    return this.entries.get(id)
  }

  /** 全量清单（按 DIMENSION_IDS 顺序稳定）。 */
  list(): DimensionEntry[] {
    return DIMENSION_IDS.map((id) => this.entries.get(id)).filter((e): e is DimensionEntry => e !== undefined)
  }

  /** 全维度终态判定。 */
  allFinal(): boolean {
    return this.list().every((e) => e.state === "final")
  }
}
