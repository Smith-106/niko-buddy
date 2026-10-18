/**
 * asset-linkage-audit.ts — 资产**实时联动一致性**只读诊断（纯函数）。
 *
 * 用户诉求：「实现资产的实时联动，保证资产动态一致」。
 *
 * ## 为什么是「诊断清单」而不是「自动修复」
 * 资产有三条派生链：`character-states.json`（真源）→ relationship 库 artifact（产物）、
 * 快照 `relationshipChanges`（章节事实）→ 角色关系状态、以及 wiki 图谱边。
 * 其中 artifact 是**不可变产物**（`buildLibraryArtifact` 带 contentHash + 深度冻结），
 * 自动改写会破坏守恒口径；因此本模块只做**只读比对**，把「谁陈旧了、哪条边没进状态、
 * 图谱边缺/多」逐条列出来，由既有迁移/accept 入口处理。本函数零 IO、不改入参、也不写盘；
 * 为了比对 hash 会调用纯函数 `buildLibraryArtifact`（只在内存里构建一个新产物做指纹），
 * 但绝不调用 `saveAssetLibraryArtifact` 或 `canon-graph-client`。
 *
 * ## 显式 N/A（不把「没数据」报成「不一致」）
 * - artifact 缺失 → 属提取缺口（不是 drift）；`na` 有一句中文说明。
 * - 图谱键未传入 → 图谱面整段 N/A；不报 missing/unbacked。
 * - `kind: "unknown"` 的自由文本本身不是冲突（关系语义永远未知）。
 * - 设定投影 live 与 fold drift 的状态字段不在本函数重复结论。
 *
 * @license MIT © Niko Buddy
 */

import { isUnreliableName, nameAppears } from "./name-match"
import { buildLibraryArtifact } from "./asset-library"
import { deriveRelationshipEntries } from "./setting-projection"

/** 冲突码（稳定字符串，供测试与 UI 直出）。 */
export type LinkageConflictCode =
  | "relationship_edge_drift"
  | "snapshot_relation_not_in_state"
  | "graph_edge_missing"
  | "graph_edge_unbacked"

export interface LinkageConflict {
  readonly code: LinkageConflictCode
  /** 左侧标识（drift 时=派生 hash；边类冲突时=源端点）。 */
  readonly left: string
  /** 右侧标识（drift 时=产物 hash；边类冲突时=目标端点）。 */
  readonly right: string
  readonly detail: string
}

/** 本函数需要的角色字段（只读子集，避免耦合完整类型）。 */
export interface LinkageCharacter {
  readonly characterName?: string | null
  readonly relationships?: Readonly<Record<string, string>> | null
}

/** 产物摘要（`AssetLibrarySnapshot` 已提供 contentHash/entryCount，不必传全量条目）。 */
export interface LinkageArtifactDigest {
  readonly contentHash: string
  readonly entryCount: number
}

export interface LinkageSnapshotRelationLine {
  readonly chapterNumber: number
  /** 关系变更原文（不截断、不改写）。 */
  readonly text: string
}

export interface AssetLinkageAuditInput {
  readonly characters: readonly LinkageCharacter[]
  /** false = 角色状态尚未装载（调用方加载中）→ 全部比对面 N/A，绝不按空集判 drift。 */
  readonly charactersLoaded?: boolean
  /** relationship 库产物摘要；null = 尚未迁移（提取缺口，不是 drift）。 */
  readonly relationshipArtifact: LinkageArtifactDigest | null
  /** 快照关系事实；省略或空数组 → 该面 N/A（不报「未回填」）。 */
  readonly snapshotRelationLines?: readonly LinkageSnapshotRelationLine[]
  /** wiki 图谱现有边键；与 snapshotGraphEdgeKeys 必须同时给，否则图谱面 N/A。 */
  readonly graphEdgeKeys?: readonly string[]
  readonly snapshotGraphEdgeKeys?: readonly string[]
}

export interface AssetLinkageAuditResult {
  readonly conflicts: readonly LinkageConflict[]
  /** 非冲突的「本面不适用」说明。 */
  readonly na: readonly string[]
  /** 推导出的关系边条数；`null` = 角色状态未装载（不写 0）。 */
  readonly derivedEdgeCount: number | null
  /** 产物里的边条数；缺产物 = null（不写 0）。 */
  readonly artifactEdgeCount: number | null
}

/**
 * 关系条目复算：**复用** `deriveRelationshipEntries`（与迁移入口同一函数、同样不带 projectId）。
 * 绝不能自己再写一遍——那里的「超长 entryId 必须跳过」是 schema 硬约束，漏了会让
 * `buildLibraryArtifact` 在本面板 render 里抛穿整页。
 */
function derivedEdgesFor(characters: readonly LinkageCharacter[]) {
  return deriveRelationshipEntries({ characters: characters as never })
}

/**
 * 收敛空白但**保留标点**：比对时不能用「删掉标点再 includes」，
 * 否则「共守，北门失守」会被粘成含「共守北门」的假命中。
 */
function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, "")
}

/** 判定覆盖所需的最短关系描述长度：更短的描述信息量不足，只能记 N/A。 */
const MIN_DECISIVE_NOTE_LENGTH = 4

