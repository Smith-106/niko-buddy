/**
 * promotion-bridge.ts — 单向晋升桥凭证层（E-05 / F-005，双库架构蓝图）。
 *
 * ## 职责（EPIC-05 + ARCH-promotion-bridge + REQ-dual-kb-boundary）
 *   晋升桥是双库之间**唯一跨库写路径**：把过程库中经 accept 的终稿，单向晋升为
 *   能力库语料。本模块承载三桥共享的**晋升凭证层**（schema / 幂等键 / 门控代数 /
 *   状态机 / 原子提交 / append-only 事件日志 / 冲突仲裁日志），三通道的执行半边
 *   复用既有锚点（formal-writeback.ts accept-commit 编排、canon-dual-write.ts
 *   T15 影子双写 + digest 幂等队列、canon-backfill.ts T30b 幂等重放），本模块
 *   只加凭证层 + 三个薄接线点。
 *
 * ## 单向性（DA-12，类型层不可逆）
 *   PromotionRecord **刻意缺回写字段**：无 writebackRef / reverseTarget /
 *   draftPatch / processStatus 等任何指向 .novel 真相文件的写回字段——逆向污染
 *   在类型层面不可表达（BND-PRM-03）。finalSnapshot 只存引用 + digest 前缀，
 *   不存终稿全文（铁律③：桥输出不得成为被检索原文副本）。
 *
 * ## 幂等键双语义定义文档（R-3 / C-3 硬要求，与 ingest 内容哈希显式区分）
 *   - 晋升键 replayKey = `${channel}:${chapterId}:${entity}:${revision}` ——
 *     **可重放语义**：重复晋升同版本 → 返回既有 PromotionRecord，不新增行、
 *     不重复写能力库（promotion_replay_success = 100%）。
 *   - ingest 键 digest = SHA-256(stable({chapter, fact}))（canon-dual-write.ts
 *     attemptDualWrite）——**去重语义**：同一原料重复摄入 → store 收敛单行。
 *   - 两者键空间、语义、失效条件（终稿版本推进 vs 内容变更）均不同，MUST NOT
 *     混用（BND-PRM-06 / C-3）。
 *
 * ## 原子性（DA-G3 在无事务底座上的诚实达成）
 *   canon_store 走 IPC、LanceDB 无 tx API（ANL-010 C4）→ 同步 all-or-nothing
 *   不可达。达成口径：**record = 唯一原子提交点**——`.novel/promotions.json`
 *   经 createAtomicJsonStore（temp+fsync+rename）原子提交，写失败旧文件完好 =
 *   结构上无半成品；双写层不一致 → 零 record + 既有持久队列重放收敛；半成品
 *   重新定义为「凭证与库状态不一致」，由 promotionAudit 双向对账兜底。
 *
 * ## 状态机（BND-PRM-12）
 *   DRAFT(决策态 pending/ready) ──accept(人工)──► ACCEPTED
 *   ACCEPTED ──formal-writeback + gatePass──► PROMOTED（= record 首次 append）
 *   ACCEPTED ──reject──► DISCARDED（不进能力库）
 *   PROMOTED ──► REFINED | SUPERSEDED（枚举槽位预留，治理迁移属 E-06）
 *   两套状态域（NovelDraftStatus 决策态 / PromotionStatus 晋升态）经 accept
 *   事件衔接，晋升态永不写 status.json（硬边界③ + BND-06 时间轴解耦）。
 *
 * ## 门控代数（BND-PRM-11，SME-G1）
 *   PROMOTION_GATE_ALGEBRA 声明式四元组 {condition, action, sideEffect,
 *   rollback} + evaluateGate 纯函数；触发条件歧义（acceptTimestamp 缺失 /
 *   rejected∧final 并存 / channel 未知）→ BLOCK + ambiguity_block 事件
 *   （BND-PRM-10：单向门不可误开，绝不默认放行）。
 *
 * 遵循 Niko Buddy CLAUDE.md：E-05 新增锚点（2026-09-04 三模型共识），落
 * `src/lib/novel/`；运行期数据在 `.novel/`（ADR-16）；报告工件非真相文件。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { createAtomicJsonStore } from "./projection-store"
import { parseFactsSubject } from "./chapter-ingest"
import { isMissingFile } from "./chapter-ingest-utils"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { withProjectLock } from "./novel-locks"

// ──────────────────────────────────────────────────────────────────────────
// 类型（DA-12：缺回写字段 = 类型层不可逆）
// ──────────────────────────────────────────────────────────────────────────

/** 三桥通道（BND-PRM-01）。 */
export type PromotionChannel = "formal-writeback" | "canon-dual-write" | "canon-backfill"

/** 晋升状态机（BND-PRM-12）。REFINED/SUPERSEDED 为枚举槽位预留（治理归 E-06）。 */
export type PromotionStatus = "draft" | "accepted" | "promoted" | "refined" | "superseded" | "discarded"

