/**
 * naming-canonical-map.ts — 命名唯一映射真源（双轨/三轨收敛）
 *
 * 背景（swarm ts-bloat-20261017「杂乱」指控）：同一概念在代码中存在多轨写法——
 *   · 弧末结算步骤：G4 编排契约层叫 `summary`/`expand`，control-kernel 内核层叫
 *     `arc_summary`/`expand_arc`（见 `cruise-wiring.ts: ARBITRATION_TO_KERNEL_STEP`）；
 *   · 实体目录：`wiki/entities`（规范）+ `wiki/characters` + `wiki/concepts`
 *     三轨并存（见 `local-entity-names.ts: ENTITY_DIRS`）。
 *
 * 本模块**只做真源收敛，不改既有行为**：既有模块继续按原常量工作，新增代码
 * 一律引用本映射，禁止再硬编码第三套写法。ADR-50。
 *
 * 机械层（ADR-19）：纯数据 + 纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */
import type { ArcSettlementStep } from "./arc-settlement"

/** 内核（control-kernel）弧末步骤名 —— 与 `control-sentinels.ts: ARC_TRANSITION_STEPS` 对齐。 */
export type KernelArcStep =
  | "arc_review"
  | "arc_summary"
  | "volume_summary"
  | "expand_arc"
  | "new_volume"

/**
 * 弧末结算步骤：契约层名 → 内核层名（唯一真源）。
 * `cruise-wiring.ts` 的 `ARBITRATION_TO_KERNEL_STEP` 与本表必须逐项一致。
 */
export const ARC_STEP_CANONICAL: Readonly<Record<ArcSettlementStep, KernelArcStep>> = Object.freeze({
  arc_review: "arc_review",
  summary: "arc_summary",
  volume_summary: "volume_summary",
  expand: "expand_arc",
  new_volume: "new_volume",
})

/** 反向映射（内核层名 → 契约层名）。 */
export const KERNEL_STEP_TO_ARC: Readonly<Record<KernelArcStep, ArcSettlementStep>> = Object.freeze({
  arc_review: "arc_review",
  arc_summary: "summary",
  volume_summary: "volume_summary",
  expand_arc: "expand",
  new_volume: "new_volume",
})

/** 规范实体目录（第一轨）。 */
export const ENTITY_DIR_CANONICAL = "wiki/entities" as const

/**
 * 实体目录三轨 → 语义角色（唯一真源）。
 * `local-entity-names.ts: ENTITY_DIRS` 必须为本表 key 的子集/等集。
 */
export const ENTITY_DIR_ROLES: Readonly<Record<string, "entities" | "characters" | "concepts">> =
  Object.freeze({
    "wiki/entities": "entities",
    "wiki/characters": "characters",
    "wiki/concepts": "concepts",
  })

/** 全部实体扫描目录（按优先级顺序；首项为规范轨）。 */
export const ENTITY_DIRS_CANONICAL: readonly string[] = Object.freeze(Object.keys(ENTITY_DIR_ROLES))

/** 契约层步骤名 → 内核层步骤名（纯函数）。 */
export function toKernelArcStep(step: ArcSettlementStep): KernelArcStep {
  return ARC_STEP_CANONICAL[step]
}

/** 内核层步骤名 → 契约层步骤名（纯函数）。 */
export function toArcSettlementStep(step: KernelArcStep): ArcSettlementStep {
  return KERNEL_STEP_TO_ARC[step]
}

/** 实体目录 → 语义角色；未知目录返回 null（调用方自行决定回退）。 */
export function entityDirRole(dir: string): "entities" | "characters" | "concepts" | null {
  return ENTITY_DIR_ROLES[dir.replace(/\\/g, "/").replace(/\/+$/, "")] ?? null
}

/** 是否为受支持的实体目录（含三轨）。 */
export function isCanonicalEntityDir(dir: string): boolean {
  return entityDirRole(dir) !== null
}
