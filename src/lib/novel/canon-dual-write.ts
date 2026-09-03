/**
 * canon-dual-write.ts — Canon 影子双写编排（T15 / F-14）。
 *
 * ## 职责（蓝图 §6 T15 / ADR-26）
 *   双写期（T11–T18）期间，`canon_store` 三表（新正典）与 snapshot-derived view
 *   （旧事实层，由 ingest 阶段已持久化的 snapshot 派生）**并行写、互为对账、非平行真相**
 *   （ADR-26「no dual truth source」精神延续：一个真源 + 一个影子对账）。本模块是双写
 *   的**编排核心**，负责：
 *
 *   1. **影子双写** `shadowWriteCanon`：对每个 canon 写操作，并行写旧 view 适配器 +
 *      新 canon_store（IPC `canon_ingest_episode` / `canon_supersede_edges`），
 *      随后 `reconcileCanon` 对账。
 *   2. **写失败→持久待写队列**（而非仅告警）：任一写失败即把该操作落入
 *      `.novel/canon-pending.jsonl`（运行期路径，ADR-16），以 **digest 幂等键** 去重、
 *     带 **指数退避封顶**。重启 / 下次 ingest 通过 `replayPendingQueue` **按序重放**
 *      补齐 —— 这是 T18 故障注入矩阵（≥6 类：SIGKILL/部分写/磁盘满/文件锁/OOM/时钟偏移）
 *      种子化可回归队列的前提。
 *   3. **T+5 退役检查** `retireAfterT5`：T18 垂直切片硬门通过 + 当前章达 T+5 章阈值后，
 *      `canon_store` 取代 snapshot-derived view 成为唯一正典源（ADR-26 §2）。退役前
 *      本模块维持双写对账态。
 *
 * ## Draft-first
 *   本模块为纯控制/机械编排（零 LLM），不涉及 AI 写作，Draft-first 不适用。
 *
 * ## 可测性与依赖注入
 *   所有副作用（旧 view 写、canon 写、队列 IO、时钟）均经 `CanonDualWriteDeps` 注入；
 *   默认实现 `defaultCanonDualWriteDeps()` 走真实 `@tauri-apps/api/core` invoke +
 *   `@/commands/fs` 原子写。单测用 mock deps 覆盖全部分支，运行时路径在 `.novel/`。
 *
 * 遵循 QMAI/CLAUDE.md：T15 新增锚点，落 `src/lib/novel/`；运行期队列在 `.novel/`。
 */

import { invoke } from "@tauri-apps/api/core"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  checkCanonPreWrite,
  DEFAULT_PRE_WRITE_GATE_MODE,
  type PreWriteGateInput,
} from "./canon-pre-write-gate"

// ──────────────────────────────────────────────────────────────────────────
// canon revision 持久化 TS 侧预热（DEBT-20260820-13）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 从 canon_store 持久化存储获取当前项目 canon revision。
 * 进程重启后调用，使 TS 侧缓存从持久化 revision 预热，避免缓存击穿。
 * 返回 `max_revision`（0 = 新库/无写入记录）。
 */
export async function getCanonRevision(projectPath: string): Promise<number> {
  try {
    const res = await invoke<{ max_revision: number }>("canon_get_revision", {
      projectId: projectPath,
    })
    return res.max_revision
  } catch {
    return 0
  }
}

/**
 * TS 侧缓存预热：从持久化 revision 初始化缓存。
 * 在应用启动/项目打开时调用，确保缓存 revision 与持久化状态一致。
 *
 * @param projectPath 项目路径
 * @param setCacheRevision 设置缓存 revision 的回调（由缓存层实现）
 */
