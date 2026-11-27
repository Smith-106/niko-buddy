/**
 * canon-backfill.ts — Canon 历史回填（T30b / F-14 / A-05.3）。
 *
 * ## 职责（蓝图 §6 T30b）
 *   既有项目（canon 迁移前已积累章节快照的项目）第 1..N-1 章**离线摄取**回填 canon，
 *   使迁移前事实经 canon 读出口可查询。回填是 T16 实时双写钩子的**离线重放**：
 *
 *   1. **快照发现**：扫描 `.novel/snapshots/NNN.snapshot.json`（正文章；outline-
 *      前缀 / .snapshot.md / history 子目录等非正文名一律不匹配），派生可回填
 *      章节集（升序、去重）。
 *   2. **操作派生**：逐章读快照 JSON → `normalizeChapterSnapshot` 规范化 → 逐条
 *      `newCanonFacts` 派生 `CanonDualWriteOp`。digest 契约与 T16
 *      `buildCanonDualWriteOps` **逐字节同构**（`SHA-256(stable({chapter, fact}))`，
 *      episode id = `ch{n}-fact{i}`）——同一事实无论实时写入还是离线回填，
 *      落库键完全一致，canon_store 的 `(chapter_number, digest)` 幂等去重天然收敛。
 *   3. **影子双写编排复用**：逐章调 T15 `shadowWriteCanon`（旧 view 影子 + canon_store
 *      并行写 + 对账；写失败落 `.novel/canon-pending.jsonl` 持久队列，digest 幂等 +
 *      指数退避封顶）。本模块**不复制任何双写/队列/重放逻辑**——失败恢复由既有
 *      T15 `replayPendingQueue` / T17 两阶段重放原语承接。
 *   4. **可查询审计**：`auditPreMigrationFacts` 以 T14 投影读出口 `CanonFact[]`
 *      （`queryCanonEdges` 等封装的返回物）为输入，按章核对迁移前事实是否可查，
 *      作为「迁移前事实经 canon_query 可查」的验收 seam。
 *
 * ## P1-5/F-006 源感知合并硬保证 —— 设计评估（本任务只评估，不承诺实现）
 *   蓝图增强注记（2026-08-19，32 仓库报告）：记忆回填时源感知合并须保证
 *   「用户手工编辑永不覆盖」（StoryForge 资产回流模式）。本任务的评估结论见
 *   `SOURCE_AWARE_MERGE_EVALUATION` 常量 + `classifyBackfillMerge` 纯分类器：
 *   回填路径上该保证由三个**已在位机制**结构性成立（store 幂等去重 / append-only /
 *   wiki 写面隔离），无需新实现；唯一缺口（用户手改历史事实后的 supersede 路由）
 *   明确记为 designed-not-implemented，不在本任务承诺范围。
 *
 * ## Draft-first / ADR-19
 *   纯控制/机械编排（零 LLM、零网络）：只读本地快照 JSON + 经注入依赖写 canon。
 *   Draft-first 不适用；digest 全部走 T07 `computeCheckpointDigestOf` 纯 crypto。
 *
 * 遵循 Niko Buddy CLAUDE.md：T30b 新增锚点，落 `src/lib/novel/`；运行期数据在 `.novel/`
 * （ADR-16）；模式提取而非代码融合（ADR-20）。
 */

