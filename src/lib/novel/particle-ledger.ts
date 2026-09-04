import { createAtomicJsonStore, type FoldContext } from "./projection-store"
import type { ChapterSnapshot } from "./chapter-ingest"

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
 * E-03 (run-execute-1, 三模型共识): 幂等键 (kind, character, name, chapter) —
 * 已存在则跳过并保留首条 (append-only 时序账本, 首条优先符合「最早成因」语义),
 * 防 re-ingest 重复账目与 rebuild 漂移。
 * fold 纯性: 无隐式时钟, 时间戳只经显式 ctx.now 写入。
 * 供 chapter-ingest 投影循环在 accept 后调用；模型不得直接覆写。
 */
export function appendParticleEntry(
  storeData: ParticleLedgerStore,
  entry: ParticleEntry,
  ctx?: FoldContext,
): ParticleLedgerStore {
  if (!entry.character || !entry.name || !entry.chapter || entry.chapter < 1) {
    return storeData
  }
  const exists = storeData.entries.some(
    (e) =>
      e.kind === entry.kind &&
      e.character === entry.character &&
      e.name === entry.name &&
      e.chapter === entry.chapter,
  )
  if (exists) return storeData
  return {
    entries: [...storeData.entries, entry],
    lastUpdated: ctx?.now ?? storeData.lastUpdated,
  }
}

/**
 * E-03: 从 snapshot 确定性 fold 出粒子账目（纯函数，零 LLM）。
 * 保守文本映射: 从 characterStateChanges 行匹配 money/injury/technique 关键词
 * (与 parseCharacterStateChange 行格式约定对齐); 无匹配降级不提取 (宁缺勿错,
 * 守「不新增 LLM 提取语义」)。角色名经 aliasMaps 归一为 canonical。
 */
export function foldParticleEntries(
  snapshot: ChapterSnapshot,
  aliasMaps?: readonly import("./book-analysis/types").NameAliasMap[],
): ParticleEntry[] {
  const entries: ParticleEntry[] = []
  for (const line of snapshot.characterStateChanges ?? []) {
    const parsed = parseParticleLine(line, snapshot.chapterNumber, aliasMaps)
    if (parsed) entries.push(parsed)
  }
  return entries
}

const PARTICLE_KIND_PATTERNS: Array<{ kind: ParticleKind; patterns: RegExp[] }> = [
  { kind: "money", patterns: [/两|文|金|银|铜钱|灵石|币|钱/i] },
  { kind: "injury", patterns: [/伤|创|断|裂|愈|血/i] },
  { kind: "technique", patterns: [/功法|修为|境界|层|阶|内力|灵力|真气/i] },
]

function parseParticleLine(
  line: string,
  chapter: number,
  aliasMaps?: readonly import("./book-analysis/types").NameAliasMap[],
): ParticleEntry | null {
  const colonIndexes = [line.indexOf("："), line.indexOf(":")].filter((i) => i >= 0)
  if (colonIndexes.length === 0) return null
  const name = line.slice(0, Math.min(...colonIndexes)).trim()
  if (!name) return null
  const rest = line.slice(Math.min(...colonIndexes) + 1).trim()
  if (!rest) return null
  for (const { kind, patterns } of PARTICLE_KIND_PATTERNS) {
    if (!patterns.some((p) => p.test(rest))) continue
    const character = resolveParticleName(name, aliasMaps)
    if (!character) return null
    return {
      kind,
      character,
      name: rest.slice(0, 12),
      chapter,
      delta: 0,
      state: rest,
      note: "text-heuristic",
    }
  }
  return null
}

function resolveParticleName(
  name: string,
  aliasMaps?: readonly import("./book-analysis/types").NameAliasMap[],
): string {
  if (!aliasMaps || aliasMaps.length === 0) return name
  for (const map of aliasMaps) {
    if (map.aliases.includes(name) || map.canonical === name) return map.canonical
  }
  return name
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
