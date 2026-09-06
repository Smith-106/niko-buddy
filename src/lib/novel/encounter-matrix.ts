import { canonicalizeForHash, createAtomicJsonStore, type FoldContext } from "./projection-store"
import type { ChapterSnapshot } from "./chapter-ingest"
import { matchesAnyAlias } from "./book-analysis/alias-resolver"
import type { NameAliasMap } from "./book-analysis/types"

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
  /**
   * P2-IMP-09：同键内容修订留痕（TencentDB skill-versioning 模式，对齐快照 revision
   * 链语义——覆盖即记修订）。易变元数据：canonicalizeForHash 按 `*At` 约定剔除，
   * 不参与 live==replay 内容哈希 → 修订不影响 truth_fold_drift 判定。
   */
  revisedAt?: string
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
 * P2-IMP-09：内容 canonical 签名（易变元数据剔除，与 truthStoreHash/truth_fold_drift
 * 哈希口径一致）。仅用于幂等判定（相等 → no-op），不持久化。
 */
function contentSignature(edge: MeetingEdge): string {
  return JSON.stringify(canonicalizeForHash(edge))
}

/**
 * 追加一条见面边（P2-IMP-09 起为同键 upsert 末条胜，TencentDB skill-versioning 模式）。
 * E-03 (run-execute-1, 三模型共识): 幂等键修复 — 原实现只查 (a,b) 无序对、
 * 忽略 chapter, 导致同对角色跨章再见面被跳过, live ingest 与 rebuild 漂移。
 * 键为 (a,b,chapter) 三元组（a/b 无序）: 无同键 → 追加；
 * 同键且内容 canonical hash 相等 → 显式 no-op（防重复 ingest 抖动）；
 * 同键且内容不等 → 覆盖内容字段（末条胜）并记修订（revisedAt）。
 * 保留语义: 键字段即 id（a/b/chapter 不变），覆盖只动内容字段。
 * fold 纯性: 无隐式时钟, 时间戳只经显式 ctx.now 写入。
 * 供 chapter-ingest 投影循环在 accept 后调用；模型不得直接覆写。
 */
export function appendMeetingEdge(
  storeData: EncounterMatrixStore,
  edge: MeetingEdge,
  ctx?: FoldContext,
): EncounterMatrixStore {
  const idx = storeData.edges.findIndex(
    (e) =>
      e.chapter === edge.chapter &&
      ((e.a === edge.a && e.b === edge.b) || (e.a === edge.b && e.b === edge.a)),
  )
  if (idx === -1) {
    return {
      edges: [...storeData.edges, edge],
      lastUpdated: ctx?.now ?? storeData.lastUpdated,
    }
  }
  const existing = storeData.edges[idx]
  if (contentSignature(existing) === contentSignature(edge)) {
    return storeData
  }
  const replacement: MeetingEdge = ctx?.now ? { ...edge, revisedAt: ctx.now } : edge
  return {
    edges: storeData.edges.map((e, i) => (i === idx ? replacement : e)),
    lastUpdated: ctx?.now ?? storeData.lastUpdated,
  }
}

/**
 * E-03: 从 snapshot 确定性 fold 出见面边（纯函数，零 LLM）。
 * 共现口径: snapshot.characters 两两共现 (i<j 稳定排序定 a/b) 即见面边;
 * 角色名经 aliasMaps 归一为 canonical (join key 一致性, 验收⑦)。
 * 幂等键 (a,b,chapter) 由 appendMeetingEdge 保证。
 */
export function foldMeetingEdges(
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly NameAliasMap[],
): MeetingEdge[] {
  const names = [...(snapshot.characters ?? [])]
  const edges: MeetingEdge[] = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = resolveEdgeName(names[i], aliasMaps)
      const b = resolveEdgeName(names[j], aliasMaps)
      if (!a || !b || a === b) continue
      const witnessedBy = names
        .filter((_, k) => k !== i && k !== j)
        .map((n) => resolveEdgeName(n, aliasMaps))
        .filter((n): n is string => Boolean(n) && n !== a && n !== b)
      edges.push({ a, b, chapter: snapshot.chapterNumber, context: "", witnessedBy })
    }
  }
  return edges
}

function resolveEdgeName(
  name: string,
  aliasMaps?: readonly NameAliasMap[],
): string {
  if (!aliasMaps || aliasMaps.length === 0) return name
  for (const map of aliasMaps) {
    if (matchesAnyAlias(name, map)) return map.canonical
  }
  return name
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
  upTo: "past" | "inclusive" = "inclusive",
): string[] {
  const names = new Set<string>()
  for (const e of storeData.edges) {
    // P2-IMP-05：past 排除本章共现（本章见面≠已见面，堵信息泄漏）；inclusive 含本章。
    if (upTo === "past" ? e.chapter >= chapter : e.chapter > chapter) continue
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