export async function warmCanonCacheFromRevision(
  projectPath: string,
  setCacheRevision: (rev: number) => void,
): Promise<void> {
  const rev = await getCanonRevision(projectPath)
  if (rev > 0) {
    setCacheRevision(rev)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// divergence trace 持久化（DEBT-20260820-15b 偿还：差异留痕写入 canon_store）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 将 divergence trace JSON 持久化到 canon_store meta 表。
 * twoPhaseReconcile 告警后调用，确保差异留痕可供后续审计/诊断查询。
 * 与 revision 使用独立键（canon_divergence_trace），互不覆盖。
 */
export async function saveDivergenceTrace(
  projectPath: string,
  traceJson: string,
): Promise<void> {
  try {
    await invoke("canon_save_divergence_trace", {
      projectId: projectPath,
      traceJson,
    })
  } catch (err) {
    // divergence trace 是非致命审计操作，写入失败不阻断主流程
    console.warn("[canon] saveDivergenceTrace failed (non-fatal):", err instanceof Error ? err.message : String(err))
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 退避常量（指数退避 + 封顶）
// ──────────────────────────────────────────────────────────────────────────

/** 退避基值（首次失败后 nextRetryAt = now + BASE）。 */
export const BACKOFF_BASE_MS = 1000
/** 退避因子（指数 2）。 */
export const BACKOFF_FACTOR = 2
/** 退避封顶（5 分钟；超过后不再增长，防止无限膨胀）。 */
export const BACKOFF_MAX_MS = 5 * 60 * 1000

/**
 * 计算第 `attempts` 次失败后的退避间隔（毫秒）：`BASE * FACTOR^(attempts-1)`，封顶 `BACKOFF_MAX_MS`。
 * `attempts <= 1` 一律按 1 处理（首次失败取 BASE）。
 */
export function computeBackoffMs(attempts: number): number {
  const a = Math.max(1, attempts)
  const delay = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, a - 1)
  return Math.min(delay, BACKOFF_MAX_MS)
}

// ──────────────────────────────────────────────────────────────────────────
// 类型
// ──────────────────────────────────────────────────────────────────────────

/** 单次写结果（旧 view / 新 canon 均以此契约返回，绝不抛错外泄）。 */
export interface WriteOutcome {
  ok: boolean
  /** 失败原因（ok=false 时）。 */
  error?: string
  /** 写后 canon revision（canon 侧成功时由 IPC 返回）。 */
  revision?: number
  /**
   * 53 号报告 P1-2 additive: 写前门控命中标记 (BLOCK 且 block 模式时
   * ok=false 并填充; warn/duplicate 模式时 ok=true 仅记录, 供审计追溯)。
   */
  gate?: "pre_write_block" | "pre_write_warn" | "pre_write_duplicate"
}

/** 新 canon_store 写负载（与 T13 IPC 命令一一对应）。 */
export type CanonCanonPayload =
  | { kind: "episode"; episode: Record<string, unknown> }
  | { kind: "supersede"; request: Record<string, unknown> }
  | { kind: "supersede_by_digest"; request: { oldDigest: string; capChapter: number; newDigest: string; knownBy?: string[]; revealedAt?: number; causedBy?: string } }
// 注：generic `supersede` 分支的 `request` 为 Record<string, unknown>，调用方注入的
// `causedBy` 字段原样经 IPC 下发（§B causedBy 透传），无需在此收窄类型。

/** 单个双写操作：旧 view 负载 + 新 canon 负载 + 可选预置 digest / 派生内容。 */
export interface CanonDualWriteOp {
  /** 预置幂等键；省略则按 `content ?? canonPayload` 派生 SHA-256 digest。 */
  digest?: string
  /** 派生 digest 的稳定内容；省略则回退到 `canonPayload`。 */
  content?: unknown
  /** 旧 snapshot-derived view 适配器负载。 */
  legacyPayload: unknown
  /** 新 canon_store 负载。 */
  canonPayload: CanonCanonPayload
}

/** 持久待写队列记录（`.novel/canon-pending.jsonl` 单行 JSON）。 */
export interface CanonPendingRecord {
  /** 幂等键（SHA-256），同 digest = 同一逻辑写，去重依据。 */
  digest: string
  /** 入队时间（epoch ms）。 */
  createdAt: number
  /** 已尝试次数（含首次失败）。 */
  attempts: number
  /** 下次可重放时间（epoch ms，退避封顶）。 */
  nextRetryAt: number
  /** 最近失败原因。 */
  lastError?: string
  /** 旧 view 负载（重放原样写回）。 */
  legacyPayload: unknown
  /** 新 canon 负载（重放原样写回）。 */
  canonPayload: CanonCanonPayload
}

/** 双写依赖（全部副作用注入；默认实现见 `defaultCanonDualWriteDeps`）。 */
export interface CanonDualWriteDeps {
  /** 写旧 snapshot-derived view（T16 替换为真实投影写回；当前为对账占位）。 */
  writeLegacy: (projectPath: string, payload: unknown) => Promise<WriteOutcome>
  /** 写新 canon_store（默认 `canonStoreWriter`：IPC）。 */
  writeCanon: (projectPath: string, payload: CanonCanonPayload) => Promise<WriteOutcome>
  /** 读待写队列原始文本（不存在/失败返回空串）。 */
  queueRead: (queuePath: string) => Promise<string>
  /** 持久化待写队列（原子写）。 */
  queueWrite: (queuePath: string, contents: string) => Promise<void>
}

/** 单次双写结果（含 digest + 两侧 outcome + 一致性）。 */
export interface CanonWriteOutcome {
  digest: string
  legacy: WriteOutcome
  canon: WriteOutcome
  /** 两侧均 ok 才一致。 */
  consistent: boolean
}

/** `shadowWriteCanon` 汇总报告。 */
export interface ShadowWriteReport {
  /** 双写一致（两侧成功）的操作数。 */
  written: number
  /** 失败入队的操作数。 */
  queued: number
  /** 逐操作结果。 */
  results: CanonWriteOutcome[]
  /** 对账报告。 */
  reconcile: { consistent: boolean; divergences: { digest: string; reasons: string[] }[] }
}

/** `replayPendingQueue` 汇总报告。 */
export interface ReplayReport {
  /** 队列原长度。 */
  total: number
  /** 重放成功（出队）。 */
  succeeded: number
  /** 重放失败（重新退避入队）。 */
  rescheduled: number
  /** 未到退避时间（跳过保留）。 */
  skipped: number
  /** 重放后剩余队列长度。 */
  remaining: number
}

/** T+5 退役状态（ADR-26 §2/§3）。 */
export interface CanonRetireState {
  /** T18 垂直切片硬门通过时间戳；null = 未过，维持双写对账态。 */
  t18PassedAt: number | null
  /** 退役基准章（T18 通过时当前章）。 */
  baselineChapter: number
  /** 当前章。 */
  currentChapter: number
  /** T+章阈值，默认 5。 */
  tPlusChapters?: number
}

// ──────────────────────────────────────────────────────────────────────────
// 运行期队列路径（ADR-16：每项目 `.novel/`）
// ──────────────────────────────────────────────────────────────────────────

/** 待写队列运行期路径：`{projectPath}/.novel/canon-pending.jsonl`。 */
export function canonPendingQueuePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/canon-pending.jsonl`
}

/** 取路径父目录（供 `createDirectory` 确保 `.novel/` 存在）。导出用于可测性。 */
export function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return idx < 0 ? "." : p.slice(0, idx)
}

// ──────────────────────────────────────────────────────────────────────────
// 写适配器（默认）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 53 号报告 P1-2: 写前 gate 现存边快照拉取 (复用既有 canon_query IPC)。
 * 拉取失败 → 降级空数组 (gate 不阻断写可用性, 守 Draft-first)。
 */
async function queryAllEdges(projectPath: string): Promise<PreWriteGateInput["existingEdges"]> {
  try {
    const res = await invoke<{
      edges: Array<{
        id: string
        source_id: string
        target_id: string
        predicate: string
        digest?: string
        valid_at?: number | null
        invalid_at?: number | null
      }>
    }>("canon_query", { projectId: projectPath, filter: {} })
    return res.edges.map((e) => ({
      id: e.id,
      sourceId: e.source_id,
      targetId: e.target_id,
      predicate: e.predicate,
      digest: e.digest,
      validAt: e.valid_at ?? null,
      invalidAt: e.invalid_at ?? null,
    }))
  } catch {
    // 拉取失败 → 降级 PASS (写前 gate 不阻断写可用性)
    return []
  }
}

/**
 * 新 canon_store 写适配器（默认 `writeCanon`）：按 payload.kind 分发到 T13 IPC。
 * 内部捕获异常 → `WriteOutcome`（绝不上抛，保证双写编排不被单次写抛错中断）。
 */
export async function canonStoreWriter(
  projectPath: string,
  payload: CanonCanonPayload,
): Promise<WriteOutcome> {
  try {
    if (payload.kind === "episode") {
      const res = await invoke<{ inserted: boolean; max_revision: number }>("canon_ingest_episode", {
        projectId: projectPath,
        episode: payload.episode,
      })
      return { ok: true, revision: res.max_revision }
    }
    if (payload.kind === "supersede_by_digest") {
      // DEBT-20260621-30b：按 oldDigest 查边，再调 supersede 封顶旧边
      const { oldDigest, capChapter } = payload.request
      const queryRes = await invoke<{ edges: Array<{ id: string }> }>("canon_query", {
        projectId: projectPath,
        filter: { digest: [oldDigest] },
      })
      const oldEdgeIds = queryRes.edges.map((e) => e.id)
      if (oldEdgeIds.length === 0) {
        // 无边可封顶：幂等跳过（旧边已被前次 supersede 处理或不存在）
        return { ok: true }
      }
      const res = await invoke<{ result: unknown; max_revision: number }>("canon_supersede_edges", {
        projectId: projectPath,
        request: {
          old_edge_ids: oldEdgeIds,
          cap_chapter: capChapter,
          new_edges: [],
          // §B causedBy：按 digest 回填 supersede 的高审计粒度标记
          caused_by: "backfill-by-digest",
        },
      })
      return { ok: true, revision: res.max_revision }
    }
    if (payload.kind === "supersede") {
      // 53 号报告 P1-2: 写前一致性门控 (lore-weave L1 硬锁模式, 默认 warn-only
      // 零行为变更; block 模式拦截硬冲突)。gate 不 invoke, 不进 pending 队列。
      const request = payload.request as {
        new_edges?: Array<{
          id: string
          source_id: string
          target_id: string
          predicate: string
          digest?: string
          valid_at?: number | null
          invalid_at?: number | null
        }>
        old_edge_ids?: string[]
        cap_chapter?: number
      }
      const newEdges = request.new_edges ?? []
      if (newEdges.length > 0) {
        const existingEdges = await queryAllEdges(projectPath)
        const gateResult = checkCanonPreWrite(
          {
            newEdges: newEdges.map((e) => ({
              id: e.id,
              sourceId: e.source_id,
              targetId: e.target_id,
              predicate: e.predicate,
              digest: e.digest,
              validAt: e.valid_at ?? null,
              invalidAt: e.invalid_at ?? null,
            })),
            existingEdges,
          },
          { mode: DEFAULT_PRE_WRITE_GATE_MODE },
        )
        if (gateResult.state === "BLOCK") {
          return {
            ok: false,
            gate: "pre_write_block",
            error: `写前一致性门控拦截（L1 硬冲突）：${gateResult.conflicts
              .filter((c) => c.reason.startsWith("BLOCK"))
              .map((c) => c.reason)
              .join("; ")}`,
          }
        }
        if (gateResult.state === "WARN") {
          return { ok: true, gate: "pre_write_warn" }
        }
        if (gateResult.state === "DUPLICATE") {
          // 幂等去重: digest 重复且区间重叠 → 跳过写 (审计可追溯)
          return { ok: true, gate: "pre_write_duplicate" }
        }
      }
    }
    const res = await invoke<{ result: unknown; max_revision: number }>("canon_supersede_edges", {
      projectId: projectPath,
      request: payload.request,
    })
    return { ok: true, revision: res.max_revision }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 53 号报告 P0-2 additive: canon_supersede_edges 返回结构 (Rust SupersedeResult
 * 的 TS 投影)。新增字段 optional 向后兼容 (QC-5); duplicate_skipped 供调用方
 * 观察冲突分类去重, conflict_notes 为审计诊断备注。
 */
export interface SupersedeResultShape {
  capped: number
  inserted: number
  missing?: string[]
  duplicate_skipped?: number
  conflict_notes?: string[]
}

export type SupersedeInvokeResult = {
  result: SupersedeResultShape
  max_revision: number
}
/**
 * 旧 snapshot-derived view 写适配器（真实投影写回，DEBT-20260820-15 偿还）。
 * 将 T16 双写钩子产生的 `{ kind: "snapshot_fact", chapterNumber, fact }` 负载
 * 写入 `.novel/canon-legacy.jsonl` 文件（每行包含章节号、事实文本、时间戳），
 * 作为旧 view 的持久化投影。与 T16 `buildCanonDualWriteOps` 的输入契约对齐：
 * 接受 `{ kind: "snapshot_fact", chapterNumber, fact }` 格式的负载。
 *
 * 返回 `WriteOutcome` 保证与 `canonStoreWriter` 同契约、可被 `safeWrite` 统一包裹。
 * 写失败（如权限/磁盘满）返回 `{ ok: false, error }`，不中断双写编排。
 */
export async function snapshotLegacyWriter(
  projectPath: string,
  payload: unknown,
): Promise<WriteOutcome> {
  try {
    const p = payload as { kind: string; chapterNumber: number; fact: string }
    if (!p || p.kind !== "snapshot_fact") {
      return { ok: true }
    }
    const pp = normalizePath(projectPath)
    const legacyDir = `${pp}/.novel/canon-legacy`
    const legacyPath = `${legacyDir}/canon-legacy.jsonl`
    await createDirectory(legacyDir)
    const line = JSON.stringify({
      chapterNumber: p.chapterNumber,
      fact: p.fact,
      writtenAt: Date.now(),
    }) + "\n"
    // 追加写入：先读现有内容，追加新行，再原子写回
    let existing = ""
    try {
      existing = await readFile(legacyPath)
    } catch {
      // 文件不存在，新建
    }
    await writeFileAtomic(legacyPath, existing + line)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 默认双写依赖：真实 IPC + 真实 fs 原子写（运行期使用）。
 * `queueRead` 在文件不存在时返回空串（视为空队列）；`queueWrite` 先确保
 * `.novel/` 目录再原子写，保证崩溃中途中途写不损坏队列（与 projection-status-ledger 同契约）。
 */
export function defaultCanonDualWriteDeps(): CanonDualWriteDeps {
  return {
    writeLegacy: snapshotLegacyWriter,
    writeCanon: canonStoreWriter,
    queueRead: async (queuePath: string): Promise<string> => {
      try {
        return await readFile(queuePath)
      } catch {
        return ""
      }
    },
    queueWrite: async (queuePath: string, contents: string): Promise<void> => {
      await createDirectory(parentDir(queuePath))
      await writeFileAtomic(queuePath, contents)
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内部：安全写（吞掉适配器抛错 → WriteOutcome）
// ──────────────────────────────────────────────────────────────────────────

async function safeWrite<P>(
  fn: (projectPath: string, payload: P) => Promise<WriteOutcome>,
  projectPath: string,
  payload: P,
): Promise<WriteOutcome> {
  try {
    return await fn(projectPath, payload)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 单次双写尝试（并行写两侧 + 计算 digest）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 对一个操作并行写旧 view + 新 canon，返回带 digest 的结果。
 * digest 优先用 `op.digest`，否则按 `op.content ?? op.canonPayload` 派生 SHA-256（T07 幂等键）。
 * 任一适配器抛错都被 `safeWrite` 转换为 `ok:false` 的 `WriteOutcome`，不中断编排。
 */
export async function attemptDualWrite(
  deps: CanonDualWriteDeps,
  projectPath: string,
  op: CanonDualWriteOp,
): Promise<CanonWriteOutcome> {
  const digest = op.digest ?? (await computeCheckpointDigestOf(op.content ?? op.canonPayload))
  const [legacy, canon] = await Promise.all([
    safeWrite(deps.writeLegacy, projectPath, op.legacyPayload),
    safeWrite(deps.writeCanon, projectPath, op.canonPayload),
  ])
  return { digest, legacy, canon, consistent: legacy.ok && canon.ok }
}

// ──────────────────────────────────────────────────────────────────────────
// 对账（reconcile）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 单对 outcome 对账：成功/失败原因。
 */
export function reconcileCanon(
  legacy: WriteOutcome,
  canon: WriteOutcome,
): { consistent: boolean; divergences: string[] } {
  const divergences: string[] = []
  if (!legacy.ok) divergences.push(`legacy_write_failed:${legacy.error ?? "unknown"}`)
  if (!canon.ok) divergences.push(`canon_write_failed:${canon.error ?? "unknown"}`)
  return { consistent: divergences.length === 0, divergences }
}

/**
 * 批量结果对账：汇总所有不一致项的 digest + 原因。
 * T17 将在本结果基础上做两阶段重放补齐 + 差异告警（不静默吞差异）。
 */
export function reconcileOutcomes(results: CanonWriteOutcome[]): {
  consistent: boolean
  divergences: { digest: string; reasons: string[] }[]
} {
  const divergences = results
    .filter((r) => !r.consistent)
    .map((r) => {
      const reasons: string[] = []
      if (!r.legacy.ok) reasons.push(`legacy:${r.legacy.error ?? "unknown"}`)
      if (!r.canon.ok) reasons.push(`canon:${r.canon.error ?? "unknown"}`)
      return { digest: r.digest, reasons }
    })
  return { consistent: divergences.length === 0, divergences }
}

// ──────────────────────────────────────────────────────────────────────────
// 持久待写队列 IO（JSONL，digest 幂等）
// ──────────────────────────────────────────────────────────────────────────

/** 单行序列化。 */
function serializeRecord(rec: CanonPendingRecord): string {
  return JSON.stringify(rec)
}

/**
 * 读待写队列：解析 JSONL，跳过空行与畸形行（容错，绝不让坏行阻断重放）。
 * `queueRead` 抛错（如权限）视为空队列返回 `[]`。
 */
export async function loadPendingQueue(
  deps: CanonDualWriteDeps,
  queuePath: string,
): Promise<CanonPendingRecord[]> {
  let raw: string
  try {
    raw = await deps.queueRead(queuePath)
  } catch {
    return []
  }
  if (!raw) return []
  const out: CanonPendingRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as CanonPendingRecord
      if (parsed && typeof parsed.digest === "string") out.push(parsed)
    } catch {
      // 畸形行：跳过（容错）
    }
  }
  return out
}

/**
 * 写待写队列：JSONL，末尾换行（空队列写空串）。
 */
export async function savePendingQueue(
  deps: CanonDualWriteDeps,
  queuePath: string,
  records: CanonPendingRecord[],
): Promise<void> {
  const contents = records.map(serializeRecord).join("\n") + (records.length ? "\n" : "")
  await deps.queueWrite(queuePath, contents)
}

/**
 * 合并待写队列（digest 幂等）：把 `incoming` 并入 `existing`。
 * 同 digest 已存在 → 保留既有退避调度（attempts/nextRetryAt），仅刷新负载 + 错误；
 * 不存在 → 追加。返回按首次出现顺序去重后的记录集。
 */
export function mergePending(
  existing: CanonPendingRecord[],
  incoming: CanonPendingRecord[],
): CanonPendingRecord[] {
  const byDigest = new Map<string, CanonPendingRecord>()
  for (const r of existing) byDigest.set(r.digest, r)
  for (const r of incoming) {
    const prev = byDigest.get(r.digest)
    if (prev) {
      byDigest.set(r.digest, {
        ...prev,
        legacyPayload: r.legacyPayload,
        canonPayload: r.canonPayload,
        lastError: r.lastError,
      })
    } else {
      byDigest.set(r.digest, r)
    }
  }
  return [...byDigest.values()]
}

/** 由失败结果构造待写记录（首次失败：attempts=1，nextRetryAt=now+BASE）。 */
export function buildPendingRecord(
  outcome: CanonWriteOutcome,
  op: CanonDualWriteOp,
  now: number,
): CanonPendingRecord {
  const reasons: string[] = []
  if (!outcome.legacy.ok) reasons.push(`legacy:${outcome.legacy.error ?? "unknown"}`)
  if (!outcome.canon.ok) reasons.push(`canon:${outcome.canon.error ?? "unknown"}`)
  return {
    digest: outcome.digest,
    createdAt: now,
    attempts: 1,
    nextRetryAt: now + computeBackoffMs(1),
    lastError: reasons.join("; "),
    legacyPayload: op.legacyPayload,
    canonPayload: op.canonPayload,
  }
}

/** 重放失败后重新退避调度（attempts+1，nextRetryAt=now+退避封顶）。 */
export function reschedule(rec: CanonPendingRecord, now: number): CanonPendingRecord {
  const attempts = rec.attempts + 1
  return {
    ...rec,
    attempts,
    nextRetryAt: now + computeBackoffMs(attempts),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 编排入口
// ──────────────────────────────────────────────────────────────────────────

/**
 * 影子双写编排：逐操作并行双写 + 对账；任一失败落入持久待写队列（digest 去重 + 退避封顶）。
 *
 * - 全部成功 → 不入队，对账一致。
 * - 部分失败 → 失败项并入既有队列（按 `.novel/canon-pending.jsonl` 持久化）后返回。
 * - 返回每操作结果与对账报告，供 T16 调用点与 T17 reconcile 使用。
 *
 * @param deps 双写依赖（默认见 `defaultCanonDualWriteDeps`）。
 * @param projectPath 项目路径（亦作 canon DB 路径与队列父目录）。
 * @param ops 双写操作集。
 * @param now 当前时间（epoch ms），用于退避调度与入队时间戳。
 */
export async function shadowWriteCanon(
  deps: CanonDualWriteDeps,
  projectPath: string,
  ops: CanonDualWriteOp[],
  now: number,
): Promise<ShadowWriteReport> {
  const queuePath = canonPendingQueuePath(projectPath)
  const results: CanonWriteOutcome[] = []
  const incoming: CanonPendingRecord[] = []
  for (const op of ops) {
    const outcome = await attemptDualWrite(deps, projectPath, op)
    results.push(outcome)
    if (!outcome.consistent) {
      incoming.push(buildPendingRecord(outcome, op, now))
    }
  }
  if (incoming.length > 0) {
    const existing = await loadPendingQueue(deps, queuePath)
    const merged = mergePending(existing, incoming)
    await savePendingQueue(deps, queuePath, merged)
  }
  const reconcile = reconcileOutcomes(results)
  return {
    written: results.filter((r) => r.consistent).length,
    queued: incoming.length,
    results,
    reconcile,
  }
}

/**
 * 按序重放持久待写队列（重启 / 下次 ingest 调用）：
 * 1. 读队列（`.novel/canon-pending.jsonl`），按文件顺序遍历（保序重放）。
 * 2. `nextRetryAt > now` 的未到期项 → 保留跳过。
 * 3. 到期项 → 重新双写（两侧幂等：canon ingest 按 (chapter,digest) 去重）；
 *    成功出队，失败重新退避调度后保留。
 * 4. 重写队列（保序）。
 *
 * 返回重放统计（total/succeeded/rescheduled/skipped/remaining）。
 */
export async function replayPendingQueue(
  deps: CanonDualWriteDeps,
  projectPath: string,
  now: number,
): Promise<ReplayReport> {
  const queuePath = canonPendingQueuePath(projectPath)
  const queue = await loadPendingQueue(deps, queuePath)
  const remaining: CanonPendingRecord[] = []
  let succeeded = 0
  let rescheduled = 0
  let skipped = 0
  for (const rec of queue) {
    if (rec.nextRetryAt > now) {
      remaining.push(rec)
      skipped += 1
      continue
    }
    const op: CanonDualWriteOp = {
      digest: rec.digest,
      legacyPayload: rec.legacyPayload,
      canonPayload: rec.canonPayload,
    }
    const outcome = await attemptDualWrite(deps, projectPath, op)
    if (outcome.consistent) {
      succeeded += 1
    } else {
      remaining.push(reschedule(rec, now))
      rescheduled += 1
    }
  }
  await savePendingQueue(deps, queuePath, remaining)
  return {
    total: queue.length,
    succeeded,
    rescheduled,
    skipped,
    remaining: remaining.length,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T+5 退役检查（ADR-26 §2/§3）
// ──────────────────────────────────────────────────────────────────────────

/**
 * T+5 退役判定：T18 垂直切片硬门通过（t18PassedAt 非 null）且当前章达
 * `baselineChapter + (tPlusChapters ?? 5)` 后，`canon_store` 取代旧 view 成为唯一正典源。
 * 未过 T18 → 维持双写对账态（返回 false）。
 */
export function retireAfterT5(state: CanonRetireState): boolean {
  if (state.t18PassedAt == null) return false
  const tPlus = state.tPlusChapters ?? 5
  return state.currentChapter >= state.baselineChapter + tPlus
}