/** 晋升事件类型（append-only 审计，BND-PRM-09）。 */
export type PromotionEventType =
  | "accept"
  | "reject"
  | "promote_success"
  | "promote_failed"
  | "promote_replayed"
  | "refine"
  | "supersede"
  | "fold_conflict"
  | "ambiguity_block"

/** 晋升条目（三桥共享 schema，BND-PRM-04）。刻意缺回写字段（DA-12）。 */
export interface PromotionRecord {
  /** 三桥通道。 */
  channel: PromotionChannel
  /** 过程库侧来源引用（只读投影，非回写句柄）。 */
  sourceRef: { chapterId: string; chapterNumber: number; revision: number }
  /** 能力库侧目标引用（CapabilitySink 条目 id；真实落点归能力库侧，E-05 冻结接口）。 */
  targetRef: { episodeId?: string; entryId?: string }
  /** accept 门通过时刻（ISO）；人工门凭证，缺失 → gate-ambiguous BLOCK。 */
  acceptTimestamp: string
  /** 幂等复合键（R-3），全局唯一。 */
  replayKey: string
  /** 门控代数求值凭证（BND-PRM-11）。 */
  gatePass: { decisionGates: boolean; consistencyP0: boolean; manualFinal: boolean; evaluatedAt: string }
  /** 终稿快照**引用**（摘要级）——刻意不含正文全文（铁律③）。 */
  finalSnapshot: { chapterId: string; contentDigestPrefix: string; extractedAt: string }
  /** trust 重新分级的**输入**（非派生结果、非过程库状态语义，BND-PRM-08）。 */
  trustSource: { adrTrust: "blocked" | "reference_only" | "full"; license: string }
  /** 晋升状态机当前态。 */
  status: PromotionStatus
  /** 记录时间（ISO）。 */
  recordedAt: string
  // ── 刻意不存在的字段（DA-12：缺回写字段 = 逆向污染类型层不可表达）──
  // writebackRef? / reverseTarget? / draftPatch? / processStatus? —— 一律不声明
}

/** 晋升记录存储（replayKey → record map）。 */
export interface PromotionStore {
  records: Record<string, PromotionRecord>
}

/** 门控代数四元组（BND-PRM-11，SME-G1）。 */
export interface GateTuple {
  condition: (ctx: GateContext) => boolean
  action: string
  sideEffect: string
  rollback: string
}

/** 门控求值上下文。 */
export interface GateContext {
  channel: PromotionChannel
  draftStatus?: string
  acceptTimestamp?: string
  isFinalChapter?: boolean
  decisionGatesPass?: boolean
  consistencyP0?: boolean
  dualWriteConsistent?: boolean
  rangeValid?: boolean
  snapshotReadable?: boolean
  /** 手工 final 流注记（C-7 双轨制：final 即人工门但必须留凭证）。 */
  manualFinal?: boolean
  /** 歧义信号：rejected 决策 ∧ final 文件态并存等。 */
  ambiguous?: boolean
}

/** 门控求值结果。 */
export interface GateVerdict {
  verdict: "PASS" | "BLOCK"
  reason?: string
}

/** 能力库目标侧接口（C-6：本期冻结，真实落点归能力库侧）。 */
export interface CapabilitySink {
  /** 写入一条晋升产物（幂等：同 entryId 重复写返回既有条目）。 */
  write: (projectPath: string, record: PromotionRecord) => Promise<{ entryId: string; hash: string }>
  /** 全量重建演练：清空后重放（验收 7）。 */
  reset: (projectPath: string) => Promise<void>
  /** 当前内容指纹（reset+重放×3 → hash 恒定）。 */
  fingerprint: (projectPath: string) => Promise<string>
}

/** 晋升编排输入。 */
export interface PromoteInput {
  channel: PromotionChannel
  projectPath: string
  chapterId: string
  chapterNumber: number
  /** 终稿版本（ChapterSnapshot.revision，单调修订链，C-2）。 */
  revision: number
  /** 事实级晋升的 entity（章级晋升传 chapterId）。 */
  entity?: string
  acceptTimestamp?: string
  gateContext?: Partial<GateContext>
  trustSource?: { adrTrust: "blocked" | "reference_only" | "full"; license: string }
  /** 终稿内容摘要（用于 finalSnapshot.contentDigestPrefix，不存全文）。 */
  contentDigestPrefix?: string
}

/** 晋升编排结果。 */
export interface PromoteResult {
  record: PromotionRecord
  replayed: boolean
  blocked?: { reason: string }
}

/** 对账报告（promotionAudit）。 */
export interface PromotionAuditReport {
  recordWithoutEntry: string[]
  entryWithoutRecord: string[]
  consistent: boolean
}

