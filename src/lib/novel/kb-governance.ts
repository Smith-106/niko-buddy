/**
 * kb-governance.ts — 三安全不变量 + DimensionCoord 27 格坐标（E-06 / F-006，双库架构蓝图）。
 *
 * ## 职责（GOV-OBS-05 / GOV-EVAL-08 / GOV-REV-02/06）
 *   - 三安全不变量（fold_atomic_fsync / tech_visible_to_agent /
 *     promotion_require_accept）MUST NOT 可被运行时关闭：冻结常量 + 任何
 *     override 键 → throw + 无 setter 导出面（不设 flag，与可逆 flag 族刻意区分）。
 *   - DimensionCoord 27 格机器可读 schema（G-8）：Space ∈ {Coupled,Buffered,
 *     Decoupled} × Time ∈ {Sync,Async,Replay} × Trust ∈ {Fixed,Tunable,Sovereign}；
 *     coordIndex 双射（0..26）；E06_FEATURE_IDS 注册表完备性（验收 7 机器化：
 *     新增特性忘声明坐标即 spec 红灯）。
 *   - 晋升桥仅沿 Time 轴移动（assertBridgeTimeOnlyMove，E-05 记法分歧收口：
 *     归一为 (Decoupled, Sync, Sovereign)，hy3 F-1 建议采纳）。
 *
 * ## 边界与纪律
 *   - 纯数据 + 纯函数：零 IO、零写句柄；注册表可重建。
 *   - 不变量刻意不可逆（这是不变量定义本身）；可逆性只覆盖非安全特性。
 *
 * ## DimensionCoord（SA-05 / GOV-REV-02，E-06 共识 C-10）
 *   (Coupled, Sync, Fixed)：与运行时启动耦合（启动自检）；同步强制。
 *
 * 遵循 QMAI/CLAUDE.md：E-06 新增锚点（2026-09-04 三模型共识），落 `src/lib/novel/`。
 */

import { z } from "zod"

// ──────────────────────────────────────────────────────────────────────────
// 三安全不变量（GOV-OBS-05 / GOV-EVAL-08）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 三安全不变量（MUST NOT 可被运行时关闭）。
 * 布尔值即语义：tech_visible_to_agent 恒 false（tech 结构性缺席由数据面保证 +
 * assertNoTechLeak 兜底，E-02）。
 */
export const SAFETY_INVARIANTS = Object.freeze({
  /** fold 写路径必须经 createAtomicJsonStore/writeFileAtomic（temp+fsync+rename） */
  fold_atomic_fsync: true,
  /** tech 对写作 Agent 不可见（routing.agent 无 tech + assertNoTechLeak 常驻） */
  tech_visible_to_agent: false,
  /** 晋升必有 accept 凭证（evaluateGate 无 bypass） */
  promotion_require_accept: true,
} as const)

export type SafetyInvariantName = keyof typeof SAFETY_INVARIANTS

/** override 配置 schema：任何键（含三不变量名）→ parse 抛错（GOV-OBS-05）。 */
export const GOV_INVARIANT_OVERRIDE_SCHEMA = z.object({}).strict()

/**
 * 断言不变量未被关闭：任何配置试图覆盖三不变量 → throw fail-loud。
 * 空对象通过；含任意键（含未知键）→ 抛错。
 */
export function assertInvariantsNotDisabled(config: unknown): void {
  GOV_INVARIANT_OVERRIDE_SCHEMA.parse(config)
}

// ──────────────────────────────────────────────────────────────────────────
// DimensionCoord 27 格坐标（GOV-REV-02/06，G-8）
// ──────────────────────────────────────────────────────────────────────────

export const SPACE_AXIS = z.enum(["Coupled", "Buffered", "Decoupled"])
export const TIME_AXIS = z.enum(["Sync", "Async", "Replay"])
export const TRUST_AXIS = z.enum(["Fixed", "Tunable", "Sovereign"])

export type SpaceAxis = z.infer<typeof SPACE_AXIS>
export type TimeAxis = z.infer<typeof TIME_AXIS>
export type TrustAxis = z.infer<typeof TRUST_AXIS>

/** 27 格坐标（GOV-REV-02）。 */
export const DIMENSION_COORD_SCHEMA = z.object({
  featureId: z.string().min(1),
  space: SPACE_AXIS,
  time: TIME_AXIS,
  trust: TRUST_AXIS,
  reversibility: z.object({
    mechanism: z.enum(["flag", "replay", "rebuild", "seed-lock"]),
    /** 具体可执行的回滚步骤（验收 7 强制非空） */
    rollbackPath: z.string().min(1),
    /** G-6 可逆性可验证度量（重建时间/空间上界，[需校准]） */
    slaNote: z.string().optional(),
  }),
})
export type DimensionCoord = z.infer<typeof DIMENSION_COORD_SCHEMA>

const SPACE_ORDER: Record<SpaceAxis, number> = { Coupled: 0, Buffered: 1, Decoupled: 2 }
const TIME_ORDER: Record<TimeAxis, number> = { Sync: 0, Async: 1, Replay: 2 }
const TRUST_ORDER: Record<TrustAxis, number> = { Fixed: 0, Tunable: 1, Sovereign: 2 }

/** 27 格编码（0..26，双射）。 */
export function coordIndex(c: Pick<DimensionCoord, "space" | "time" | "trust">): number {
  return SPACE_ORDER[c.space] * 9 + TIME_ORDER[c.time] * 3 + TRUST_ORDER[c.trust]
}