type CoverageVerdict = "covered" | "not-covered" | "undecidable"

/**
 * 端点名字命中：走共享的**最长匹配**判定（「王」被「王府」覆盖时不算命中）。
 *
 * 仍然只有必要条件级别：中文里 `李四` 会命中 `李四光`（未知更长名无法消歧），
 * 所以真正的判别力放在关系文本的实质重叠上；单字端点直接判 N/A（见 `judgeCoverage`）。
 */
function containsName(haystack: string, name: string, knownNames: readonly string[]): boolean {
  return nameAppears(haystack, name, knownNames)
}

/** 整段描述原样出现所需的最短长度：更短的通用短语（「关系不错」）不算覆盖证据。 */
const MIN_CONTAINMENT_NOTE_LENGTH = 6
/** 片段命中所需的最短长度：低于此长度的片段（「旧识」）不足以证明已回填。 */
const MIN_STRONG_SEGMENT = 4

/** 单条关系描述是否被该行覆盖（保留标点：跨逗号的整段描述也算原样）。 */
function noteCovered(haystack: string, noteNorm: string): boolean {
  if (noteNorm === haystack) return true
  // ① 整段描述（含标点）原样出现：`宿敌多年，势不两立` 在行内出现即算覆盖，
  //    旧的「按标点切片段」把这种情况判成 not-covered（两半各占一半长度达不到阈值）。
  if (noteNorm.length >= MIN_CONTAINMENT_NOTE_LENGTH && haystack.includes(noteNorm)) return true
  // ② 或任一片段（≥ 描述一半长度且 ≥4 字）原样出现。
  const minSegment = Math.max(MIN_STRONG_SEGMENT, Math.ceil(noteNorm.length / 2))
  return noteNorm
    .split(/[，,。.；;、！!？?：:]/)
    .some((segment) => segment.length >= minSegment && haystack.includes(segment))
}

/**
 * 判定「快照这一行关系事实是否已被角色状态回填」。
 *
 * 三态而非布尔：
 *   - `covered`     该行命中的**每一条**决定性描述都被实质覆盖；
 *   - `not-covered` 存在长度足够的候选描述但有一条对不上 → 确实没回填；
 *   - `undecidable` 只有过短描述（<4 字）、或端点含单字名（无法可靠判人）、或空行 → N/A。
 *
 * 两条硬要求（对抗式审查发现）：
 *   1. 不短路：同一行里 A 对已覆盖不能放行 B 对未覆盖——否则整行被另一端点提前「洗白」。
 *   2. 单字端点不判：`王` ⊂ `王府` 这类子串命中会给出硬结论，宁可 N/A。
 */
function judgeCoverage(
  line: string,
  characters: readonly LinkageCharacter[],
  knownNames: readonly string[],
): CoverageVerdict {
  const raw = line.trim()
  // 空白行不是关系事实：既不算已覆盖，也不算缺口。
  if (!raw) return "undecidable"
  const haystack = normalizeSpace(raw)
  const decisiveNotes: string[] = []
  let sawShortPair = false
  let sawUnreliableEndpoint = false

  for (const character of characters) {
    const from = (character.characterName ?? "").trim()
    if (!from || !containsName(haystack, from, knownNames)) continue
    for (const [to, description] of Object.entries(character.relationships ?? {})) {
      const target = (to ?? "").trim()
      if (!target || !containsName(haystack, target, knownNames)) continue
      if (isUnreliableName(from) || isUnreliableName(target)) {
        sawUnreliableEndpoint = true
        continue
      }
      const note = typeof description === "string" ? description.trim() : ""
      if (!note) continue
      const noteNorm = normalizeSpace(note)
      if (noteNorm.length < MIN_DECISIVE_NOTE_LENGTH) {
        sawShortPair = true
        continue
      }
      decisiveNotes.push(noteNorm)
    }
  }

  if (decisiveNotes.length === 0) {
    if (sawUnreliableEndpoint) return "undecidable"
    // 只有短描述（「友」「敌」）= 信息量不足；连端点关系都没有 = 状态里确实没有这条。
    return sawShortPair ? "undecidable" : "not-covered"
  }

  // 全部决定性描述都必须覆盖；任一条对不上就是真缺口。
  return decisiveNotes.every((noteNorm) => noteCovered(haystack, noteNorm)) ? "covered" : "not-covered"
}

/**
 * 审计资产联动一致性。只读：不修改入参、不写盘、不联网。
 */