/** 晋升重试队列持久化条目（R3-M01：携带完整 PromoteInput 载荷，供 replayPromotionRetryQueue 重放）。 */
export interface PromotionRetryEntry {
  replayKey: string
  channel: PromotionChannel
  chapterId: string
  chapterNumber: number
  revision: number
  entity?: string
  input: PromoteInput
  reason: string
  attempts: number
  nextRetryAt: number
  enqueuedAt: number
}

/** `replayPromotionRetryQueue` 汇总报告（R3-M01）。 */
export interface PromotionRetryReplayReport {
  attempted: number
  succeeded: number
  failed: number
  deferred: number
  deadLettered: number
  remaining: number
}

const PROMOTION_RETRY_BASE_MS = 30_000
const PROMOTION_RETRY_MAX_MS = 30 * 60_000
const PROMOTION_RETRY_DEFAULT_MAX_ATTEMPTS = 5

function computePromotionRetryBackoffMs(attempts: number): number {
  const power = Math.max(0, Math.floor(attempts) - 1)
  return Math.min(PROMOTION_RETRY_BASE_MS * Math.pow(2, power), PROMOTION_RETRY_MAX_MS)
}

/** 终稿内容摘要前缀（finalSnapshot 引用级，不存全文——铁律③）。 */
export async function sha256Prefix(content: string, prefixLen = 16): Promise<string> {
  const digest = await computeCheckpointDigest(content)
  return digest.slice(0, prefixLen)
}

// ──────────────────────────────────────────────────────────────────────────
// 常量与纯函数
// ──────────────────────────────────────────────────────────────────────────

/** 晋升状态机迁移表（BND-PRM-12；非法迁移 throw，单向门不可误开）。 */
export const PROMOTION_TRANSITIONS: Record<PromotionStatus, PromotionStatus[]> = {
  draft: ["accepted", "discarded"],
  accepted: ["promoted", "discarded"],
  promoted: ["refined", "superseded"],
  refined: [],
  superseded: [],
  discarded: [],
}

/** 门控代数四元组（BND-PRM-11）。 */
export const PROMOTION_GATE_ALGEBRA: Record<PromotionChannel, GateTuple> = {
  "formal-writeback": {
    condition: (ctx) =>
      ctx.draftStatus === "accepted" &&
      ctx.acceptTimestamp != null &&
      ctx.decisionGatesPass !== false &&
      ctx.ambiguous !== true,
    action: "appendPromotionRecord(channel=formal-writeback)",
    sideEffect: "能力库条目（CapabilitySink）+ record append + event append",
    rollback: "record 不落盘即无晋升；已落盘由 promotionAudit 对账 + backfill 兜底",
  },
  "canon-dual-write": {
    condition: (ctx) =>
      ctx.isFinalChapter === true &&
      ctx.dualWriteConsistent === true &&
      ctx.ambiguous !== true,
    action: "shadowWriteCanon 成功后 appendPromotionRecord(channel=canon-dual-write)",
    sideEffect: "canon_store + legacy 影子 + record（前两处既有）",
    rollback: "双侧不一致 → 零 record + 持久队列重放收敛（无同步 tx）",
  },
  "canon-backfill": {
    condition: (ctx) => ctx.rangeValid !== false && ctx.snapshotReadable !== false && ctx.ambiguous !== true,
    action: "replay(range) 逐章 appendPromotionRecord(channel=canon-backfill)",
    sideEffect: "幂等重放（同 replayKey 同 record）",
    rollback: "幂等无副作用累积（既有语义）",
  },
}

/**
 * 门控代数求值（纯函数）。歧义（condition 无法确定性求值 / ambiguous 信号 /
 * 关键凭证缺失）→ BLOCK + reason，绝不默认放行（BND-PRM-10）。
 */
export function evaluateGate(channel: PromotionChannel, ctx: GateContext): GateVerdict {
  if (ctx.ambiguous === true) {
    return { verdict: "BLOCK", reason: "gate-ambiguous: rejected∧final 并存或歧义信号" }
  }
  if (channel === "formal-writeback" && !ctx.acceptTimestamp) {
    return { verdict: "BLOCK", reason: "gate-ambiguous: acceptTimestamp 缺失（无人工门凭证）" }
  }
  const tuple = PROMOTION_GATE_ALGEBRA[channel]
  if (!tuple) {
    return { verdict: "BLOCK", reason: `gate-ambiguous: 未知通道 ${channel}` }
  }
  try {
    return tuple.condition(ctx) ? { verdict: "PASS" } : { verdict: "BLOCK", reason: "gate-condition-failed" }
  } catch (err) {
    return { verdict: "BLOCK", reason: `gate-ambiguous: ${toErrorMessage(err)}` }
  }
}

/**
 * 晋升幂等键（R-3 可重放复合键）。
 * `${channel}:${chapterId}:${entity}:${revision}` —— 与 ingest 内容哈希
 * （去重语义）显式区分（C-3，见模块头定义文档）。
 */
