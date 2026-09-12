import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { withProjectLock } from "./novel-locks"
import type { NameAliasMap } from "./book-analysis/types"
import type { ChapterSnapshot } from "./chapter-ingest"

/**
 * F-002 (S3 / ANL-010): ProjectionStatusLedger — records the per-projection
 * commit/rebuild status of each derived projection so a mid-ingest failure is
 * VISIBLE and recoverable instead of silent.
 *
 * Replaces the 8-segment independent try/catch in chapter-ingest.ts (each
 * segment swallowed failures with only a console.warn, so a corrupted
 * projection was undetectable until a downstream consumer broke). Under
 * commit-then-project (approach b — the ONLY viable path since LanceDB has
 * no transaction API, ANL-010 C4), the commit point (saveSnapshot +
 * saveChapterIngestOutput) is per-file-atomic; the post-commit projections
 * are derived and tracked here per the C-002 mixed_per_projection model.
 *
 * Three categories (C-002):
 *   - single_snapshot_idempotent: vector / snapshot / chapter_ingest_output
 *     — re-running with the same snapshot yields the same state; safe to retry.
 *   - fold_rebuildable: cognition / character / foreshadow /
 *     summary_structured_memory — deterministically re-derivable from the
 *     committed snapshot sequence via rebuildFromCommittedSnapshot.
 *   - mutates_existing_non_rebuildable: graph_entity_pages (mutates existing
 *     pages; rebuild = delete+re-fold via cleanupSupersededEntityFiles) /
 *     community_summary (LLM-derived, non-deterministic; re-extract on failure).
 */

export type ProjectionCategory =
  | "single_snapshot_idempotent"
  | "fold_rebuildable"
  | "mutates_existing_non_rebuildable"

// ============================================================================
// C-010（跨项目移植专项, 2026-09-12）: 双库四判据的属性维度扩展。
//
// 既有四判据（形态 / 消费者 / 生命周期 / 重建性）不足以给「外部不可重建数据」
// 与「外部不可信输入」一个合法落位（guidance §12.3 C-010；cross-role-review A-2
// 承认四判据不完备）。新增两个属性维度，与 ProjectionCategory（投影类别）**正交**：
//
//   - external_refetchable：外部时间事实（榜单 / 市场数据）。重抓 ≠ 重放——
//     同一来源在不同时间返回不同内容，故 **禁入 fold 重算与 self-heal**（重放
//     会写出与当下外部世界不一致的「事实」）。只可作建议层输入。
//   - untrusted_input：外部不可信且不可执行（技能包 / 远程返回 / 抓取样本）。
//     默认 trust_level=untrusted，只可作建议层输入；执行通道整体否决（C-007）。
//
// 二者**不是 projection category**——不入 PROJECTION_CATEGORIES / 注册表（那会
// 触发 assertProjectionRegistryComplete 的三方等值断言）。它们描述的是**外部数据
// 的落位属性**，由 resolveExternalDataClass 判定。
// ============================================================================

/** C-010：外部数据落位属性（与 ProjectionCategory 正交的第二根轴）。 */
export type ExternalDataClass = "external_refetchable" | "untrusted_input"

export interface ExternalDataClassAttributes {
  /** 语义定义（决策日志 / UI 提示的一致性来源）。 */
  readonly semantics: string
  /** 是否可经 committed snapshot 确定性重放。二者均 false：重抓 ≠ 重放 / 不可执行输入无 fold 语义。 */
  readonly foldRebuildable: boolean
  /** 是否可进 failed 自愈与 drift 自动修复的遍历集。二者均 false（C-010 硬约束）。 */
  readonly entersSelfHeal: boolean
  /** 是否必须携带 provenance 三元组（来源 / 抓取时间 / 内容哈希）才可入库。 */
  readonly provenanceRequired: boolean
  /** 允许的信任级别（C-007：外部输入一律 untrusted，不得默认提升）。 */
  readonly trustLevel: "untrusted"
  /** 落位域（C-006 分层归置 / C-007 用户资产域）。 */
  readonly domain:
    | "qm_raw_source"
    | "qm_book_analysis"
    | "novel_procedure"
    | "user_asset"
    | "unclassified"
}