import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  canonPendingQueuePath,
  defaultCanonDualWriteDeps,
  loadPendingQueue,
  reconcileOutcomes,
  resolvePriorEdgesForSupersede,
  shadowWriteCanon,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonPendingRecord,
  type CanonWriteOutcome,
} from "./canon-dual-write"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  collectSnapshotKnownBy,
  findMatchingPriorEdgeIds,
  parseCanonFactTriple,
} from "./chapter-ingest-utils"
import { normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import type { CanonFact, RawCanonEdge } from "./canon-graph-client"
import { queryEpisodesByChapter } from "./canon-graph-client"
import {
  loadNovelSessionStatus,
  setCanonMigrationMode,
  type CanonMigrationMode,
  type NovelSessionStatus,
} from "./novel-session-status"
import { promote, promotionAudit } from "./promotion-bridge"
import { logger } from "@/lib/utils"
import { toErrorMessage } from "@/lib/utils"

// ──────────────────────────────────────────────────────────────────────────
// 快照发现（路径 + 文件名契约）
// ──────────────────────────────────────────────────────────────────────────

/** 章节快照目录段（ADR-16：每项目运行期数据在 `.novel/`）。 */
export const SNAPSHOTS_DIR_SEGMENT = ".novel/snapshots"

/** 项目快照目录：`{projectPath}/.novel/snapshots`。 */
export function snapshotsDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${SNAPSHOTS_DIR_SEGMENT}`
}

/**
 * 正文章快照文件名匹配（严格 `^(\d{3,})\.snapshot\.json$`，支持 >=1000 章）：
 * - `001.snapshot.json` → 1、`1000.snapshot.json` → 1000 … 匹配；
 * - `outline-001.snapshot.json`（大纲）、`.snapshot.md`（人读版）、history/ 子目录
 *   内带时间戳文件名、任何含路径分隔符/父目录片段的名字 → 一律不匹配。
 * 返回 null 表示非可回填条目。
 */
export function parseChapterSnapshotFileName(name: string): number | null {
  const m = /^(\d{3,})\.snapshot\.json$/.exec(name)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

/** 快照目录条目（结构化最小面；兼容 fs `FileNode`）。 */
export interface SnapshotsDirEntry {
  name: string
}

/** 从目录条目解析可回填章节号集合（升序、去重；忽略目录与非快照条目）。 */
export function parseDiscoveredChapters(entries: readonly SnapshotsDirEntry[]): number[] {
  const found = new Set<number>()
  for (const e of entries) {
    const ch = parseChapterSnapshotFileName(e.name)
    if (ch != null) found.add(ch)
  }
  return [...found].sort((a, b) => a - b)
}

// ──────────────────────────────────────────────────────────────────────────
// 回填依赖（全部副作用注入；默认实现见 `defaultCanonBackfillDeps`）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 历史回填依赖。快照 IO 与双写分离注入：单测可全内存 mock（无 Tauri/fs），
 * 运行期由 `defaultCanonBackfillDeps()` 接真实 fs + T15 默认双写依赖。
 */
export interface CanonBackfillDeps {
  /** 列快照目录条目（不存在/失败应返回空数组而非抛错）。 */
  listSnapshotsDir: (dir: string) => Promise<SnapshotsDirEntry[]>
  /** 读单个快照文件原始文本（抛错由调用方容错处理）。 */
  readSnapshotText: (path: string) => Promise<string>
  /** T15 双写依赖（旧 view 影子 + canon 写 + 持久待写队列）。 */
  dualWrite: CanonDualWriteDeps
  /** 可选：查询 `canon.db` 中既有活跃边以种子化先序冲突 `old_edge_ids`（缺省走安全非致命 `resolvePriorEdgesForSupersede`）。 */
  queryExistingEdges?: (
    projectPath: string,
    candidateEdges: ReadonlyArray<{ source_id: string; predicate: string }>,
  ) => Promise<RawCanonEdge[]>
}

/**
 * 默认回填依赖：真实 fs（IPC）+ T15 默认双写依赖（真实 IPC + 原子队列写）。
 * 目录缺失/权限失败视为空项目（空回填），不阻断调用方。
 */
export function defaultCanonBackfillDeps(): CanonBackfillDeps {
  return {
    dualWrite: defaultCanonDualWriteDeps(),
    listSnapshotsDir: async (dir: string): Promise<SnapshotsDirEntry[]> => {
      try {
        return await listDirectory(dir)
      } catch {
        return []
      }
    },
    readSnapshotText: (path: string): Promise<string> => readFile(path),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 章节范围（1..N-1 语义）
// ──────────────────────────────────────────────────────────────────────────

/** 回填范围选项：闭区间下界（默认 1）+ **排他**上界 N（回填 `< N`，即「第 1..N-1 章」）。 */
export interface CanonBackfillOptions {
  /** 下界（含），默认 1。 */
  firstChapter?: number
  /**
   * 排他上界 N：仅回填 `chapter < N`。缺省 = 发现的所有章节全量回填
   * （既有项目当前写作位置 N 尚无快照，故发现集天然 ≤ N-1）。
   */
  exclusiveUpperBound?: number
}

/** 按选项过滤章节集（保持升序）。 */
export function filterBackfillRange(
  chapters: readonly number[],
  options: CanonBackfillOptions = {},
): number[] {
  const first = options.firstChapter ?? 1
  const bound = options.exclusiveUpperBound
  return chapters.filter((c) => c >= first && (bound == null || c < bound))
}

// ──────────────────────────────────────────────────────────────────────────
// 快照加载（规范化 + 容错）
// ──────────────────────────────────────────────────────────────────────────

function chapterSnapshotPath(projectPath: string, chapter: number): string {
  const prefix = String(chapter).padStart(3, "0")
  return `${snapshotsDir(projectPath)}/${prefix}.snapshot.json`
}

/**
 * 读并规范化单章快照；任何失败（IO 抛错 / 非 JSON / 非对象）→ null（跳过该章，
 * 绝不让单个坏快照中断整批回填）。
 *
 * 章节号以**文件名派生值**为准（强制覆盖 raw.chapterNumber）：离线重放的权威键是
 * 快照在磁盘上的位置，raw 字段缺失或漂移都不改变 digest 键的确定性。
 */
export async function loadBackfillSnapshot(
  deps: Pick<CanonBackfillDeps, "readSnapshotText">,
  projectPath: string,
  chapter: number,
): Promise<ChapterSnapshot | null> {
  try {
    const raw = await deps.readSnapshotText(chapterSnapshotPath(projectPath, chapter))
    const parsed = normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapter}`,
      chapterNumber: chapter,
    })
    if (!parsed) return null
    return { ...parsed, chapterNumber: chapter }
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 操作派生（T16 buildCanonDualWriteOps digest 契约镜像）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 从历史快照派生双写操作集 —— 与 T16 `buildCanonDualWriteOps` 逐字段同构：
 *
 * - assertive 事实：`content = { chapter: snapshot.chapterNumber, fact }`，
 *   `digest = SHA-256(stableStringify(content))`，
 *   `episode.id = ch{n}-ep-{digest.slice(0, 12)}`（content-digest ID，消除槽位漂移）。
 * - 模态事实（`beliefFacts` / `hypothesisFacts`）：派生 `supersede` new_edges 边 ops，
 *   `edge.id = ch{n}-mod-{digest.slice(0, 12)}`、`modality = belief | hypothesis`。
 *
 * 同构的意义：实时双写与离线回填对同一事实产出**相同幂等键与内容 ID**，
 * canon_store 去重后两路来源收敛为单行——重放回填绝不产生重复事实。
 */
export interface BuildBackfillOpsOptions {
  /** 可选：用于按目标实体/谓词查询先序活跃 world_fact 边以填充 `old_edge_ids`（IPC 不可用时非致命回退 `[]`）。 */
  projectPath?: string
  /** 可选：直接注入现存活跃边快照（优先于 `projectPath` IPC 查询，用于离线计算、单测与多章顺序累计）。 */
  existingEdges?: readonly RawCanonEdge[]
  /**
   * 可选：本轮被修订替换的同章旧事实集合（可为旧事实原文、旧 edge id 或旧 edge digest）。
   * 命中时允许封顶对应同章旧 `world_fact` / 模态边（绝不自封同快照新边）。
   */
  supersededFacts?: ReadonlySet<string>
  /**
   * 可选：修订章重跑回填时为 `true`，允许同章既有活跃冲突边（`valid_at === chapterNumber`
   * 且不在当前快照新边集合内）并入 `old_edge_ids`。默认 `false`。
   */
  includeSameChapterConflict?: boolean
}

function collectSnapshotCandidateKeys(
  snapshot: ChapterSnapshot,
): Array<{ source_id: string; predicate: string }> {
  const keys: Array<{ source_id: string; predicate: string }> = []
  for (const fact of snapshot.newCanonFacts ?? []) {
    const { sourceId, predicate } = parseCanonFactTriple(fact, snapshot.chapterId)
    keys.push({ source_id: sourceId, predicate })
  }
  for (const mf of snapshot.beliefFacts ?? []) {
    keys.push({ source_id: mf.subject, predicate: mf.predicate })
  }
  for (const mf of snapshot.hypothesisFacts ?? []) {
    keys.push({ source_id: mf.subject, predicate: mf.predicate })
  }
  return keys
}

