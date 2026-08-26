/**
 * eval-adapters.ts — F1 G1 骨架：既有类型 → 评测契约适配层。
 *
 * 硬共识映射（eval-g1-skeleton.md）：
 *  - CanonFact sourceId→subject / targetId→object（adapter 映射）
 *  - TemporalFact validFrom→validAt；former 标记透传
 *  - edgeKind→reasonCode 映射表（hard↔world_fact+attribute；cognition↔
 *    modality∈{belief,hypothesis}；foreshadow↔edgeKind==="foreshadow"）
 *  - digest 复用 computeCheckpointDigestOf（C4）
 *  - L3 信号：ContinuityFinding critical 且 subtype=consistency_mechanical（C3）
 */
import type { CanonFact } from "../canon-graph-client"
import type { TemporalFact } from "../temporal-memory"
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import { computeCheckpointDigestOf } from "../checkpoint-digest"
import { resolveCanonicalName } from "../character-cognition"
import type { ContextPack } from "../context-engine"
import type {
  GoldChunk,
  PoisonChunk,
  PoisonType,
  AuthorityTier,
} from "./eval-schema"

/** 装配期视图：L1/L2 断言输入（pro 共识版）。 */
export interface AssembledContextView {
  /** protected 层渲染文本（canonRules + 有效 temporal 块）。 */
  protectedCurrent: string[]
  /** former 层渲染文本（formerFacts 独立分块）。 */
  protectedFormer: string[]
  /** compressible 层渲染文本（communitySummaries 等）。 */
  compressible: string[]
  /** 装配期 tier 判定是否完成（false = 未装配，L1/L2 应判 fail）。 */
  protectedLayerAssembled: boolean
}

/** edgeKind → reasonCode 映射表（hard↔world_fact+attribute；cognition↔modality）。 */
export function edgeKindToReasonCode(edgeKind: string, modality?: string | null): string {
  if (edgeKind === "hard") return "world_fact"
  if (edgeKind === "attribute") return "attribute"
  if (edgeKind === "cognition") {
    if (modality === "belief") return "belief"
    if (modality === "hypothesis") return "hypothesis"
    return "cognition"
  }
  if (edgeKind === "foreshadow") return "foreshadow"
  return edgeKind
}

/** CanonFact → GoldChunk（sourceId→subject / targetId→object）。 */
export function canonFactToGoldChunk(fact: CanonFact, tier: AuthorityTier = "protected"): GoldChunk {
  return {
    id: fact.id,
    subject: resolveCanonicalName(fact.sourceId),
    predicate: fact.predicate,
    object: resolveCanonicalName(fact.targetId),
    tier,
    expectedLayer: "protected",
  }
}

/** TemporalFact → PoisonChunk（former 标记 → former_as_current 毒化）。 */
export function temporalFactToPoisonChunk(fact: TemporalFact): PoisonChunk {
  const poisonType: PoisonType = fact.former ? "former_as_current" : "contradiction"
  return {
    id: fact.id,
    subject: resolveCanonicalName(fact.subject),
    predicate: fact.predicate,
    object: fact.object,
    poisonType,
    expectedLanding: fact.former ? "former" : "excluded",
  }
}

/** ContinuityFinding → L3 信号（C3：仅 critical + consistency_mechanical）。 */
export function isL3CriticalFinding(finding: ContinuityFinding): boolean {
  return finding.severity === "critical" && finding.subtype === "consistency_mechanical"
}

/** ContextPack → AssembledContextView（tier 在装配期判定）。 */
export function contextPackToAssembledView(pack: ContextPack): AssembledContextView {
  const protectedCurrent: string[] = []
  if (pack.canonRules) protectedCurrent.push(pack.canonRules)
  if (pack.timeline) protectedCurrent.push(pack.timeline)
  if (pack.characterStates) protectedCurrent.push(pack.characterStates)

  const protectedFormer: string[] = []
  if (pack.formerFacts?.length) {
    protectedFormer.push(
      pack.formerFacts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join("\n"),
    )
  }

  const compressible: string[] = []
  if (pack.communitySummaries) compressible.push(pack.communitySummaries)

  return {
    protectedCurrent,
    protectedFormer,
    compressible,
    protectedLayerAssembled: true,
  }
}

/** 三元组 join 键（C2：subject/predicate/object + resolveCanonicalName 归一）。 */
export function tripleKey(subject: string, predicate: string, object: string): string {
  return [resolveCanonicalName(subject), predicate, resolveCanonicalName(object)].join("\u0000")
}

/** 文本层内是否包含三元组（存在性断言，非 rank — C5）。 */
export function layerContainsTriple(layerTexts: string[], subject: string, predicate: string, object: string): boolean {
  return layerTexts.some((text) => text.includes(subject) && text.includes(predicate) && text.includes(object))
}

/** 用例/语料 digest（C4：复用 computeCheckpointDigestOf）。 */
export async function computeEvalDigest(value: unknown): Promise<string> {
  return computeCheckpointDigestOf(value)
}