/** C-010：两个新属性维度的权威属性表。 */
export const EXTERNAL_DATA_CLASS_ATTRIBUTES: Record<ExternalDataClass, ExternalDataClassAttributes> = {
  external_refetchable: {
    semantics:
      "外部时间事实：同一来源在不同时间返回不同内容，重抓 ≠ 重放；只可作建议层输入，禁入 fold 重算与 self-heal",
    foldRebuildable: false,
    entersSelfHeal: false,
    provenanceRequired: true,
    trustLevel: "untrusted",
    domain: "qm_raw_source",
  },
  untrusted_input: {
    semantics:
      "外部不可信且不可执行输入（技能包 / 远程返回 / 抓取样本）；只在建议层消费，无执行通道",
    foldRebuildable: false,
    entersSelfHeal: false,
    provenanceRequired: true,
    trustLevel: "untrusted",
    domain: "user_asset",
  },
}

/** C-010：属性维度的枚举（顺序即判定优先级：外部性优先于可重建性）。 */
export const EXTERNAL_DATA_CLASSES: readonly ExternalDataClass[] = [
  "external_refetchable",
  "untrusted_input",
]

/** 类型守卫：字符串是否为一个已知的外部数据类。 */
export function isExternalDataClass(value: unknown): value is ExternalDataClass {
  return typeof value === "string" && (EXTERNAL_DATA_CLASSES as readonly string[]).includes(value)
}

/**
 * C-010 判定器：把外部数据的三项事实映射到 external data class。
 * 返回 null = 非外部来源（走既有双库四判据，不适用本轴）。
 * 判定顺序固定（可执行 > 时间事实）——保证同一份数据在任何调用点得到同一类别。
 */
export function resolveExternalDataClass(input: {
  /** 是否为项目外部来源（写入者不是本项目：厂商 API / 远端 / 第三方包）。 */
  readonly externalOrigin: boolean
  /** 是否为外部时间事实（同一来源重复抓取会得到不同内容）。 */
  readonly timeVarying: boolean
  /** 是否携带可执行内容（脚本 / 依赖安装 / 命令）。 */
  readonly executable: boolean
}): ExternalDataClass | null {
  if (!input.externalOrigin) return null
  if (input.executable) return "untrusted_input"
  if (input.timeVarying) return "external_refetchable"
  return "untrusted_input"
}

/** C-010：该类是否被排除出 fold 重算与 self-heal 遍历集（当前两类均被排除）。 */
export function isFoldReplayExcluded(classId: ExternalDataClass): boolean {
  const attrs = EXTERNAL_DATA_CLASS_ATTRIBUTES[classId]
  return attrs.foldRebuildable === false || attrs.entersSelfHeal === false
}

export type ProjectionStatus = "pending" | "committed" | "failed"

export interface ProjectionStatusEntry {
  /** The projection name (vector / cognition / character / foreshadow / graph / ...). */
  projection: string
  /** C-002 category — drives the recovery strategy on failure. */
  category: ProjectionCategory
  /** Last-known status for this projection + chapter. */
  status: ProjectionStatus
  /** ISO timestamp of the last status update. */
  updated_at: string
  /** Error message when status === "failed"; empty otherwise. */
  last_error: string
}

// ============================================================================
// F-005 (v2.6 Tier2): append-only audit trail.
//
// ProjectionStatusEntry above is a LAST-KNOWN-STATUS cell — re-running a
// projection overwrites it, so the history of intermediate failures during a
// single ingest (e.g. graph failed then succeeded on retry) is lost. The
// auditTrail below is an APPEND-ONLY event log recorded alongside it: one
// entry per projection commit/rebuild event, persisted per-event so a hard
// crash mid-ingest still leaves the already-emitted events on disk (mid-ingest
// forensics; the last-known-status cells are only saved in the loop's finally).
//
// ADR-16 boundary: auditTrail lives INSIDE the existing projection-status.json
// as an additive field — NOT a second session-state file. The RMW writer
// preserves every unknown top-level field, and readers of the ledger shape
// ({projections, chapters}) ignore the extra key.
// Growth note (OQ-3): the trail grows unbounded (~12 events/chapter); a
// rolling-window policy is deferred past v2.6 baseline.
// C5 (2026-08-23): rolling window landed — AUDIT_TRAIL_MAX_ENTRIES caps the
// trail at both append sites (recordProjectionAudit / appendProjectionAuditEntry)
// and on load (legacy files are trimmed once). Tail-kept (most recent N).
// ============================================================================