export async function buildBackfillOps(
  snapshot: ChapterSnapshot,
  options?: BuildBackfillOpsOptions,
): Promise<CanonDualWriteOp[]> {
  const facts = snapshot.newCanonFacts ?? []
  const beliefFacts = snapshot.beliefFacts ?? []
  const hypothesisFacts = snapshot.hypothesisFacts ?? []
  if (facts.length === 0 && beliefFacts.length === 0 && hypothesisFacts.length === 0) return []

  const snapshotKnownBy = collectSnapshotKnownBy(snapshot)

  const episodeOps: CanonDualWriteOp[] = facts.length > 0
    ? await Promise.all(
        facts.map(async (fact) => {
          const content = { chapter: snapshot.chapterNumber, fact }
          const digest = await computeCheckpointDigestOf(content)
          return {
            digest,
            content,
            legacyPayload: { kind: "snapshot_fact", chapterNumber: snapshot.chapterNumber, fact },
            canonPayload: {
              kind: "episode" as const,
              episode: {
                id: `ch${snapshot.chapterNumber}-ep-${digest.slice(0, 12)}`,
                chapter_number: snapshot.chapterNumber,
                entity_id: snapshot.chapterId, // DEBT-20260820-16: ChapterSnapshot 无 entityId 字段，以 chapterId 作 entity_id（章节级实体）。
                summary: fact,
                digest,
              },
            },
          }
        }),
      )
    : []

  const worldFactDrafts = facts.length > 0
    ? await Promise.all(
        facts.map(async (fact) => {
          const { sourceId, predicate, targetId } = parseCanonFactTriple(fact, snapshot.chapterId)
          const content = {
            chapter: snapshot.chapterNumber,
            kind: "world_fact" as const,
            fact,
            sourceId,
            predicate,
            targetId,
          }
          const digest = await computeCheckpointDigestOf(content)
          const edge = {
            id: `ch${snapshot.chapterNumber}-wf-${digest.slice(0, 12)}`,
            source_id: sourceId,
            target_id: targetId,
            predicate,
            edge_kind: "world_fact" as const,
            valid_at: snapshot.chapterNumber,
            source_chapter: snapshot.chapterNumber,
            revealed_at: snapshot.chapterNumber,
            known_by: snapshotKnownBy,
            modality: "assertive" as const,
            digest,
          }
          return {
            digest,
            content,
            legacyPayload: {
              kind: "snapshot_world_fact",
              chapterNumber: snapshot.chapterNumber,
              fact,
              subject: sourceId,
              predicate,
              object: targetId,
            },
            edge,
          }
        }),
      )
    : []

  const modalityDrafts = await Promise.all(
    [
      ...beliefFacts.map((f) => ({ ...f, modality: "belief" as const })),
      ...hypothesisFacts.map((f) => ({ ...f, modality: "hypothesis" as const })),
    ].map(async (mf) => {
      const content = {
        chapter: snapshot.chapterNumber,
        modality: mf.modality,
        fact: `${mf.subject}${mf.predicate}${mf.object}`,
      }
      const digest = await computeCheckpointDigestOf(content)
      const edge = {
        id: `ch${snapshot.chapterNumber}-mod-${digest.slice(0, 12)}`,
        source_id: mf.subject,
        target_id: mf.object,
        predicate: mf.predicate,
        edge_kind: "world_fact" as const,
        valid_at: snapshot.chapterNumber,
        source_chapter: snapshot.chapterNumber,
        revealed_at: snapshot.chapterNumber,
        known_by: collectSnapshotKnownBy(snapshot, [mf.subject]),
        modality: mf.modality,
        digest,
      }
      return {
        digest,
        content,
        legacyPayload: {
          kind: "snapshot_modality_fact",
          chapterNumber: snapshot.chapterNumber,
          modality: mf.modality,
          subject: mf.subject,
          predicate: mf.predicate,
          object: mf.object,
        },
        edge,
      }
    }),
  )

  let priorEdges: readonly RawCanonEdge[] = []
  const candidateEdges = [
    ...worldFactDrafts.map((d) => d.edge),
    ...modalityDrafts.map((d) => d.edge),
  ]
  if (candidateEdges.length > 0 && options) {
    if (options.existingEdges) {
      priorEdges = options.existingEdges
    } else if (options.projectPath) {
      priorEdges = await resolvePriorEdgesForSupersede(options.projectPath, candidateEdges)
    }
  }

  const currentSnapshotEdgeIds = new Set<string>(candidateEdges.map((e) => e.id))
  const includeSameChapter = options?.includeSameChapterConflict === true
  const supersededFacts = options?.supersededFacts
  let supersededTriples: Array<{ sourceId: string; predicate: string; targetId: string }> | null = null

  const resolveOldEdgeIds = (edge: (typeof candidateEdges)[number]): string[] => {
    const baseIds = findMatchingPriorEdgeIds(priorEdges, snapshot.chapterNumber, edge, {
      includeSameChapterConflict: includeSameChapter,
      excludeEdgeIds: currentSnapshotEdgeIds,
    })
    if (includeSameChapter || !supersededFacts || supersededFacts.size === 0 || priorEdges.length === 0) {
      return baseIds
    }
    if (supersededTriples === null) {
      supersededTriples = [...supersededFacts].map((raw) => parseCanonFactTriple(raw, snapshot.chapterId))
    }
    const matched = new Set<string>(baseIds)
    const sameChapterIds = findMatchingPriorEdgeIds(priorEdges, snapshot.chapterNumber, edge, {
      includeSameChapterConflict: true,
      excludeEdgeIds: currentSnapshotEdgeIds,
    })
    for (const edgeId of sameChapterIds) {
      if (matched.has(edgeId)) continue
      const prior = priorEdges.find((e) => e.id === edgeId)
      if (!prior) continue
      const isExplicitlySuperseded =
        supersededFacts.has(prior.id) ||
        (typeof prior.digest === "string" && supersededFacts.has(prior.digest)) ||
        supersededTriples.some(
          (t) =>
            t.sourceId === prior.source_id &&
            t.predicate === prior.predicate &&
            t.targetId === prior.target_id,
        )
      if (isExplicitlySuperseded) {
        matched.add(edgeId)
      }
    }
    return [...matched]
  }

  const worldFactOps: CanonDualWriteOp[] = worldFactDrafts.map((d) => ({
    digest: d.digest,
    content: d.content,
    legacyPayload: d.legacyPayload,
    canonPayload: {
      kind: "supersede" as const,
      request: {
        old_edge_ids: resolveOldEdgeIds(d.edge),
        cap_chapter: snapshot.chapterNumber,
        caused_by: "snapshot-world-facts",
        new_edges: [d.edge],
      },
    },
  }))

  const modalityOps: CanonDualWriteOp[] = modalityDrafts.map((d) => ({
    digest: d.digest,
    content: d.content,
    legacyPayload: d.legacyPayload,
    canonPayload: {
      kind: "supersede" as const,
      request: {
        old_edge_ids: resolveOldEdgeIds(d.edge),
        cap_chapter: snapshot.chapterNumber,
        caused_by: "snapshot-modality-facts",
        new_edges: [d.edge],
      },
    },
  }))

  return [...episodeOps, ...worldFactOps, ...modalityOps]
}

