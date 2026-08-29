import { createAtomicJsonStore } from "./projection-store"

/**
 * R4 (S4 / ANL-013): ParticleLedger projection — 金钱/伤势/功法（修为）时序
 * 账本，与 resource-ledger（物品归属）并列，合称 Grok 的 particle_ledger
 * （防无限背包）。三模型共识（2026-08-27，deepseek-v4-pro + GLM-5.2 +
 * hy3，参考 Grok "Different Knowledge Bases for Writing AI"）：QMAI 现状
 * 只覆盖「物品」归属时序（ResourceEntry.transferHistory），金钱/伤势/功法
 * 无增减账本 — 金钱散落在 snapshot.items 文本、伤势在 CharacterState.status
 * 自由文本、功法在 abilities[] 无时序。本投影补齐三类粒子账本，作为
 * character-state SAME-LAYER sibling（NOT a Truth Files module — ANL-013
 * C4 forbids a second truth source; ADR-26 + A23 must hold）。
 *
 * 强不变量（防无限背包）：每条记录必有归属角色 + 章号；无归属/无章号记录
 * 在 fold 时被拒绝（见 appendParticleEntry 校验）。
 *
 * Fold-rebuildable (S3 F-002): re-derivable from the committed snapshot
 * sequence — characterStateChanges/items 行 fold deterministically.
 * Persistence uses writeFileAtomic (fs.rs:1190 temp+fsync+rename) —
 * crash-safe, same contract as character-state.ts.
 *
 * MAINT-002: save/load delegated to createAtomicJsonStore (shared boilerplate
 * with emotional-arcs / resource-ledger / subplot-board).
 */

export type ParticleKind = "money" | "injury" | "technique"

export interface ParticleEntry {
  /** money | injury | technique. */
  kind: ParticleKind
  /** Canonical character name (owner). */
  character: string
  /** Particle name: 货币名/伤势部位/功法名. */
  name: string
  /** Chapter at which the change occurred. */
  chapter: number
  /** Signed delta: money ±amount; injury +1 受/-1 愈; technique +1 得/等级变化. */
  delta: number
  /** Current state after this change (free text, e.g. 余额/伤势程度/修为阶). */
  state: string
  /** Free-text note (来源/去向/触发事件). */
  note: string
}

export interface ParticleLedgerStore {
  entries: ParticleEntry[]
  lastUpdated: string
}

export function createEmptyParticleLedgerStore(): ParticleLedgerStore {
  return { entries: [], lastUpdated: "" }
}

const store = createAtomicJsonStore<ParticleLedgerStore>(
  "particle-ledger.json",
  createEmptyParticleLedgerStore,
)

export async function saveParticleLedger(
  projectPath: string,
  storeData: ParticleLedgerStore,
): Promise<void> {
  await store.save(projectPath, storeData)
}

export async function loadParticleLedger(
  projectPath: string,
): Promise<ParticleLedgerStore> {
  return store.load(projectPath)
}

/**
 * 追加一条粒子账目（强不变量：必有归属角色 + 章号，否则拒绝返回原 store）。
 * 供 chapter-ingest 投影循环在 accept 后调用；模型不得直接覆写。
 */
export function appendParticleEntry(
  storeData: ParticleLedgerStore,
  entry: ParticleEntry,
): ParticleLedgerStore {
  if (!entry.character || !entry.name || !entry.chapter || entry.chapter < 1) {
    return storeData
  }
  return {
    entries: [...storeData.entries, entry],
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * 查询某角色某类粒子的当前状态（取该角色该类最后一条）。
 */
export function currentParticleState(
  storeData: ParticleLedgerStore,
  character: string,
  kind: ParticleKind,
): ParticleEntry | null {
  const hits = storeData.entries.filter((e) => e.character === character && e.kind === kind)
  return hits.length ? hits[hits.length - 1] : null
}

/**
 * 查询某角色某类粒子的完整时序（防「伤势已愈却再现/金钱收支不平」审计源）。
 */
export function particleHistory(
  storeData: ParticleLedgerStore,
  character: string,
  kind: ParticleKind,
): ParticleEntry[] {
  return storeData.entries.filter((e) => e.character === character && e.kind === kind)
}

export function particleLedgerToContextText(storeData: ParticleLedgerStore): string {
  if (storeData.entries.length === 0) return ""
  const byKind: Record<ParticleKind, ParticleEntry[]> = { money: [], injury: [], technique: [] }
  for (const e of storeData.entries) byKind[e.kind].push(e)
  const lines: string[] = []
  const kindLabel: Record<ParticleKind, string> = {
    money: "金钱",
    injury: "伤势",
    technique: "功法",
  }
  for (const kind of ["money", "injury", "technique"] as ParticleKind[]) {
    const list = byKind[kind]
    if (!list.length) continue
    lines.push(`【${kindLabel[kind]}账本】`)
    for (const e of list) {
      const sign = e.delta > 0 ? "+" : ""
      lines.push(`第${e.chapter}章 ${e.character} ${e.name} ${sign}${e.delta} → ${e.state}（${e.note}）`)
    }
  }
  return lines.join("\n")
}