/** C5: rolling-window cap for the append-only audit trail (tail-kept). */
export const AUDIT_TRAIL_MAX_ENTRIES = 500

/** Shared C5 trim: keep the most recent `cap` entries (in order). */
export function trimAuditTrail(
  trail: ProjectionAuditEntry[] | undefined,
  cap: number = AUDIT_TRAIL_MAX_ENTRIES,
): ProjectionAuditEntry[] {
  const arr = trail ?? []
  return arr.length > cap ? arr.slice(arr.length - cap) : arr
}

/** Outcome of one audited projection event. "rebuild" = scheduled rebuild succeeded (community_summary); failures are always "failed" + error. */
export type ProjectionAuditStatus = "committed" | "rebuild" | "failed"

export interface ProjectionAuditEntry {
  /** The projection name (same keys as PROJECTION_CATEGORIES). */
  projection: string
  /** Chapter number the event belongs to (>0 — frontmatter-validated upstream). */
  chapter: number
  /** Event outcome: committed / rebuild / failed. */
  status: ProjectionAuditStatus
  /** Wall-clock duration of the projection body in ms. */
  durationMs: number
  /** Error message when status === "failed"; omitted otherwise. */
  error?: string
  /** ISO timestamp of when the event finished. */
  timestamp: string
}

export interface ProjectionStatusLedger {
  /**
   * 账本 schema 版本（#4 清偿，2026-09-07）：v1 文件无此字段，load 时按
   * 兼容迁移补写 "2"，下次 save 自然升版；v2 = projections 键集与
   * PROJECTION_REGISTRY 对齐 + auditTrail 滚动窗。
   */
  schemaVersion: string
  /** Static category mapping per C-002 mixed_per_projection. */
  projections: Record<string, ProjectionCategory>
  /** Per-chapter projection status: chapters[chapterNumber][projection] = entry. */
  chapters: Record<string, Record<string, ProjectionStatusEntry>>
  /** F-005: append-only audit history; additive optional field (older files lack it). */
  auditTrail?: ProjectionAuditEntry[]
}

/**
 * The canonical C-002 category mapping. Single source of truth —
 * chapter-ingest.ts and rebuildFromCommittedSnapshot both consult this to
 * decide the recovery strategy for a failed projection.
 */
export const PROJECTION_CATEGORIES: Record<string, ProjectionCategory> = {
  vector: "single_snapshot_idempotent",
  snapshot: "single_snapshot_idempotent",
  chapter_ingest_output: "single_snapshot_idempotent",
  cognition: "fold_rebuildable",
  character: "fold_rebuildable",
  foreshadow: "fold_rebuildable",
  summary_structured_memory: "fold_rebuildable",
  // R4 (S4 / ANL-013): 3 new structured-field projections — same-layer
  // siblings of character/foreshadow (NOT a Truth Files module; ANL-013 C4).
  // emotional_arc / resource_ledger / subplot_board 均 fold_rebuildable:
  // re-derivable from the committed snapshot sequence (applySubplotChangesToStore
  // 已从 snapshot 解析 targetResolutionChapter/abandoned)。
  emotional_arc: "fold_rebuildable",
  subplot_board: "fold_rebuildable",
  resource_ledger: "fold_rebuildable",
  // P2-IMP-02：补登过程库三投影为 fold_rebuildable（rebuildFromCommittedSnapshot
  // 与 computeTruthFoldDrift 重放均已覆盖：foldMeetingEdges / foldChapterSummary /
  // foldParticleEntries 从 committed snapshot 确定性重建）。
  encounter_matrix: "fold_rebuildable",
  chapter_summaries: "fold_rebuildable",
  particle_ledger: "fold_rebuildable",
  graph_entity_pages: "mutates_existing_non_rebuildable",
  // CORR-009: distinct key for the wiki-patch-field write path (was shared
  // with graph_entity_pages, masking partial failures). Same category.
  graph_entity_patch_fields: "mutates_existing_non_rebuildable",
  // CORR-007: syncSnapshotToMemory (structured-memory sync) — runs the
  // snapshot→memory write. Treated as fold_rebuildable (re-derivable from
  // committed snapshots via rebuildFromCommittedSnapshot).
  sync_snapshot_to_memory: "fold_rebuildable",
  community_summary: "mutates_existing_non_rebuildable",
}