// ──────────────────────────────────────────────────────────────────────────
// P1-5/F-006 源感知合并硬保证 —— 设计评估工件（评估，不承诺实现）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 源感知合并硬保证的设计评估结论（蓝图 T30b 增强注记，2026-08-19）。
 *
 * `evaluatedDesignOnly: true` 表明本任务**不承诺**新的源感知合并实现；
 * 保证由 `mechanismsInPlace` 所列的三个已在位机制结构性成立。
 */
export const SOURCE_AWARE_MERGE_EVALUATION = {
  requirementRefs: ["P1-5", "F-006"],
  hardGuarantee: "用户手工编辑永不覆盖（StoryForge 资产回流模式的源感知合并）",
  evaluatedDesignOnly: true,
  mechanismsInPlace: [
    "store 幂等去重：canon_store ingest 按 (chapter_number, digest) 去重（T11/T13），同一事实重放/回填不复制也不覆盖",
    "append-only 回填：本模块只发 episode 摄取，绝不对既有边/事实发 supersede/invalidate；事实文本变更 → 新 digest → 新行追加，旧行保留",
    "wiki 写面隔离：回填只经 shadowWriteCanon（canon + legacy 影子负载），不触达 graph-adapter 的 mergeExistingPage / writePatchFieldsToWiki（F-006 用户编辑保护面）——结构上不可达即不可破坏",
  ],
  designedNotImplemented: [
    "fact槽位位置索引漂移：同一事实在 chapters 间插入/删除导致 fact[i] 语义漂移时，槽位 i 对应的旧行与新行可能不是同一事实。本轮文档化限制不修 schema——后续需按事实语义匹配（而非槽位索引）检测分歧",
  ],
  /** DEBT-20260621-30b 偿还注记：supersede 路由已实现（2026-08-21）。
   *  detectSupersedeDivergences 在 buildBackfillOps 后查询已存 episodes，
   *  按 (chapter, slot) 比较 digest；分歧时生成 supersede_by_digest op
   *  （digest={chapter,slot,oldDigest,newDigest}），经 shadowWriteCanon
   *  封顶旧边（先写新 episode 再封旧边，避免事实暂时消失）。 */
  debtRepaid: {
    debtId: "DEBT-20260621-30b",
    repaidAt: "2026-08-21",
    summary: "supersede 路由已实现：分歧检测 → supersede_by_digest 封顶旧边",
  },
} as const

// ──────────────────────────────────────────────────────────────────────────
// DEBT-20260621-30b：supersede 分歧检测（回填时检测已存 episode 的 digest 变更）
// ──────────────────────────────────────────────────────────────────────────

/** 单条分歧检测结果。 */
export interface SupersedeDivergence {
  /** 事实槽位索引（ch{n}-fact{i} 中的 i）。 */
  slot: number
  /** 已存 episode 的旧 digest。 */
  oldDigest: string
  /** 新回填的 digest。 */
  newDigest: string
}

/**
 * 检测回填 ops 与已存 episodes 的 digest 分歧。
 *
 * 逻辑：
 * 1. 查询该章已存 episodes（经 canon_query_episodes IPC）
 * 2. 按 episode id 中的槽位索引（ch{n}-fact{i}）分组
 * 3. 对每个新 op，若同槽位已存在 episode 且 digest 不同 → 分歧
 * 4. 返回分歧列表（旧行与新行语义并存但需封顶旧边）
 *
 * ## 已知限制（fact槽位位置索引漂移）
 *   同一事实在章节间插入/删除导致 fact[i] 语义漂移时，槽位 i 对应的
 *   旧行与新行可能不是同一事实（false positive divergence）。本轮不修
 *   schema——后续需按事实语义匹配（而非槽位索引）检测分歧。
 *
 * @param projectPath 项目路径（canon DB projectId）
 * @param chapter    章节号
 * @param ops        新回填 episode ops（buildBackfillOps 产物）
 * @returns 分歧列表；空数组 = 无分歧（全量幂等或首次回填）
 */
