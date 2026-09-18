/**
 * R-anwa-1 (26 审计落地): WorldBlueprint — 世界观分层骨架与一致性.
 *
 * 吸收来源：reference/AI-Novel-Writing-Assistant server/src/services/world/
 * worldStructure.ts（WorldStructuredData：axioms/background/geography/cultures/
 * magicSystem/politics/races/religions/technology/conflicts/history/economy/
 * factions 分层）+ worldConsistency.ts + worldSkeletonGeneration.ts。
 * 26 号审计三票共识盲区（value 8/5/6 全票 worth_absorbing）。
 *
 * 定位：世界观分层骨架数据模型 + 确定性完备性/一致性检查 + prompt 注入。
 * 骨架内容本身由写作流程产出（draft-first），本模块只做结构治理与
 * 确定性校验，不伪造语义生成。
 */

export const WORLD_LAYERS = [
  "axioms",
  "background",
  "geography",
  "cultures",
  "races",
  "magicSystem",
  "politics",
  "technology",
  "economy",
  "religions",
  "history",
  "conflicts",
  "factions",
] as const

export type WorldLayer = (typeof WORLD_LAYERS)[number]

/** 必填层（ANWA worldStructure 核心层；缺任一视为骨架不完备）。 */
export const REQUIRED_WORLD_LAYERS: WorldLayer[] = [
  "axioms",
  "background",
  "geography",
  "cultures",
  "conflicts",
]

export interface WorldBlueprint {
  version: string
  worldType: string
  /** 分层内容：层名 → 条目列表（每层 0..n 条）。 */
  layers: Partial<Record<WorldLayer, string[]>>
  /** 交叉引用：条目跨层引用（如 magicSystem 引用某 race 名）。 */
  crossRefs?: Array<{ from: WorldLayer; to: WorldLayer; term: string }>
}

export function createEmptyWorldBlueprint(worldType: string): WorldBlueprint {
  return { version: "1.0", worldType, layers: {}, crossRefs: [] }
}

export interface WorldFinding {
  code: "missing_layer" | "empty_layer" | "dangling_cross_ref"
  layer?: WorldLayer
  severity: "error" | "warn"
  message: string
}

export interface WorldValidation {
  findings: WorldFinding[]
  /** 完备（必填层全非空）且无 error → complete。 */
  verdict: "complete" | "incomplete"
}

/**
 * 确定性骨架校验：必填层缺失/为空 → error；可选层为空 → 无发现（合法稀疏）；
 * crossRefs 的 to 层若未包含被引条目 → dangling warn。
 */
export function validateWorldBlueprint(bp: WorldBlueprint): WorldValidation {
  const findings: WorldFinding[] = []

  for (const layer of REQUIRED_WORLD_LAYERS) {
    const entries = bp.layers[layer] ?? []
    if (entries.length === 0) {
      findings.push({
        code: "missing_layer",
        layer,
        severity: "error",
        message: `必填层「${layer}」缺失或为空`,
      })
    }
  }

  for (const ref of bp.crossRefs ?? []) {
    const targetEntries = bp.layers[ref.to] ?? []
    if (!targetEntries.includes(ref.term)) {
      findings.push({
        code: "dangling_cross_ref",
        layer: ref.to,
        severity: "warn",
        message: `交叉引用悬空：「${ref.from}」引用「${ref.to}」层不存在的条目「${ref.term}」`,
      })
    }
  }

  return {
    findings,
    verdict: findings.some((f) => f.severity === "error") ? "incomplete" : "complete",
  }
}

/**
 * 渲染世界观 prompt 片段（仅渲染非空层；空蓝图返回 ""）。
 * 层序固定为 WORLD_LAYERS 声明序，输出确定性。
 */
export function worldBlueprintToPromptFragment(bp: WorldBlueprint): string {
  const sections = WORLD_LAYERS.filter((l) => (bp.layers[l] ?? []).length > 0).map(
    (l) => `### ${l}\n${(bp.layers[l] ?? []).map((e) => `- ${e}`).join("\n")}`,
  )
  if (sections.length === 0) return ""
  return [`# 世界观骨架（${bp.worldType}）`, ...sections].join("\n\n")
}

// ── 持久化（MIG-001：补产物管线）──────────────────────────────────
// world-blueprint 之前只有校验器无持久化——orchestrator 拿不到真实 blueprint
// 只能吃手动 checkbox。补上 .novel/world-blueprint.json 原子 store，让
// 写作流程/编辑器能把骨架落盘，collectPhaseGateInput 才能读真实完备度。
import { createAtomicJsonStore } from "./projection-store"

const worldBlueprintStore = createAtomicJsonStore<WorldBlueprint | null>(
  "world-blueprint.json",
  () => null,
)

/** 持久化世界观骨架（.novel/world-blueprint.json 原子写）。 */
export async function saveWorldBlueprint(projectPath: string, bp: WorldBlueprint): Promise<void> {
  await worldBlueprintStore.save(projectPath, bp)
}

/** 读取持久化世界观骨架；未写过返回 null（调用方按需 createEmpty）。 */
export async function loadWorldBlueprint(projectPath: string): Promise<WorldBlueprint | null> {
  try {
    return await worldBlueprintStore.load(projectPath)
  } catch {
    return null
  }
}