// ============================================================================
// P2-IMP-14: PROJECTION_REGISTRY — 投影注册表（四路径同源遍历的单一事实源）。
//
// F5 类缺陷（某投影在 ingest/rebuild/drift 重放/sync 四条路径中的某条被漏接或
// fold 实现分叉）的根因是四路径各自硬编码投影清单。注册表把「投影 id → 类别 →
// store 读写 → 增量 fold」收敛为一个数据源：
//   - ingest 增量路径：遍历带 applyToStore 的条目（runProjection 记账）；
//   - rebuild 全量重放路径：遍历 rebuildable 条目（foldFromSnapshot = 由
//     createEmpty + applyToStore 派生，与 ingest 同一 fold 函数）；
//   - drift 重放路径（computeTruthFoldDrift）：遍历带 file 的条目，live=load、
//     replay=foldFromSnapshot——比对双方与写盘双方天然同源；
//   - syncSnapshotToMemory 路径：遍历 SYNC_FOLD_PROJECTION_IDS 子集（P2-IMP-08
//     边界保留），未覆盖类的文件集合同样由注册表派生。
// 新增 fold_rebuildable 投影只需入表一处，四路径自动覆盖——结构上绝迹。
//
// 条目实现在 chapter-ingest.ts 模块加载时经 registerProjections 填充（fold
// helper 与 store 模块都聚合在那里，注册表容器放本文件避免 ledger ↔
// chapter-ingest 运行时循环导入）。注册即校验（cognee fail-loud）：未知 id /
// 类别与 PROJECTION_CATEGORIES 不一致 / 重复注册 / rebuildable 但类别非
// fold_rebuildable —— 一律抛错，绝不静默降级。CI 三方等值（注册表键集 ==
// PROJECTION_CATEGORIES 键集 == runProjection 实际调用 id 集）见
// projection-registry.spec.ts。
// ============================================================================

/** fold 显式上下文（E-03 C-3 fold 纯性 + PERF-NEW-05 别名表复用）。 */
export interface ProjectionFoldContext {
  /** 显式时间戳（ISO 串）。缺省 → fold 不写时间戳（保留输入值，纯性优先）。 */
  now?: string
  /** 预计算别名表；缺省 → 各 fold 内部按 snapshot 自建（rebuild/drift 重放形态）。 */
  aliasMaps?: readonly NameAliasMap[]
}

/**
 * 单投影注册条目。9 个 store-backed fold_rebuildable 投影带全套
 * {category, foldFromSnapshot, applyToStore, load, save}；graph/vector 等
 * 非确定性/非 store 投影以 rebuildable:false 入表（键集三方等值的成员）。
 */
export interface ProjectionRegistryEntry {
  /** C-002 类别 —— 必须与 PROJECTION_CATEGORIES 同键值（注册时 fail-loud 校验）。 */
  readonly category: ProjectionCategory
  /**
   * 是否可经注册表从 committed snapshot 序列确定性重建。
   * 只有 true 的投影参与 failed 自愈（IMP-14）与 drift 自动修复（IMP-15）；
   * graph/vector/community 等非确定性或非同源可重放投影标 false。
   */
  readonly rebuildable: boolean
  /** 单一真相文件名（.novel/ 下，drift 比对标识）；null = 无单文件真相 store。 */
  readonly file: string | null
  /** 读盘上 live store（原样返回，含 null 语义 —— cognition 缺文件 ≠ 空 store）。 */
  readonly load?: (projectPath: string) => Promise<unknown>
  /** 空 store（重放起点）。 */
  readonly createEmpty?: (ctx: ProjectionFoldContext) => unknown
  /** 增量 fold：把一个 snapshot 应用到 store（ingest / sync 路径）。 */
  readonly applyToStore?: (store: unknown, snapshot: ChapterSnapshot, ctx: ProjectionFoldContext) => unknown
  /** 全量重放：从空 store 沿 committed snapshot 序列 fold（rebuild / drift 重放路径）。 */
  readonly foldFromSnapshot?: (snapshots: ChapterSnapshot[], ctx: ProjectionFoldContext) => unknown
  /** 写盘。 */
  readonly save?: (projectPath: string, store: unknown) => Promise<void>
  /** 非 store 型投影的确定性重建钩子（如 summary_structured_memory → 结构化记忆文档）。 */
  readonly rebuildFromSnapshots?: (
    projectPath: string,
    snapshots: ChapterSnapshot[],
    ctx: ProjectionFoldContext,
  ) => Promise<void>
  /** ingest/sync 增量路径触发条件（保留既有条件接线语义）；缺省 = 无条件。 */
  readonly shouldApply?: (snapshot: ChapterSnapshot) => boolean
  /**
   * sync 直写标记（P2-IMP-08 边界，P2-IMP-14 派生源）：true 的投影参与
   * syncSnapshotToMemory 直写路径；false/缺省 = 不经 sync 直写（由 drift 采样 + 自愈兑底）。
   */
  readonly syncDirectWrite?: boolean
}