export async function detectSupersedeDivergences(
  projectPath: string,
  chapter: number,
  ops: CanonDualWriteOp[],
): Promise<SupersedeDivergence[]> {
  const episodeOps = ops.filter((op) => op.canonPayload.kind === "episode")
  if (episodeOps.length === 0) return []

  // 查询已存 episodes
  let existing: Array<{ id: string; digest: string }>
  try {
    const res = await queryEpisodesByChapter(projectPath, chapter)
    existing = res.episodes.map((ep) => ({ id: ep.id, digest: ep.digest }))
  } catch {
    // 查询失败（如 DB 未初始化）→ 视为无已存数据，无分歧
    return []
  }
  if (existing.length === 0) return []

  // 1) 历史兼容：旧槽位格式 episode id = "ch{n}-fact{i}" → 按槽位 i 对比
  const existingBySlot = new Map<number, string>()
  const existingDigestEntries: Array<{ id: string; digest: string }> = []
  const existingAllDigests = new Set<string>()
  for (const ep of existing) {
    if (ep.digest) existingAllDigests.add(ep.digest)
    const legacyMatch = /^ch\d+-fact(\d+)$/.exec(ep.id)
    if (legacyMatch) {
      const slot = Number(legacyMatch[1])
      existingBySlot.set(slot, ep.digest)
    } else if (/^ch\d+-ep-[0-9a-f]{12}$/i.test(ep.id)) {
      existingDigestEntries.push(ep)
    }
  }

  const divergences: SupersedeDivergence[] = []
  const recordedOldDigests = new Set<string>()
  const newEpisodeDigests: string[] = []
  const newEpisodeDigestSet = new Set<string>()
  for (let i = 0; i < episodeOps.length; i++) {
    const op = episodeOps[i]!
    const newDigest = op.digest
    if (!newDigest) continue
    newEpisodeDigests.push(newDigest)
    newEpisodeDigestSet.add(newDigest)
    const oldDigest = existingBySlot.get(i)
    if (oldDigest != null && oldDigest !== newDigest) {
      divergences.push({ slot: i, oldDigest, newDigest })
      recordedOldDigests.add(oldDigest)
    }
  }

  // 2) 新格式 content-digest ID（ch{n}-ep-{hash12}）：按 digest 集合差检测失效旧事实，
  //    消除重排导致的假阳性分歧。
  if (existingDigestEntries.length > 0 && newEpisodeDigests.length > 0) {
    const addedDigests = newEpisodeDigests.filter((d) => !existingAllDigests.has(d))
    let addCursor = 0
    for (let idx = 0; idx < existingDigestEntries.length; idx++) {
      const ep = existingDigestEntries[idx]!
      if (!ep.digest || newEpisodeDigestSet.has(ep.digest) || recordedOldDigests.has(ep.digest)) {
        continue
      }
      const pairedNewDigest = addedDigests[addCursor] ?? newEpisodeDigests[0]!
      addCursor += 1
      divergences.push({ slot: idx, oldDigest: ep.digest, newDigest: pairedNewDigest })
      recordedOldDigests.add(ep.digest)
    }
  }

  return divergences
}

/**
 * 从分歧列表派生 supersede ops（DEBT-20260621-30b）。
 *
 * 每条 supersede op：
 * - digest = SHA-256({chapter, slot, oldDigest, newDigest})（队列幂等键）
 * - canonPayload.kind = "supersede_by_digest"
 * - canonPayload.request = { oldDigest, capChapter: chapter, newDigest }
 *
 * supersede_by_digest 由 canonStoreWriter 处理：按 oldDigest 查边 →
 * canon_supersede_edges 封顶旧边。new_edges 为空——新 episode 已由 episode
 * ops 先写入（先写新再封旧，避免事实暂时消失）。
 */
export async function buildSupersedeOps(
  chapter: number,
  divergences: SupersedeDivergence[],
): Promise<CanonDualWriteOp[]> {
  return Promise.all(
    divergences.map(async (d) => {
      const content = { chapter, slot: d.slot, oldDigest: d.oldDigest, newDigest: d.newDigest }
      const digest = await computeCheckpointDigestOf(content)
      return {
        digest,
        content,
        legacyPayload: { kind: "supersede_snapshot", chapter, slot: d.slot },
        canonPayload: {
          kind: "supersede_by_digest" as const,
          request: { oldDigest: d.oldDigest, capChapter: chapter, newDigest: d.newDigest },
        },
      }
    }),
  )
}

/** 合并决策分类（纯投影，不做任何写）。 */
export type BackfillMergeDecision = "skip-existing" | "append-new"

/** 单条事实的源感知合并分类结果。 */
export interface BackfillMergeDecisionReport {
  /** 传入事实的幂等键。 */
  digest: string
  /** skip-existing = 已存在（去重跳过）；append-new = 不存在（追加新行）。 */
  decision: BackfillMergeDecision
  /**
   * P1-5/F-006 硬保证不变量：两种 decision 下用户手工编辑都永不覆盖
   * （skip 不触碰任何行；append 只增不改）。恒为 true。
   */
  userEditsPreserved: true
  rationale: string
}

/**
 * 对一条待回填事实做源感知合并分类（设计评估的可执行投影）。
 *
 * 这是**分类器不是执行器**：真正的去重在 canon_store `(chapter_number, digest)`
 * 写路径幂等层发生；本函数把「会发生什么」显式化，供回填报告与未来
 * supersede 路由（designed-not-implemented）消费。
 */