/** 27 格解码（双射逆）。 */
export function coordFromIndex(index: number): { space: SpaceAxis; time: TimeAxis; trust: TrustAxis } {
  if (!Number.isInteger(index) || index < 0 || index > 26) {
    throw new Error(`coordFromIndex: index 越界 ${index}（0..26）`)
  }
  const space = (Object.keys(SPACE_ORDER) as SpaceAxis[])[Math.floor(index / 9)]
  const time = (Object.keys(TIME_ORDER) as TimeAxis[])[Math.floor((index % 9) / 3)]
  const trust = (Object.keys(TRUST_ORDER) as TrustAxis[])[index % 3]
  return { space, time, trust }
}

/** E-06 新特性注册表键（验收 7：每个新特性必须有坐标声明）。 */
export const E06_FEATURE_IDS = [
  "trust-grader",
  "trust-retrieval-filter",
  "capability-decay",
  "process-supersession",
  "promotion-lifecycle-transition",
  "retrieval-eval-gate",
  "kb-metrics-observability",
  "kb-error-classification",
  "gov-safety-invariants",
  "dimension-coord",
] as const
export type E06FeatureId = (typeof E06_FEATURE_IDS)[number]

/** 基线坐标（GOV-REV-02 原文）。 */
export const CAPABILITY_KB_COORD = { space: "Decoupled", time: "Async", trust: "Tunable" } as const
export const PROCESS_KB_COORD = { space: "Coupled", time: "Sync", trust: "Sovereign" } as const

/** E-06 特性坐标注册表（E-06 共识 §3 表）。 */
export const DIMENSION_COORD_REGISTRY: Record<E06FeatureId, DimensionCoord> = {
  "trust-grader": {
    featureId: "trust-grader",
    space: "Decoupled",
    time: "Sync",
    trust: "Tunable",
    reversibility: {
      mechanism: "seed-lock",
      rollbackPath: "纯函数零 IO；阈值变更锁 TRUST_SEED_LOCK + 分支回滚",
      slaNote: "G-6 [需校准]",
    },
  },
  "trust-retrieval-filter": {
    featureId: "trust-retrieval-filter",
    space: "Decoupled",
    time: "Sync",
    trust: "Fixed",
    reversibility: {
      mechanism: "flag",
      rollbackPath: "trustFilterEnabled=false 字节级回退；blocked 永不进检索（MUST NOT 关闭）",
    },
  },
  "capability-decay": {
    featureId: "capability-decay",
    space: "Decoupled",
    time: "Async",
    trust: "Tunable",
    reversibility: {
      mechanism: "replay",
      rollbackPath: "kb-decay-events.jsonl 清空重放 → decay 恒 1（canon+backfill 全量重建）",
      slaNote: "G-6 重建时间/空间上界 [需校准]",
    },
  },
  "process-supersession": {
    featureId: "process-supersession",
    space: "Coupled",
    time: "Sync",
    trust: "Sovereign",
    reversibility: {
      mechanism: "replay",
      rollbackPath: "状态可逆（无物理删除）；supersede 事件 append-only 可审计；清除 invalid_at 恢复装配",
    },
  },
  "promotion-lifecycle-transition": {
    featureId: "promotion-lifecycle-transition",
    space: "Decoupled",
    time: "Sync",
    trust: "Sovereign",
    reversibility: {
      mechanism: "replay",
      rollbackPath: "仅沿 Time 轴移动（assertBridgeTimeOnlyMove 强制）；replayKey 幂等重放",
    },
  },
  "retrieval-eval-gate": {
    featureId: "retrieval-eval-gate",
    space: "Decoupled",
    time: "Replay",
    trust: "Fixed",
    reversibility: {
      mechanism: "seed-lock",
      rollbackPath: "离线重跑；EVAL_GATE 冻结常量 MUST NOT 运行时关闭；种子 digest 锁",
    },
  },
  "kb-metrics-observability": {
    featureId: "kb-metrics-observability",
    space: "Decoupled",
    time: "Async",
    trust: "Tunable",
    reversibility: {
      mechanism: "rebuild",
      rollbackPath: "指标全为只读派生；kb-observability.jsonl 可删重建",
    },
  },
  "kb-error-classification": {
    featureId: "kb-error-classification",
    space: "Buffered",
    time: "Replay",
    trust: "Tunable",
    reversibility: {
      mechanism: "replay",
      rollbackPath: "失败先入队（retry/quarantine 队列），重放收敛；分类表为纯函数",
    },
  },
  "gov-safety-invariants": {
    featureId: "gov-safety-invariants",
    space: "Decoupled",
    time: "Sync",
    trust: "Fixed",
    reversibility: {
      mechanism: "seed-lock",
      rollbackPath: "无开关；变更须改代码 + 过评审（GOV-OBS-05）——刻意不可逆=设计意图",
    },
  },
  "dimension-coord": {
    featureId: "dimension-coord",
    space: "Decoupled",
    time: "Sync",
    trust: "Fixed",
    reversibility: {
      mechanism: "rebuild",
      rollbackPath: "纯数据 + 纯函数；注册表可重建",
    },
  },
}

/** 晋升桥约束：仅允许沿 Time 轴移动（space/trust 不变，违反 throw）。 */
export function assertBridgeTimeOnlyMove(prev: DimensionCoord, next: DimensionCoord): void {
  if (prev.space !== next.space || prev.trust !== next.trust) {
    throw new Error(
      `bridge may only move along the Time axis: ${prev.featureId} (${prev.space},${prev.time},${prev.trust}) → (${next.space},${next.time},${next.trust})`,
    )
  }
}