/** 注册表容器（模块加载时由 chapter-ingest.ts 填充；填充前为空）。 */
export const PROJECTION_REGISTRY: Record<string, ProjectionRegistryEntry> = {}

/**
 * 批量注册投影条目（幂等保护：重复注册抛错）。注册即校验，任何不一致
 * 立即抛（cognee fail-loud），绝不静默接受分叉的类别/键集。
 */
export function registerProjections(entries: Record<string, ProjectionRegistryEntry>): void {
  for (const [id, entry] of Object.entries(entries)) {
    const canonical = PROJECTION_CATEGORIES[id]
    if (canonical === undefined) {
      throw new Error(
        `[projection-registry] unknown projection "${id}" — not in PROJECTION_CATEGORIES (fail-loud)`,
      )
    }
    if (entry.category !== canonical) {
      throw new Error(
        `[projection-registry] category mismatch for "${id}": registry=${entry.category} vs PROJECTION_CATEGORIES=${canonical} (fail-loud)`,
      )
    }
    if (entry.rebuildable && canonical !== "fold_rebuildable") {
      throw new Error(
        `[projection-registry] "${id}" marked rebuildable but category is ${canonical} — only fold_rebuildable projections may auto-rebuild (fail-loud)`,
      )
    }
    if (PROJECTION_REGISTRY[id] !== undefined) {
      throw new Error(`[projection-registry] duplicate registration for "${id}" (fail-loud)`)
    }
    PROJECTION_REGISTRY[id] = entry
  }
}

/**
 * sync 直写子集（P2-IMP-14）：由注册表 syncDirectWrite 标志派生，消除硬编码清单。
 * 新增投影若应走 sync 直写，只需注册时标 syncDirectWrite:true——四路径与
 * 键集等值断言自动覆盖，不再需要同步手工维护第二份清单。
 */
export function syncDirectWriteProjectionIds(): readonly string[] {
  return Object.entries(PROJECTION_REGISTRY)
    .filter(([, entry]) => entry.syncDirectWrite === true)
    .map(([id]) => id)
}

/** 带全套 store fold 能力的注册表条目（ingest/rebuild/drift/sync 四路径遍历的同一键集）。 */
export function foldStoreRegistryEntries(): Array<[string, ProjectionRegistryEntry]> {
  return Object.entries(PROJECTION_REGISTRY).filter(
    ([, e]) =>
      e.load !== undefined &&
      e.save !== undefined &&
      e.createEmpty !== undefined &&
      e.applyToStore !== undefined &&
      e.foldFromSnapshot !== undefined &&
      e.file !== null,
  )
}

/** 可确定性重建的注册表条目（failed 自愈 / drift 自动修复的遍历集）。 */
export function rebuildableRegistryEntries(): Array<[string, ProjectionRegistryEntry]> {
  return Object.entries(PROJECTION_REGISTRY).filter(([, e]) => e.rebuildable)
}

/** 该投影是否可经注册表自动重建（failed 自愈 / drift 修复的统一门槛查询）。 */
export function isAutoRebuildableProjection(projection: string): boolean {
  return PROJECTION_REGISTRY[projection]?.rebuildable === true
}