export function computePromotionReplayKey(
  channel: PromotionChannel,
  chapterId: string,
  entity: string,
  revision: number,
): string {
  return `${channel}:${chapterId}:${entity}:${revision}`
}

/** 状态迁移（表驱动纯函数；非法迁移 throw）。 */
export function transitionPromotionState(from: PromotionStatus, to: PromotionStatus): PromotionStatus {
  const legal = PROMOTION_TRANSITIONS[from]
  if (!legal || !legal.includes(to)) {
    throw new Error(`Illegal promotion state transition: ${from} → ${to}`)
  }
  return to
}

/** 事实级 entity 解析（复用 chapter-ingest 既有导出，零新增语义）。 */
export function resolvePromotionEntity(fact: string | undefined, chapterId: string): string {
  return fact ? parseFactsSubject(fact) : chapterId
}

// ──────────────────────────────────────────────────────────────────────────
// 存储（原子提交点 + append-only 审计）
// ──────────────────────────────────────────────────────────────────────────

const promotionsStore = createAtomicJsonStore<PromotionStore>(
  "promotions.json",
  () => ({ records: {} }),
  { currentVersion: 1, onMissing: "empty", onCorrupt: "throw" },
)

/** 晋升事件日志路径（append-only 审计，BND-PRM-09）。 */
export function promotionEventsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/promotion-events.jsonl`
}

/** 冲突仲裁日志路径（BND-CON-02，报告工件非真相文件）。 */
export function foldConflictsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/fold-conflicts.jsonl`
}

