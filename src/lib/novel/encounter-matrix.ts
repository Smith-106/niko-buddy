import { createAtomicJsonStore } from "./projection-store"

/**
 * R4 (S4 / ANL-013): EncounterMatrix projection — 谁见过谁（character_matrix
 * 的「见面矩阵」侧）。三模型共识（2026-08-27，deepseek-v4-pro + GLM-5.2 +
 * hy3，参考 Grok "Different Knowledge Bases for Writing AI"）：Grok 7 类
 * 真相文件中 character_matrix（谁见过谁/信息边界）是 QMAI 最大缺口之一 —
 * CharacterState.relationships 是自由文本关系标签，无「见面事件」时间线。
 * 本投影补齐「谁与谁在何时共场/见面」的时序边，作为 character-state
 * SAME-LAYER sibling（NOT a Truth Files module — ANL-013 C4 forbids a
 * second truth source; ADR-26 + A23 must hold）。
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence — ChapterSnapshot.characters[]（共现）与 characterStateChanges
 * 中的关系变更行 fold 出 MeetingEdge 确定性重建。Persistence uses
 * writeFileAtomic (fs.rs:1190 temp+fsync+rename) — crash-safe, same
 * contract as character-state.ts.
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with emotional-arcs / resource-ledger / subplot-board).
 */

export interface MeetingEdge {
  /** Canonical character A (normalized via resolveCanonicalName upstream). */
  a: string
  /** Canonical character B. */
  b: string
  /** Chapter at which the two were co-present / met. */
  chapter: number
  /** Free-text context of the meeting (scene/location/occasion). */
  context: string
  /** Other characters who witnessed the meeting (canonical names). */
  witnessedBy: string[]
}

export interface EncounterMatrixStore {
  /** Append-only meeting edges (oldest first). */
  edges: MeetingEdge[]
  lastUpdated: string
}

export function createEmptyEncounterMatrixStore(): EncounterMatrixStore {
  return { edges: [], lastUpdated: "" }
}

const store = createAtomicJsonStore<EncounterMatrixStore>(
  "encounter-matrix.json",
  createEmptyEncounterMatrixStore,
)

export async function saveEncounterMatrix(
  projectPath: string,
  storeData: EncounterMatrixStore,
): Promise<void> {
  await store.save(projectPath, storeData)
}

export async function loadEncounterMatrix(
  projectPath: string,
): Promise<EncounterMatrixStore> {
  return store.load(projectPath)
}

/**
 * 追加一条见面边（幂等：同 a/b/chapter 已存在则跳过）。
 * 供 chapter-ingest 投影循环在 accept 后调用；模型不得直接覆写。
 */
export function appendMeetingEdge(
  storeData: EncounterMatrixStore,
  edge: MeetingEdge,
): EncounterMatrixStore {
  const exists = storeData.edges.some(
    (e) =>
      (e.a === edge.a && e.b === edge.b) || (e.a === edge.b && e.b === edge.a),
  )
  if (exists) return storeData
  return {
    edges: [...storeData.edges, edge],
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * 查询两人是否已见过面（任意方向），返回最早见面章。
 */
export function findFirstMeeting(
  storeData: EncounterMatrixStore,
  a: string,
  b: string,
): number | null {
  const hit = storeData.edges.find(
    (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
  )
  return hit ? hit.chapter : null
}

/**
 * 查询某角色在指定章之前已见过面的角色集合（信息互通边界依据）。
 */
export function metBefore(
  storeData: EncounterMatrixStore,
  character: string,
  chapter: number,
): string[] {
  const names = new Set<string>()
  for (const e of storeData.edges) {
    if (e.chapter > chapter) continue
    if (e.a === character) names.add(e.b)
    else if (e.b === character) names.add(e.a)
  }
  return [...names]
}

export function encounterMatrixToContextText(storeData: EncounterMatrixStore): string {
  if (storeData.edges.length === 0) return ""
  const lines = storeData.edges
    .map((e) => {
      const w = e.witnessedBy.length ? `（在场：${e.witnessedBy.join("、")}）` : ""
      return `第${e.chapter}章 ${e.a} × ${e.b}${w}：${e.context}`
    })
    .join("\n")
  return `【角色见面矩阵】\n${lines}`
}