/**
 * CI 三方等值校验之一：注册表键集 == PROJECTION_CATEGORIES 键集。
 * 不一致直接抛（fail-loud）；projection-registry.spec.ts 另校验
 * runProjection 实际调用 id 集 ⊆ 注册表键集 与 fold 条目键集 ⊆ runProjection id 集。
 */
export function assertProjectionRegistryComplete(): void {
  const registryKeys = new Set(Object.keys(PROJECTION_REGISTRY))
  const categoryKeys = Object.keys(PROJECTION_CATEGORIES)
  const missing = categoryKeys.filter((k) => !registryKeys.has(k))
  const extra = [...registryKeys].filter((k) => PROJECTION_CATEGORIES[k] === undefined)
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[projection-registry] key-set mismatch — missing from registry: [${missing.join(", ")}]; unknown in registry: [${extra.join(", ")}] (fail-loud)`,
    )
  }
}

export function emptyLedger(): ProjectionStatusLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    projections: { ...PROJECTION_CATEGORIES },
    chapters: {},
    // F-005: initial state — an empty (present, not undefined) trail so
    // consumers can rely on array semantics after any load/empty path.
    auditTrail: [],
  }
}

/** 账本 schema 版本（#4 清偿：v1 文件 load 时 lazy 迁移至 v2）。 */
export const LEDGER_SCHEMA_VERSION = "2"

function ledgerPath(projectPath: string): string {
  const pp = normalizePath(projectPath)
  return `${pp}/.novel/projection-status.json`
}

export async function loadProjectionStatusLedger(projectPath: string): Promise<ProjectionStatusLedger> {
  // A5: keep the raw bytes across the read/parse boundary so that on a JSON
  // parse failure we can preserve the original file to a .corrupt-* sibling
  // instead of silently zeroing history on the next save.
  let raw: string | undefined
  let parsed: Partial<ProjectionStatusLedger> | undefined
  try {
    raw = await readFile(ledgerPath(projectPath))
    const candidate = JSON.parse(raw) as Partial<ProjectionStatusLedger>
    if (!candidate || typeof candidate !== "object" || !candidate.chapters) {
      return emptyLedger()
    }
    parsed = candidate
  } catch {
    // A5: a thrown read (ENOENT) or a JSON.parse failure (corrupt file) must
    // NOT silently reset the ledger. When we actually held file contents that
    // failed to parse, copy them to a .corrupt-<timestamp> sibling in the same
    // directory and warn — then still return emptyLedger() to stay available.
    if (raw !== undefined) {
      try {
        await preserveCorruptLedger(projectPath, raw)
      } catch (preserveErr) {
        // Preserving the original is best-effort; never let it break the load.
        console.error(
          "[projection-status-ledger] failed to preserve corrupt ledger file:",
          preserveErr,
        )
      }
    }
    return emptyLedger()
  }
  // 未知新版 schemaVersion 不在 corrupt 语义内：fail-loud（拒绝静默降级），
  // 抛给调用方决策——绝不能像解析失败那样吞掉降级。
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `[projection-status-ledger] unsupported ledger schemaVersion "${parsed.schemaVersion}" (expected "${LEDGER_SCHEMA_VERSION}") — fail-loud, refusing silent downgrade`,
    )
  }
  // Merge with canonical categories so new projections added in code are
  // reflected even in ledgers written by older versions.
  const chapters = parsed.chapters as Record<string, Record<string, ProjectionStatusEntry>>
  return {
      // #4: v1 legacy files lack schemaVersion — lazy migrate to "2" on load
      // (next save writes it back); v2 files keep their version.
      schemaVersion: LEDGER_SCHEMA_VERSION,
      projections: { ...PROJECTION_CATEGORIES, ...(parsed.projections ?? {}) },
      chapters,
      // F-005: preserve the append-only trail across loads (legacy files → []).
      // C5: legacy files may exceed the cap — trim once on load.
      auditTrail: Array.isArray(parsed.auditTrail) ? trimAuditTrail(parsed.auditTrail) : [],
    }
}

/**
 * A5: copy the raw (corrupt) ledger contents to a `.corrupt-<ISO timestamp>`
 * sibling in the same directory so the history is not silently lost when the
 * next saveProjectionStatusLedger overwrites projection-status.json. Uses the
 * project's existing IO primitives (readFile + writeFileAtomic); no rename
 * primitive is exposed, so this is an explicit read+write copy.
 */
async function preserveCorruptLedger(projectPath: string, raw: string): Promise<void> {
  const pp = normalizePath(projectPath)
  // ISO timestamps contain ':' / '.' which are legal on most filesystems but
  // awkward; normalize them so the suffix stays filename-friendly.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const corruptPath = `${pp}/.novel/projection-status.corrupt-${stamp}.json`
  await writeFileAtomic(corruptPath, raw)
  console.error(
    `[projection-status-ledger] corrupted ledger detected at ${ledgerPath(projectPath)}; ` +
      `original contents preserved to ${corruptPath}`,
  )
}

export async function saveProjectionStatusLedger(
  projectPath: string,
  ledger: ProjectionStatusLedger,
): Promise<void> {
  // Phase4 锁族：与 appendProjectionAuditEntry 共用同一把项目级锁，保证
  // end-of-loop save 与 per-event flush 不会交错丢写。
  await withProjectLock(`ledger:${normalizePath(projectPath)}`, async () => {
    const pp = normalizePath(projectPath)
    await createDirectory(`${pp}/.novel`)
    // F-002: atomic write (fs.rs:1190 temp+fsync+rename) — the ledger itself
    // must not be corrupted by a crash mid-write, or it would defeat its
    // purpose of making projection failures visible.
    await writeFileAtomic(ledgerPath(projectPath), JSON.stringify(ledger, null, 2))
  })
}

/**
 * F-005: append one audit event to the in-memory ledger's trail (pure).
 * Pairs with appendProjectionAuditEntry — the in-memory copy must stay in sync
 * so the end-of-loop saveProjectionStatusLedger cannot clobber the per-event
 * durable flushes back off disk.
 */
export function recordProjectionAudit(
  ledger: ProjectionStatusLedger,
  entry: ProjectionAuditEntry,
): ProjectionStatusLedger {
  return { ...ledger, auditTrail: trimAuditTrail([...(ledger.auditTrail ?? []), entry]) }
}

/**
 * F-005: durably append one audit event to projection-status.json.
 *
 * Read-modify-write that spreads ALL existing top-level fields through
 * (projections / chapters / version / anything else) and only replaces the
 * auditTrail array — strictly additive, never drops legacy or unknown fields.
 * Tolerant of missing/corrupt files (starts a fresh document). Callers treat
 * failure as non-fatal: audit must never break the projection loop.
 */
export async function appendProjectionAuditEntry(
  projectPath: string,
  entry: ProjectionAuditEntry,
): Promise<void> {
  // Phase4 锁族（A8 补遗）：RMW 临界区加项目级互斥——community rebuild
  // （fire-and-forget）与下章摄取并发 append 时无锁会丢写。
  await withProjectLock(`ledger:${normalizePath(projectPath)}`, async () => {
    const pp = normalizePath(projectPath)
    await createDirectory(`${pp}/.novel`)
    let doc: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(ledgerPath(pp)))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>
      }
    } catch {
      // Missing or corrupt file → start a fresh document; the spread below
      // keeps whatever fields were recoverable (none) without failing the caller.
    }
    const existing = Array.isArray(doc.auditTrail) ? (doc.auditTrail as ProjectionAuditEntry[]) : []
    await writeFileAtomic(
      ledgerPath(pp),
      JSON.stringify({ ...doc, auditTrail: trimAuditTrail([...existing, entry]) }, null, 2),
    )
  })
}

/**
 * Record a projection's status for a chapter. Additive — only updates the
 * single (chapter, projection) cell; other entries are preserved.
 */
export function recordProjectionStatus(
  ledger: ProjectionStatusLedger,
  chapterNumber: number,
  projection: string,
  status: ProjectionStatus,
  lastError = "",
): ProjectionStatusLedger {
  const key = String(chapterNumber)
  const category = PROJECTION_CATEGORIES[projection] ?? "fold_rebuildable"
  const entry: ProjectionStatusEntry = {
    projection,
    category,
    status,
    updated_at: new Date().toISOString(),
    last_error: lastError,
  }
  const chapters = { ...ledger.chapters }
  const chapterEntry = { ...(chapters[key] ?? {}) }
  chapterEntry[projection] = entry
  chapters[key] = chapterEntry
  return { ...ledger, chapters }
}