export function auditAssetLinkage(input: AssetLinkageAuditInput): AssetLinkageAuditResult {
  const conflicts: LinkageConflict[] = []
  const na: string[] = []

  // ── 1. relationship 产物漂移 ────────────────────────────────────────────
  if (input.charactersLoaded === false) {
    return {
      conflicts: [],
      na: [
        "角色状态尚未装载：比对面整段 N/A（不按空集判漂移，避免把「加载中」显示成「不一致」）。",
      ],
      derivedEdgeCount: null,
      artifactEdgeCount: input.relationshipArtifact?.entryCount ?? null,
    }
  }

  const derivedEdges = derivedEdgesFor(input.characters)
  const derivedEdgeCount = derivedEdges.length
  let artifactEdgeCount: number | null = null

  if (input.relationshipArtifact === null) {
    artifactEdgeCount = null
    na.push(
      "relationship 产物：尚未迁移到资产库（属提取缺口，不是漂移；不在这里报 consistency 失败）",
    )
  } else {
    artifactEdgeCount = input.relationshipArtifact.entryCount
    const rebuilt = buildLibraryArtifact({
      libraryId: "relationship_edge",
      generatorVersion: "asset-linkage-audit",
      generatedAt: "1970-01-01T00:00:00.000Z",
      entries: derivedEdges,
    })
    if (rebuilt.contentHash !== input.relationshipArtifact.contentHash) {
      conflicts.push({
        code: "relationship_edge_drift",
        left: rebuilt.contentHash,
        right: input.relationshipArtifact.contentHash,
        detail:
          derivedEdgeCount === artifactEdgeCount
            ? `产物 contentHash 与角色状态复算结果不一致（条数相同=内容字段不同，例如关系描述被改过）。产物是旧快照，重建只能走既有迁移入口，本诊断不自动改。`
            : `产物 contentHash 不一致，且条数也不同：状态可复算 ${derivedEdgeCount} 条、产物 ${artifactEdgeCount} 条。产物是旧快照，重建只能走既有迁移入口，本诊断不自动改。`,
      })
    }
  }

  // ── 2. 快照关系事实未进状态（今天生产路径的回归锁）────────────────────
  let uncovered = 0
  let undecidable = 0
  const snapshotLines = input.snapshotRelationLines ?? []
  // 已知名集合：角色状态名 + 关系对端名。最长匹配只信任这里出现的名字。
  const knownNames = [
    ...new Set([
      ...input.characters.map((character) => (character.characterName ?? "").trim()).filter(Boolean),
      ...input.characters.flatMap((character) =>
        Object.keys(character.relationships ?? {}).map((name) => name.trim()).filter(Boolean),
      ),
    ]),
  ]
  for (const line of snapshotLines) {
    const judged = judgeCoverage(line.text, input.characters, knownNames)
    if (judged === "covered") continue
    if (judged === "undecidable") {
      undecidable += 1
      continue
    }
    uncovered += 1
    conflicts.push({
      code: "snapshot_relation_not_in_state",
      left: `第 ${line.chapterNumber} 章`,
      right: line.text,
      detail:
        "快照记录了关系变更，但角色状态的关系表里没有能覆盖它的条目（状态未回填，后续章节会按旧关系写）。",
    })
  }
  if (undecidable > 0) {
    na.push(
      `有 ${undecidable} 条快照关系事实无法判定（描述过短，有效字符 < ${MIN_DECISIVE_NOTE_LENGTH}；或端点含单字名、空行），记 N/A，不计入冲突。`,
    )
  }
  if (input.snapshotRelationLines === undefined) {
    na.push("快照关系事实：本页未装载快照，这一面**未检查**（不是「没有关系变更」）")
  } else if (snapshotLines.length === 0) {
    na.push("快照关系事实：已装载快照，但没有任何 relationshipChanges 条目，本面 N/A")
  }

  // ── 3. 图谱边对账（可选面）────────────────────────────────────────────
  const graphEdges = input.graphEdgeKeys
  const snapshotGraphEdges = input.snapshotGraphEdgeKeys
  if (graphEdges === undefined || snapshotGraphEdges === undefined) {
    na.push(
      "图谱边：未同时提供「当前图谱边」与「快照应有边」，本面 N/A（纯函数不内部读 wiki）",
    )
  } else {
    const current = new Set(graphEdges)
    const expected = new Set(snapshotGraphEdges)
    for (const key of expected) {
      if (!current.has(key)) {
        const parts = key.split("->")
        const [from, to] = parts.length === 2 ? parts : [key, key]
        conflicts.push({
          code: "graph_edge_missing",
          left: from,
          right: to,
          detail: "快照应有这条图谱边，但当前知识图谱上没有（图谱未随章节更新）。",
        })
      }
    }
    for (const key of current) {
      if (!expected.has(key)) {
        const parts = key.split("->")
        const [from, to] = parts.length === 2 ? parts : [key, key]
        conflicts.push({
          code: "graph_edge_unbacked",
          left: from,
          right: to,
          detail: "知识图谱上有这条边，但快照里没有对应事实（来源不明，需人工确认，不自动删）。",
        })
      }
    }
  }

  // ── 4. 永远不报的面 ──────────────────────────────────────────────────
  na.push(
    "关系语义（kind）：既有条目一律 `unknown`，自由文本不构成冲突；不猜语义种类。",
  )
  na.push(
    "角色状态字段（status/存活）与设定投影：由既有 fold drift / 设定投影负责，本诊断不重复第二套结论。",
  )
  if (uncovered === 0 && snapshotLines.length > 0) {
    na.push("没有发现「快照有关系、状态没回填」的条目。")
  }

  return { conflicts, na, derivedEdgeCount, artifactEdgeCount }
}