export function classifyBackfillMerge(
  existingDigests: ReadonlySet<string>,
  digest: string,
): BackfillMergeDecisionReport {
  if (existingDigests.has(digest)) {
    return {
      digest,
      decision: "skip-existing",
      userEditsPreserved: true,
      rationale: "(chapter,digest) 已存在于 canon，重放幂等跳过，不触碰任何既有行",
    }
  }
  return {
    digest,
    decision: "append-new",
    userEditsPreserved: true,
    rationale: "新 digest 追加为新行；既有行（含用户手改产生的变体）全部保留，永不覆盖",
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 迁移前事实可查询审计（T14 投影读出口验收 seam）
// ──────────────────────────────────────────────────────────────────────────

/** 单章可查询期望：该章至少应有 `minFacts` 条事实可查（缺省 1）。 */
export interface PreMigrationAuditExpectation {
  chapter: number
  minFacts?: number
}

export interface PreMigrationAuditResult {
  chapter: number
  found: number
  meets: boolean
}

export interface PreMigrationAuditReport {
  /** 所有期望章均达标才为 true。 */
  queryable: boolean
  results: PreMigrationAuditResult[]
}

/**
 * 核对迁移前事实是否经 canon 读出口可查。
 *
 * 输入是 T14 `canon-graph-client` 投影产物 `CanonFact[]`（如 `queryCanonEdges`
 * / `getFactsKnownBy` 的返回值，已经 allowlist 投影 + 禁句柄外泄守护）。按
 * `sourceChapter` 分组计数并与期望比较。空期望集视为 trivially queryable。
 */
export function auditPreMigrationFacts(
  facts: readonly CanonFact[],
  expectations: readonly PreMigrationAuditExpectation[],
): PreMigrationAuditReport {
  const counts = new Map<number, number>()
  for (const f of facts) {
    if (f.sourceChapter == null || f.archived) continue
    counts.set(f.sourceChapter, (counts.get(f.sourceChapter) ?? 0) + 1)
  }
  const results = expectations.map((e) => {
    const found = counts.get(e.chapter) ?? 0
    return { chapter: e.chapter, found, meets: found >= (e.minFacts ?? 1) }
  })
  return { queryable: results.every((r) => r.meets), results }
}

// ──────────────────────────────────────────────────────────────────────────
// 编排入口
// ──────────────────────────────────────────────────────────────────────────

/** 单章回填状态。 */
export type CanonBackfillChapterStatus =
  | "backfilled"
  | "no-facts"
  | "snapshot-unreadable"

export interface CanonBackfillChapterReport {
  chapter: number
  status: CanonBackfillChapterStatus
  factCount: number
  written: number
  queued: number
}

/** 整批回填报告。 */
export interface CanonBackfillReport {
  projectPath: string
  /** 快照目录发现的全部章节（未过滤）。 */
  discoveredChapters: number[]
  /** 实际尝试回填的章节（范围过滤后，升序）。 */
  selectedChapters: number[]
  factsTotal: number
  factsWritten: number
  factsQueued: number
  consistent: boolean
  divergences: { digest: string; reasons: string[] }[]
  perChapter: CanonBackfillChapterReport[]
}

/**
 * canon 历史回填编排入口：既有项目第 1..N-1 章离线摄取回填 canon。
 *
 * 流程：发现快照章节 → 范围过滤（升序确定性顺序）→ 逐章加载规范化 →
 * 派生双写操作 → 复用 T15 `shadowWriteCanon` 双写（失败自动入持久待写队列，
 * 由 T15/T17 既有重放原语补齐）→ 汇总对账。
 *
 * - 章级容错：坏快照/无事实章跳过并在报告中标注，不中断整批。
 * - 写级容错：单次双写失败不抛错（T15 语义），落队后继续；队列 IO 灾难性失败
 *   才向上传播（此时已写部分凭 store 幂等键安全重跑）。
 * - 幂等：任意时刻重复调用，同一 `(chapter, fact)` 永远映射同一 digest，
 *   store 去重后 canon 内容收敛不变。
 *
 * @param deps       回填依赖（默认 `defaultCanonBackfillDeps()`）。
 * @param projectPath 项目路径（亦作 canon DB projectId 与队列父目录）。
 * @param options    范围选项（`exclusiveUpperBound` 实现「第 1..N-1 章」语义）。
 * @param now        当前时间（epoch ms），透传给 T15 退避调度；测试注入定钟。
 */
export async function backfillCanonHistory(
  deps: CanonBackfillDeps,
  projectPath: string,
  options: CanonBackfillOptions = {},
  now: number = Date.now(),
): Promise<CanonBackfillReport> {
  const pp = normalizePath(projectPath)
  const entries = await deps.listSnapshotsDir(snapshotsDir(pp))
  const discoveredChapters = parseDiscoveredChapters(entries)
  const selectedChapters = filterBackfillRange(discoveredChapters, options)

  const perChapter: CanonBackfillChapterReport[] = []
  const allResults: CanonWriteOutcome[] = []
  const accumulatedActiveEdges = new Map<string, RawCanonEdge>()
  const invalidatedEdgeIds = new Set<string>()

  for (const chapter of selectedChapters) {
    const snapshot = await loadBackfillSnapshot(deps, pp, chapter)
    if (!snapshot) {
      perChapter.push({ chapter, status: "snapshot-unreadable", factCount: 0, written: 0, queued: 0 })
      continue
    }
    const candidateKeys = collectSnapshotCandidateKeys(snapshot)
    if (candidateKeys.length === 0) {
      perChapter.push({ chapter, status: "no-facts", factCount: 0, written: 0, queued: 0 })
      continue
    }
    // 种子化该章目标实体/谓词在 canon.db 中的既有活跃边（过滤本轮已封顶旧边；离线/mock 非致命降级）
    try {
      const existingFromStore = deps.queryExistingEdges
        ? await deps.queryExistingEdges(pp, candidateKeys)
        : await resolvePriorEdgesForSupersede(pp, candidateKeys)
      if (Array.isArray(existingFromStore)) {
        for (const edge of existingFromStore) {
          if (!edge?.id || edge.archived === true || edge.invalid_at != null) continue
          if (invalidatedEdgeIds.has(edge.id)) continue
          if (!accumulatedActiveEdges.has(edge.id)) {
            accumulatedActiveEdges.set(edge.id, edge)
          }
        }
      }
    } catch {
      // 非致命：沿用当前内存累计活跃边集
    }
    const ops = await buildBackfillOps(snapshot, {
      projectPath: pp,
      existingEdges: [...accumulatedActiveEdges.values()],
      includeSameChapterConflict: true,
    })
    if (ops.length === 0) {
      perChapter.push({ chapter, status: "no-facts", factCount: 0, written: 0, queued: 0 })
      continue
    }
    // DEBT-20260621-30b：supersede 分歧检测（buildBackfillOps 后、shadowWriteCanon 前）
    const divergences = await detectSupersedeDivergences(pp, chapter, ops)
    const supersedeOps = divergences.length > 0 ? await buildSupersedeOps(chapter, divergences) : []
    // op 顺序 = [...episodeOps, ...worldFactOps, ...modalityOps, ...supersedeOps]（先写新再封旧，避免事实暂时消失）
    const allOps = [...ops, ...supersedeOps]
    const report = await shadowWriteCanon(deps.dualWrite, pp, allOps, now)
    // 维护升序跨章活跃边集：仅对写入 canon 成功的 supersede 操作移除被封顶旧边并登记新活跃边
    for (let i = 0; i < allOps.length; i++) {
      const outcome = report.results[i]
      if (!outcome?.canon.ok) continue
      const op = allOps[i]!
      if (op.canonPayload.kind === "supersede") {
        const req = op.canonPayload.request as {
          old_edge_ids?: readonly string[]
          new_edges?: ReadonlyArray<{
            id?: string
            source_id?: string
            target_id?: string
            predicate?: string
            edge_kind?: RawCanonEdge["edge_kind"]
            valid_at?: number | null
            invalid_at?: number | null
            source_chapter?: number | null
            revealed_at?: number | null
            known_by?: string[] | null
            modality?: RawCanonEdge["modality"]
            digest?: string | null
          }>
        }
        for (const oldId of req.old_edge_ids ?? []) {
          accumulatedActiveEdges.delete(oldId)
          invalidatedEdgeIds.add(oldId)
        }
        for (const ne of req.new_edges ?? []) {
          if (
            typeof ne.id !== "string" ||
            !ne.id ||
            typeof ne.source_id !== "string" ||
            typeof ne.target_id !== "string" ||
            typeof ne.predicate !== "string"
          ) {
            continue
          }
          invalidatedEdgeIds.delete(ne.id)
          accumulatedActiveEdges.set(ne.id, {
            id: ne.id,
            source_id: ne.source_id,
            target_id: ne.target_id,
            predicate: ne.predicate,
            edge_kind: ne.edge_kind ?? "world_fact",
            valid_at: ne.valid_at ?? chapter,
            invalid_at: ne.invalid_at ?? null,
            source_chapter: ne.source_chapter ?? chapter,
            revealed_at: ne.revealed_at ?? chapter,
            known_by: ne.known_by ?? [],
            modality: ne.modality ?? "assertive",
            digest: ne.digest ?? op.digest ?? null,
            archived: false,
          })
        }
      } else if (op.canonPayload.kind === "supersede_by_digest") {
        const oldDigest = op.canonPayload.request.oldDigest
        for (const [edgeId, edge] of accumulatedActiveEdges.entries()) {
          if (edge.digest === oldDigest) {
            accumulatedActiveEdges.delete(edgeId)
            invalidatedEdgeIds.add(edgeId)
          }
        }
      }
    }
    // E-05 (C-4/C-6): canon-backfill 通道晋升接线。
    // 逐章 backfilled 成功后批量晋升（凭证层落盘 + 事件日志）；
    // revision 取 ChapterSnapshot.revision（C-2 权威字段，单调修订链）。
    // 失败/歧义 → promote 内部入 promotion-retry 队列 + warn（非致命，幂等重放收敛）。
    if (report.reconcile.consistent) {
      const revision =
        typeof snapshot.revision === "number" &&
        Number.isInteger(snapshot.revision) &&
        snapshot.revision >= 1
          ? snapshot.revision
          : 1
      for (const op of ops) {
        if (op.canonPayload.kind !== "episode") continue
        const ep = op.canonPayload.episode
        const chapterId =
          typeof ep.entity_id === "string" ? ep.entity_id : `ch${ep.chapter_number}`
        // DEBUG#8 / defensive D1：corrupt persisted chapter_number must not silently
        // substitute the fallback chapter into a canon credential write. Validate first.
        const parsedChapter = Number(ep.chapter_number)
        const chapterNumber =
          Number.isFinite(parsedChapter) && Number.isInteger(parsedChapter) && parsedChapter >= 1
            ? parsedChapter
            : chapter
        if (chapterNumber !== parsedChapter) {
          /* v8 ignore next -- 台账 canon-backfill.ts L571-574：chapter_number 由 parseChapterSnapshotFileName 正则保证 1..999 且 loadBackfillSnapshot 末尾强制覆盖，恒相等 */
          logger.warn(
            "promotion-bridge",
            `canon-backfill invalid chapter_number ${JSON.stringify(ep.chapter_number)} -> fallback chapter ${chapter}`,
          )
        }
        const episodeEntity =
          typeof ep.id === "string" && ep.id.trim().length > 0
            ? ep.id.trim()
            : (op.digest ? `ch${chapterNumber}-ep-${op.digest.slice(0, 12)}` : chapterId)
        try {
          await promote({
            channel: "canon-backfill",
            projectPath: pp,
            chapterId,
            chapterNumber,
            revision,
            entity: episodeEntity,
            gateContext: { rangeValid: true, snapshotReadable: true },
            contentDigestPrefix: op.digest ? op.digest.slice(0, 16) : undefined,
          })
        } catch (err) {
          logger.warn(
            "promotion-bridge",
            `canon-backfill promote failed (non-fatal, chapter ${chapter}): ${toErrorMessage(err)}`,
          )
        }
      }
    }
    allResults.push(...report.results)
    perChapter.push({
      chapter,
      status: "backfilled",
      factCount: ops.length,
      written: report.written,
      queued: report.queued,
    })
  }

  const reconcile = reconcileOutcomes(allResults)
  // E-05 (C-4): 回填后 promotionAudit 对账（凭证与库状态一致性，BND-CON-03）。
  // 只读审计 + 日志，不阻断回填主流程；不一致由重放/backfill 兜底收敛。
  try {
    const audit = await promotionAudit(pp)
    if (!audit.consistent) {
      logger.warn(
        "promotion-bridge",
        `canon-backfill promotionAudit inconsistent: recordWithoutEntry=${audit.recordWithoutEntry.length} entryWithoutRecord=${audit.entryWithoutRecord.length}`,
      )
    }
  } catch (err) {
    logger.warn(
      "promotion-bridge",
      `canon-backfill promotionAudit failed (non-fatal): ${toErrorMessage(err)}`,
    )
  }
  return {
    projectPath: pp,
    discoveredChapters,
    selectedChapters,
    factsTotal: allResults.length,
    factsWritten: allResults.filter((r) => r.consistent).length,
    factsQueued: allResults.filter((r) => !r.consistent).length,
    consistent: reconcile.consistent,
    divergences: reconcile.divergences,
    perChapter,
  }
}

/**
 * 当前项目入口：回填该项目快照目录里已发现的全部章节。
 * 不传 exclusiveUpperBound，因此不会停在「第 N-1 章」。
 * 不写章节正文，也不制造审查门、运行事件或 scenes.json。
 */
export async function runCanonHistoryBackfill(
  projectPath: string,
  deps: CanonBackfillDeps = defaultCanonBackfillDeps(),
  now: number = Date.now(),
): Promise<CanonBackfillReport> {
  const trimmed = projectPath.trim()
  if (!trimmed) {
    throw new Error("canon backfill requires an open project path")
  }
  return backfillCanonHistory(deps, trimmed, {}, now)
}

/** 受控 `canon_migration='dual'` 激活编排依赖（全部可注入，默认走真实 fs/canon/status 实现）。 */
export interface ActivateCanonDualMigrationDeps {
  backfill: CanonBackfillDeps
  loadStatus: (projectPath: string) => Promise<NovelSessionStatus | null>
  setMigrationMode: (
    projectPath: string,
    mode: CanonMigrationMode,
    options?: { onlyIfUnset?: boolean; createIfMissing?: boolean; now?: string },
  ) => Promise<NovelSessionStatus | null>
  loadPending: (dualWrite: CanonDualWriteDeps, queuePath: string) => Promise<CanonPendingRecord[]>
}

export type CanonDualMigrationActivationReason =
  | "activated"
  | "already_dual"
  | "explicit_legacy_preserved"
  | "backfill_inconsistent"
  | "pending_queue_non_empty"
  | "status_persist_skipped"

/** 受控 `canon_migration='dual'` 激活结果报告。 */
export interface CanonDualMigrationActivationReport {
  projectPath: string
  /** 是否已完成或确认处于 `'dual'` 模式。 */
  activated: boolean
  /** 激活门控结论原因码。 */
  reason: CanonDualMigrationActivationReason
  previousMode: CanonMigrationMode | undefined
  currentMode: CanonMigrationMode | undefined
  /** 回填报告（若因显式 `'legacy'` 拒绝而跳过回填，则为 `null`）。 */
  backfillReport: CanonBackfillReport | null
  /** 回填后检查的 `.novel/canon-pending.jsonl` 残留待写条目数。 */
  pendingQueueLength: number
}

/**
 * 受控激活 `canon_migration='dual'` 读路径（TASK-006）：
 *
 * 1. 读取当前 `.novel/status.json` 的 `canon_migration`；若显式为 `'legacy'` 且未传 `force: true`，
 *    直接拒绝覆盖并返回 `explicit_legacy_preserved`；
 * 2. 执行 `backfillCanonHistory` 离线回填历史章节快照（同时物化 `episode` 与 `world_fact` 边）；
 * 3. 核验零差异（`consistent && factsQueued === 0 && divergences.length === 0`）且待写队列为空；
 * 4. 仅在全部门控通过后，经 `setCanonMigrationMode(pp, 'dual', { onlyIfUnset: !force, createIfMissing: true })`
 *    原子写入 `.novel/status.json`（若已为 `'dual'` 则幂等不重复写盘）。
 */
export async function activateCanonDualMigration(
  projectPath: string,
  deps?: Partial<ActivateCanonDualMigrationDeps>,
  options?: CanonBackfillOptions & { now?: number; force?: boolean },
): Promise<CanonDualMigrationActivationReport> {
  const trimmed = projectPath.trim()
  if (!trimmed) {
    throw new Error("activateCanonDualMigration requires an open project path")
  }
  const pp = normalizePath(trimmed)
  const now = options?.now ?? Date.now()
  const force = options?.force === true

  const backfillDeps = deps?.backfill ?? defaultCanonBackfillDeps()
  const loadStatusFn = deps?.loadStatus ?? loadNovelSessionStatus
  const setModeFn = deps?.setMigrationMode ?? setCanonMigrationMode
  const loadPendingFn = deps?.loadPending ?? loadPendingQueue

  const existingStatus = await loadStatusFn(pp)
  const previousMode = existingStatus?.canon_migration

  if (previousMode === "legacy" && !force) {
    return {
      projectPath: pp,
      activated: false,
      reason: "explicit_legacy_preserved",
      previousMode,
      currentMode: previousMode,
      backfillReport: null,
      pendingQueueLength: 0,
    }
  }

  const backfillOptions: CanonBackfillOptions = {
    ...(options?.firstChapter !== undefined ? { firstChapter: options.firstChapter } : {}),
    ...(options?.exclusiveUpperBound !== undefined ? { exclusiveUpperBound: options.exclusiveUpperBound } : {}),
  }
  const backfillReport = await backfillCanonHistory(backfillDeps, pp, backfillOptions, now)

  const zeroDiff =
    backfillReport.consistent &&
    backfillReport.factsQueued === 0 &&
    backfillReport.divergences.length === 0

  if (!zeroDiff) {
    const pendingQueueLength = await loadPendingFn(backfillDeps.dualWrite, canonPendingQueuePath(pp))
      .then((records) => records.length, () => backfillReport.factsQueued)
    return {
      projectPath: pp,
      activated: false,
      reason: "backfill_inconsistent",
      previousMode,
      currentMode: previousMode,
      backfillReport,
      pendingQueueLength,
    }
  }

  const pendingRecords = await loadPendingFn(backfillDeps.dualWrite, canonPendingQueuePath(pp))
  const pendingQueueLength = pendingRecords.length

  if (pendingQueueLength > 0) {
    return {
      projectPath: pp,
      activated: false,
      reason: "pending_queue_non_empty",
      previousMode,
      currentMode: previousMode,
      backfillReport,
      pendingQueueLength,
    }
  }

  const updated = await setModeFn(pp, "dual", {
    onlyIfUnset: !force,
    createIfMissing: true,
    now: new Date(now).toISOString(),
  })

  if (updated) {
    return {
      projectPath: pp,
      activated: true,
      reason: "activated",
      previousMode,
      currentMode: updated.canon_migration,
      backfillReport,
      pendingQueueLength: 0,
    }
  }

  if (previousMode === "dual") {
    return {
      projectPath: pp,
      activated: true,
      reason: "already_dual",
      previousMode,
      currentMode: "dual",
      backfillReport,
      pendingQueueLength: 0,
    }
  }

  const latestMode = (await loadStatusFn(pp))?.canon_migration
  return {
    projectPath: pp,
    activated: latestMode === "dual",
    reason:
      latestMode === "dual"
        ? "already_dual"
        : latestMode === "legacy"
          ? "explicit_legacy_preserved"
          : "status_persist_skipped",
    previousMode,
    currentMode: latestMode,
    backfillReport,
    pendingQueueLength: 0,
  }
}