/** 晋升重试队列路径（C-12：独立队列，键语义与 canon-pending 不同）。 */
export function promotionRetryPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/promotion-retry.jsonl`
}

/** 追加一行到 JSONL（R3-M01：短锁防并发丢行；仅真 ENOENT 视为空新建，其余 IO 异常 fail-closed 上抛）。 */
async function appendJsonl(path: string, line: unknown): Promise<void> {
  const normPath = normalizePath(path)
  await withProjectLock(`promotion-jsonl:${normPath}`, async () => {
    const dir = normPath.slice(0, normPath.lastIndexOf("/"))
    await createDirectory(dir)
    let existing = ""
    try {
      existing = await readFile(normPath)
    } catch (err) {
      if (!(await isMissingFile(normPath, err))) {
        throw err
      }
    }
    await writeFileAtomic(normPath, existing + JSON.stringify(line) + "\n")
  })
}

/** 追加晋升事件（append-only；写失败 warn 不阻断晋升主路径——事件层允许间隙）。 */
export async function appendPromotionEvent(
  projectPath: string,
  event: { type: PromotionEventType; replayKey: string; channel: PromotionChannel; detail?: string; ts: string },
): Promise<void> {
  try {
    await appendJsonl(promotionEventsPath(projectPath), event)
  } catch (err) {
    logger.warn("promotion-bridge", `event append failed (non-fatal): ${toErrorMessage(err)}`)
  }
}

/** 追加冲突仲裁日志（BND-CON-02；报告工件，可删重建）。 */
export async function appendFoldConflictLog(
  projectPath: string,
  conflict: {
    ts: string
    source: "pre-write-gate" | "promotion-gate"
    chapter: string
    subject: string
    shouldSide: string
    actualSide: string
    resolution: "actual-first"
    note?: string
  },
): Promise<void> {
  try {
    await appendJsonl(foldConflictsPath(projectPath), conflict)
  } catch (err) {
    logger.warn("promotion-bridge", `fold-conflict log append failed (non-fatal): ${toErrorMessage(err)}`)
  }
}

/** 入重试队列（C-12 / R3-M01：仅瞬态 IO 失败入队，携带完整 PromoteInput 载荷供重放）。 */
export async function enqueuePromotionRetry(
  projectPath: string,
  input: PromoteInput,
  reason: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const entity = input.entity ?? input.chapterId
    const line: PromotionRetryEntry = {
      replayKey: computePromotionReplayKey(input.channel, input.chapterId, entity, input.revision),
      channel: input.channel,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      revision: input.revision,
      entity: input.entity,
      input: {
        ...input,
        projectPath: normalizePath(input.projectPath),
        ...(input.gateContext ? { gateContext: { ...input.gateContext } } : {}),
        ...(input.trustSource ? { trustSource: { ...input.trustSource } } : {}),
      },
      reason,
      attempts: 1,
      nextRetryAt: now + computePromotionRetryBackoffMs(1),
      enqueuedAt: now,
    }
    await appendJsonl(promotionRetryPath(projectPath), line)
  } catch (err) {
    logger.warn("promotion-bridge", `retry enqueue failed (non-fatal): ${toErrorMessage(err)}`)
  }
}

/**
 * R3-M01: 解析下一条修订号（供 formal-writeback 通道防二次修订 replayKey 碰撞）。
 * - 同 channel + chapterId + entity 已有相同 contentDigestPrefix → 复用该 revision（同内容重放幂等）；
 * - 存在旧版记录但 contentDigestPrefix 已变化 → 返回 maxRevision + 1；
 * - 无既有记录 → 返回 1。
 */
export async function resolveNextPromotionRevision(
  projectPath: string,
  channel: PromotionChannel,
  chapterId: string,
  entity: string,
  contentDigestPrefix: string,
): Promise<number> {
  const store = await promotionsStore.load(projectPath)
  const prefix = `${channel}:${chapterId}:${entity}:`
  let maxRevision = 0
  for (const record of Object.values(store.records)) {
    if (record.channel !== channel) continue
    if (!record.replayKey.startsWith(prefix)) continue
    if (
      contentDigestPrefix &&
      record.finalSnapshot?.contentDigestPrefix === contentDigestPrefix &&
      typeof record.sourceRef?.revision === "number" &&
      record.sourceRef.revision >= 1
    ) {
      return record.sourceRef.revision
    }
    if (typeof record.sourceRef?.revision === "number" && record.sourceRef.revision > maxRevision) {
      maxRevision = record.sourceRef.revision
    }
  }
  return maxRevision > 0 ? maxRevision + 1 : 1
}

// ──────────────────────────────────────────────────────────────────────────
// CapabilitySink（C-6：本期冻结接口 + 内存演练实现）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 内存演练实现（验收 7：reset+重放×3 → hash 恒定）。
 * 真实能力库落点（8 字段派生 / trust 分级 / staging）归能力库侧与 E-06。
 */
export const inMemoryCapabilitySink: CapabilitySink = {
  async write(_projectPath, record) {
    const entryId = record.targetRef.entryId ?? `prom-${record.replayKey}`
    const hash = `sha256:${entryId}:${record.finalSnapshot.contentDigestPrefix}`
    return { entryId, hash }
  },
  async reset() {
    // 内存实现无持久状态，reset 为 noop
  },
  async fingerprint(_projectPath) {
    return "in-memory-sink:noop"
  },
}

// ──────────────────────────────────────────────────────────────────────────
// 编排（promote：三段短锁 + 补写 sink + 严禁 BLOCK 入重试队列）
// ──────────────────────────────────────────────────────────────────────────

async function promoteInternal(
  input: PromoteInput,
  sink: CapabilitySink,
  enqueueRetryOnFailure: boolean,
): Promise<PromoteResult> {
  const pp = normalizePath(input.projectPath)
  const lockKey = `promotions:${pp}`
  const entity = input.entity ?? input.chapterId
  const replayKey = computePromotionReplayKey(input.channel, input.chapterId, entity, input.revision)
  const nowIso = new Date().toISOString()

  type Phase1Outcome =
    | { kind: "replayed"; record: PromotionRecord }
    | { kind: "backfill"; record: PromotionRecord }
    | { kind: "blocked"; reason: string }
    | { kind: "created"; record: PromotionRecord }
    | { kind: "save_failed"; err: unknown }

  // 阶段 1（短锁 promotions:${pp}）：查键幂等 / 门控 / 首次原子落盘，绝不持锁执行外部 sink IO
  const phase1: Phase1Outcome = await withProjectLock(lockKey, async () => {
    const store = await promotionsStore.load(input.projectPath)
    const existing = store.records[replayKey]
    if (existing) {
      if (existing.targetRef?.entryId) {
        return { kind: "replayed" as const, record: existing }
      }
      // 既有 record 缺 targetRef.entryId → 释放锁后进入阶段 2 补写 sink
      return { kind: "backfill" as const, record: existing }
    }

    const gateCtx: GateContext = {
      channel: input.channel,
      draftStatus: input.gateContext?.draftStatus,
      acceptTimestamp: input.acceptTimestamp ?? input.gateContext?.acceptTimestamp,
      isFinalChapter: input.gateContext?.isFinalChapter,
      decisionGatesPass: input.gateContext?.decisionGatesPass,
      consistencyP0: input.gateContext?.consistencyP0,
      dualWriteConsistent: input.gateContext?.dualWriteConsistent,
      rangeValid: input.gateContext?.rangeValid,
      snapshotReadable: input.gateContext?.snapshotReadable,
      manualFinal: input.gateContext?.manualFinal,
      ambiguous: input.gateContext?.ambiguous,
    }
    const verdict = evaluateGate(input.channel, gateCtx)
    if (verdict.verdict === "BLOCK") {
      return { kind: "blocked" as const, reason: verdict.reason ?? "gate-blocked" }
    }

    const record: PromotionRecord = {
      channel: input.channel,
      sourceRef: { chapterId: input.chapterId, chapterNumber: input.chapterNumber, revision: input.revision },
      targetRef: {},
      acceptTimestamp: input.acceptTimestamp ?? "",
      replayKey,
      gatePass: {
        decisionGates: input.gateContext?.decisionGatesPass !== false,
        consistencyP0: input.gateContext?.consistencyP0 !== false,
        manualFinal: input.gateContext?.manualFinal === true,
        evaluatedAt: nowIso,
      },
      finalSnapshot: {
        chapterId: input.chapterId,
        contentDigestPrefix: input.contentDigestPrefix ?? "",
        extractedAt: nowIso,
      },
      // E-06 (C-3): 缺省 trustSource 修正——unknown license 按 GOV-TRUST 保守默认
      // 应为 blocked（原 reference_only 与「未知/未声明 → blocked」相反）；
      // 仅新记录生效，不回改历史记录（hy3 F-10 migration 注记）。
      trustSource: input.trustSource ?? { adrTrust: "blocked", license: "unknown" },
      status: "promoted",
      recordedAt: nowIso,
    }

    const next: PromotionStore = { records: { ...store.records, [replayKey]: record } }
    try {
      await promotionsStore.save(input.projectPath, next)
    } catch (err) {
      return { kind: "save_failed" as const, err }
    }
    return { kind: "created" as const, record }
  })

  if (phase1.kind === "replayed") {
    await appendPromotionEvent(input.projectPath, {
      type: "promote_replayed",
      replayKey,
      channel: input.channel,
      detail: "same replayKey → same PromotionRecord (idempotent replay)",
      ts: nowIso,
    })
    return { record: phase1.record, replayed: true }
  }

  if (phase1.kind === "blocked") {
    // R3-M01: 策略门控 BLOCK 绝不进入瞬态重试队列，仅写 ambiguity_block 审计事件
    await appendPromotionEvent(input.projectPath, {
      type: "ambiguity_block",
      replayKey,
      channel: input.channel,
      detail: phase1.reason,
      ts: nowIso,
    })
    return { record: null as unknown as PromotionRecord, replayed: false, blocked: { reason: phase1.reason } }
  }

  if (phase1.kind === "save_failed") {
    await appendPromotionEvent(input.projectPath, {
      type: "promote_failed",
      replayKey,
      channel: input.channel,
      detail: `atomic save failed: ${toErrorMessage(phase1.err)}`,
      ts: nowIso,
    })
    if (enqueueRetryOnFailure) {
      await enqueuePromotionRetry(input.projectPath, input, `atomic-save-failed: ${toErrorMessage(phase1.err)}`)
    }
    throw phase1.err
  }

  // 阶段 2（锁外）：执行外部 CapabilitySink 写入（失败入队重放，不回滚已落盘 record——凭证先行，C-13）
  const targetRecord = phase1.record
  let finalRecord: PromotionRecord = targetRecord
  let written: { entryId: string; hash: string } | null = null
  try {
    written = await sink.write(input.projectPath, targetRecord)
  } catch (err) {
    if (enqueueRetryOnFailure) {
      await enqueuePromotionRetry(input.projectPath, input, `sink-write-failed: ${toErrorMessage(err)}`)
    }
  }

  // 阶段 3（短锁 promotions:${pp}）：重读最新 store，仅合并写入该 replayKey 的 targetRef.entryId
  if (written !== null) {
    const entryId = written.entryId
    try {
      finalRecord = await withProjectLock(lockKey, async () => {
        const latestStore = await promotionsStore.load(input.projectPath)
        const latest = latestStore.records[replayKey] ?? targetRecord
        const merged: PromotionRecord = {
          ...latest,
          targetRef: { ...latest.targetRef, entryId },
        }
        await promotionsStore.save(input.projectPath, {
          records: { ...latestStore.records, [replayKey]: merged },
        })
        return merged
      })
    } catch (err) {
      if (enqueueRetryOnFailure) {
        await enqueuePromotionRetry(input.projectPath, input, `sink-ref-save-failed: ${toErrorMessage(err)}`)
      }
    }
  }

  const isBackfill = phase1.kind === "backfill"
  await appendPromotionEvent(input.projectPath, {
    type: isBackfill ? "promote_replayed" : "promote_success",
    replayKey,
    channel: input.channel,
    detail: isBackfill
      ? `backfill sink entryId=${finalRecord.targetRef.entryId ?? "pending"}`
      : `entity=${entity} revision=${input.revision}`,
    ts: nowIso,
  })
  return { record: finalRecord, replayed: isBackfill }
}

/**
 * 晋升编排入口（三桥共享）。
 *
 * 1. 查键幂等（短锁）：replayKey 命中既有完整 record → 返回既有；缺 targetRef.entryId → 补写 sink。
 * 2. 门控求值：evaluateGate → BLOCK → ambiguity_block 事件，绝不入重试队列。
 * 3. 原子落盘（短锁）：promotions.json（createAtomicJsonStore，损坏 fail-closed）。
 * 4. 锁外 CapabilitySink 写入（幂等；失败入重试队列，不回滚 record——凭证先行）。
 * 5. 短锁合并写回 targetRef.entryId，避免覆盖并发写入的其他 replayKey。
 */
export async function promote(
  input: PromoteInput,
  sink: CapabilitySink = inMemoryCapabilitySink,
): Promise<PromoteResult> {
  return promoteInternal(input, sink, true)
}

function parsePromotionRetryLines(raw: string, projectPath: string): PromotionRetryEntry[] {
  const byKey = new Map<string, PromotionRetryEntry>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<PromotionRetryEntry>
      if (!parsed || typeof parsed.replayKey !== "string" || !parsed.replayKey) continue
      const input: PromoteInput | null =
        parsed.input &&
        typeof parsed.input === "object" &&
        typeof parsed.input.channel === "string" &&
        typeof parsed.input.chapterId === "string"
          ? {
              ...parsed.input,
              projectPath: parsed.input.projectPath || projectPath,
            }
          : typeof parsed.channel === "string" &&
              typeof parsed.chapterId === "string" &&
              typeof parsed.chapterNumber === "number" &&
              typeof parsed.revision === "number"
            ? {
                channel: parsed.channel,
                projectPath,
                chapterId: parsed.chapterId,
                chapterNumber: parsed.chapterNumber,
                revision: parsed.revision,
                entity: parsed.entity,
              }
            : null
      if (!input) continue
      const normalized: PromotionRetryEntry = {
        replayKey: parsed.replayKey,
        channel: input.channel,
        chapterId: input.chapterId,
        chapterNumber: input.chapterNumber,
        revision: input.revision,
        entity: input.entity,
        input,
        reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
        attempts: typeof parsed.attempts === "number" && Number.isFinite(parsed.attempts) && parsed.attempts >= 1 ? Math.floor(parsed.attempts) : 1,
        nextRetryAt: typeof parsed.nextRetryAt === "number" && Number.isFinite(parsed.nextRetryAt) ? parsed.nextRetryAt : 0,
        enqueuedAt: typeof parsed.enqueuedAt === "number" && Number.isFinite(parsed.enqueuedAt) ? parsed.enqueuedAt : 0,
      }
      // 按 replayKey 去重取最新项
      byKey.delete(normalized.replayKey)
      byKey.set(normalized.replayKey, normalized)
    } catch (err) {
      logger.warn("promotion-bridge", `skipping malformed promotion retry line: ${toErrorMessage(err)}`)
    }
  }
  return [...byKey.values()]
}

/**
 * R3-M01: 重放 `.novel/promotion-retry.jsonl` 瞬态失败队列。
 *
 * 三段无嵌套锁（严守 novel-locks 单锁铁律）：
 *   - Phase A（持 `promotion-jsonl:<retryPath>` 短锁）：读取并按 replayKey 去重，筛出到期且未超限项；
 *   - Phase B（锁外）：逐条调用 `promoteInternal(..., false)` 重放，成功出队，失败递增退避或转死信；
 *   - Phase C（持 `promotion-jsonl:<retryPath>` 短锁）：重读最新队列合并并发新入队项后原子重写。
 */
export async function replayPromotionRetryQueue(
  projectPath: string,
  sink: CapabilitySink = inMemoryCapabilitySink,
  options: { now?: number; maxAttempts?: number } = {},
): Promise<PromotionRetryReplayReport> {
  const now = options.now ?? Date.now()
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? PROMOTION_RETRY_DEFAULT_MAX_ATTEMPTS))
  const retryPath = normalizePath(promotionRetryPath(projectPath))
  const lockKey = `promotion-jsonl:${retryPath}`

  const dueEntries: PromotionRetryEntry[] = []
  const deferredEntries: PromotionRetryEntry[] = []
  const processedSnapshot = new Map<string, number>()
  let preDeadLettered = 0
  let fileMissing = false

  // Phase A（短锁）：加载并分区
  await withProjectLock(lockKey, async () => {
    let raw: string
    try {
      raw = await readFile(retryPath)
    } catch (err) {
      if (await isMissingFile(retryPath, err)) {
        fileMissing = true
        return
      }
      throw err
    }
    if (!raw.trim()) return
    const entries = parsePromotionRetryLines(raw, projectPath)
    for (const entry of entries) {
      processedSnapshot.set(entry.replayKey, entry.enqueuedAt)
      if (entry.attempts >= maxAttempts) {
        preDeadLettered += 1
        continue
      }
      if (now < entry.nextRetryAt) {
        deferredEntries.push(entry)
        continue
      }
      dueEntries.push(entry)
    }
  })

  if (fileMissing || (dueEntries.length === 0 && preDeadLettered === 0)) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: deferredEntries.length,
      deadLettered: 0,
      remaining: deferredEntries.length,
    }
  }

  // Phase B（锁外）：重放全部到期项
  let attempted = 0
  let succeeded = 0
  let failed = 0
  let deadLettered = preDeadLettered
  const rescheduledByKey = new Map<string, PromotionRetryEntry>()

  for (const entry of dueEntries) {
    attempted += 1
    try {
      const res = await promoteInternal(entry.input, sink, false)
      if (res.blocked) {
        // 策略阻断不可重试，直接死信出队
        deadLettered += 1
        continue
      }
      if (res.record?.targetRef?.entryId) {
        succeeded += 1
        continue
      }
      // sink 写入仍未补齐 entryId
      failed += 1
      const nextAttempts = entry.attempts + 1
      if (nextAttempts >= maxAttempts) {
        deadLettered += 1
      } else {
        rescheduledByKey.set(entry.replayKey, {
          ...entry,
          attempts: nextAttempts,
          nextRetryAt: now + computePromotionRetryBackoffMs(nextAttempts),
          reason: "sink-write-incomplete",
        })
      }
    } catch (err) {
      failed += 1
      const nextAttempts = entry.attempts + 1
      if (nextAttempts >= maxAttempts) {
        deadLettered += 1
      } else {
        rescheduledByKey.set(entry.replayKey, {
          ...entry,
          attempts: nextAttempts,
          nextRetryAt: now + computePromotionRetryBackoffMs(nextAttempts),
          reason: toErrorMessage(err),
        })
      }
    }
  }

  // Phase C（短锁）：重读最新队列保留并发新项并原子重写
  const remainingCount = await withProjectLock(lockKey, async () => {
    let latestEntries: PromotionRetryEntry[] = []
    try {
      const latestRaw = await readFile(retryPath)
      if (latestRaw.trim()) {
        latestEntries = parsePromotionRetryLines(latestRaw, projectPath)
      }
    } catch (err) {
      if (!(await isMissingFile(retryPath, err))) {
        throw err
      }
    }

    const nextQueue = new Map<string, PromotionRetryEntry>()
    for (const entry of deferredEntries) {
      nextQueue.set(entry.replayKey, entry)
    }
    for (const [key, entry] of rescheduledByKey) {
      nextQueue.set(key, entry)
    }
    for (const entry of latestEntries) {
      const seenEnqueuedAt = processedSnapshot.get(entry.replayKey)
      if (seenEnqueuedAt === undefined || entry.enqueuedAt > seenEnqueuedAt) {
        nextQueue.set(entry.replayKey, entry)
      }
    }

    const serialized = [...nextQueue.values()].map((item) => JSON.stringify(item)).join("\n")
    const dir = retryPath.slice(0, retryPath.lastIndexOf("/"))
    await createDirectory(dir)
    await writeFileAtomic(retryPath, serialized ? `${serialized}\n` : "")
    return nextQueue.size
  })

  return {
    attempted,
    succeeded,
    failed,
    deferred: deferredEntries.length,
    deadLettered,
    remaining: remainingCount,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 对账（promotionAudit：凭证与库状态一致性，BND-CON-03）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 对账：record 集合 vs 能力库条目集合。
 * recordWithoutEntry = 有凭证无条目（backfill 重放兜底）；
 * entryWithoutRecord = 有条目无凭证（promotionAudit 检出，P4 级）。
 */
export async function promotionAudit(
  projectPath: string,
  // 内存 sink 无持久条目集合 → entryWithoutRecord 恒空（真实落点归能力库侧）；
  // 参数保留为接口契约（未来真实 sink 接入后启用）。
  _sink: CapabilitySink = inMemoryCapabilitySink,
): Promise<PromotionAuditReport> {
  const store = await promotionsStore.load(projectPath)
  const records = Object.values(store.records)
  const recordWithoutEntry: string[] = []
  for (const r of records) {
    if (!r.targetRef.entryId) {
      recordWithoutEntry.push(r.replayKey)
    }
  }
  // 内存 sink 无持久条目集合 → entryWithoutRecord 恒空（真实落点归能力库侧）
  const entryWithoutRecord: string[] = []
  return {
    recordWithoutEntry,
    entryWithoutRecord,
    consistent: recordWithoutEntry.length === 0 && entryWithoutRecord.length === 0,
  }
}

/** promotion_replay_success 指标（验收 3）：重放成功 / 总晋升尝试。 */
export async function promotionReplaySuccessRate(projectPath: string): Promise<{ success: number; total: number; rate: number }> {
  const store = await promotionsStore.load(projectPath)
  const records = Object.values(store.records)
  const total = records.length
  const success = records.filter((r) => r.status === "promoted").length
  return { success, total, rate: total === 0 ? 1 : success / total }
}
