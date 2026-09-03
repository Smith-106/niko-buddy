/**
 * 51 号报告 G4: 编辑影响分析（事前冲击面预测）.
 *
 * 语义: 在编辑保存前，对「编辑前后候选文本 diff」预测受影响实体集合
 * （canon 边 / 伏笔 / 支线 / 角色），供调用方决定是否需人工确认。
 * 纯函数、零写入零 IO（守 ADR-19/29）——预测发生在保存前，不产生副作用。
 *
 * 检测规则（additive，不触碰既有编辑链路行为）:
 * - 实体名/伏笔名/支线标题在 after 文本中消失（before 有 after 无）→ 标记 removed。
 * - 受影响集合 = 命中实体 + 其关联边（source/target/predicate 含实体名）。
 * - riskLevel: 命中 world_fact/arc 边 → high；仅 attribute/foreshadow → medium；其余 → low。
 */

import type { CanonEdge } from "../../components/canon-editor/canon-types"
import type { Foreshadowing } from "./foreshadowing-tracker"

export interface EditDiff {
  before: string
  after: string
}

export interface EditImpactStores {
  canonEdges?: readonly CanonEdge[]
  foreshadows?: readonly Foreshadowing[]
  subplots?: readonly { id: string; title: string }[]
  characters?: readonly { id: string; characterName: string }[]
}

export type EditImpactCategory = "canon_edge" | "foreshadowing" | "subplot" | "character"

export interface AffectedEntity {
  ref: string
  category: EditImpactCategory
  kind: "removed" | "retained"
  name: string
}

export type EditRiskLevel = "low" | "medium" | "high"

export interface EditImpactResult {
  affectedEntities: AffectedEntity[]
  affectedEdges: CanonEdge[]
  affectedForeshadows: Foreshadowing[]
  affectedSubplots: { id: string; title: string }[]
  affectedCharacters: { id: string; characterName: string }[]
  riskLevel: EditRiskLevel
  rationale: string[]
}

/** 从文本中提取实体提及（子串匹配，大小写不敏感）。 */
function mentions(text: string, name: string): boolean {
  if (!name) return false
  return text.toLowerCase().includes(name.toLowerCase())
}

/**
 * 事前冲击面预测：比较编辑前后文本，返回受影响实体集合与风险分级。
 * before === after → 空 affected 集（零冲击）。
 */
export function analyzeEditImpact(diff: EditDiff, stores: EditImpactStores = {}): EditImpactResult {
  const { before, after } = diff
  const affected: AffectedEntity[] = []
  const affectedEdges: CanonEdge[] = []
  const affectedForeshadows: Foreshadowing[] = []
  const affectedSubplots: { id: string; title: string }[] = []
  const affectedCharacters: { id: string; characterName: string }[] = []
  const rationale: string[] = []

  if (before === after) {
    return {
      affectedEntities: [],
      affectedEdges: [],
      affectedForeshadows: [],
      affectedSubplots: [],
      affectedCharacters: [],
      riskLevel: "low",
      rationale: ["编辑前后文本一致，零冲击。"],
    }
  }

  const removed = (name: string): boolean => mentions(before, name) && !mentions(after, name)

  // 角色
  for (const c of stores.characters ?? []) {
    if (removed(c.characterName)) {
      affectedCharacters.push(c)
      affected.push({ ref: `character:${c.characterName}`, category: "character", kind: "removed", name: c.characterName })
      rationale.push(`角色「${c.characterName}」的提及在编辑后消失。`)
    }
  }

  // 伏笔
  for (const f of stores.foreshadows ?? []) {
    if (removed(f.name)) {
      affectedForeshadows.push(f)
      affected.push({ ref: `foreshadowing:${f.id}`, category: "foreshadowing", kind: "removed", name: f.name })
      rationale.push(`伏笔「${f.name}」的引用在编辑后消失。`)
    }
  }

  // 支线
  for (const s of stores.subplots ?? []) {
    if (removed(s.title)) {
      affectedSubplots.push(s)
      affected.push({ ref: `subplot:${s.id}`, category: "subplot", kind: "removed", name: s.title })
      rationale.push(`支线「${s.title}」的标题在编辑后消失。`)
    }
  }

  // canon 边：source/target/predicate 任一实体名在 after 中消失 → 受影响
  for (const e of stores.canonEdges ?? []) {
    const names = [e.source_id, e.target_id, e.predicate].filter(Boolean)
    const hit = names.some((n) => removed(n))
    if (hit) {
      affectedEdges.push(e)
      affected.push({ ref: `canon_edge:${e.id}`, category: "canon_edge", kind: "removed", name: e.predicate })
      rationale.push(`canon 边 ${e.source_id} -[${e.predicate}]-> ${e.target_id} 的实体提及在编辑后消失。`)
    }
  }

  // 风险分级
  let riskLevel: EditRiskLevel = "low"
  if (affectedEdges.some((e) => e.edge_kind === "world_fact" || e.edge_kind === "arc")) {
    riskLevel = "high"
  } else if (affected.length > 0) {
    riskLevel = "medium"
  }

  return {
    affectedEntities: affected,
    affectedEdges,
    affectedForeshadows,
    affectedSubplots,
    affectedCharacters,
    riskLevel,
    rationale,
  }
}
