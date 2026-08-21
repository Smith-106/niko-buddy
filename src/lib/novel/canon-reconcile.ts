/**
 * canon-reconcile.ts — Canon 两阶段重放对账编排（T17 / F-14 / A-05.4）。
 *
 * ## 职责（蓝图 §6 T17）
 *   在 T15 `shadowWriteCanon` 双写之后，对账若不一致，执行**两阶段重放**：
 *
 *   1. **第一阶段（按 digest 重放补齐）**：读取 `.novel/canon-pending.jsonl` 持久
 *      待写队列，调用 T15 `replayPendingQueue` 按 digest 幂等重放一次，让失败写
 *      补齐缺口（canon ingest 按 (chapter,digest) 去重，重放幂等不双写）。
 *   2. **第二阶段（再对账 → 仍不一致才告警）**：重放后重新对账，**仅当重放后
 *      仍存在 divergences 才发出 alert**；重放事件**全程留痕**（trace），即便
 *      重放成功补齐也要留下"曾不一致→重放补齐"的证据，**绝不静默吞差异**。
 *
 *   fast-diff（Myers O(ND)，替代 LCS）用于差异度量，把对账差异表达为编辑脚本
 *   + 编辑距离，量化 divergence 严重度。
 *
 * ## 与 T15 的关系（薄编排，不复制主逻辑）
 *   T15 已提供原语：`reconcileOutcomes`（纯对账投影）、`replayPendingQueue`
 *   （按序重放统计）、`loadPendingQueue`（JSONL 读）。本模块**组合**这些原语
 *   + 加 trace 留痕 + fast-diff 度量，不平行复制 reconcile/replay 主逻辑。
 *
 * ## Draft-first
 *   纯控制/机械编排（零 LLM），不涉及 AI 写作，Draft-first 不适用。
 *
 * 遵循 QMAI/CLAUDE.md：T17 新增锚点，落 `src/lib/novel/`；运行期队列在 `.novel/`。
 */

import fastDiff from "fast-diff"
import {
  canonPendingQueuePath,
  loadPendingQueue,
  reconcileOutcomes,
  replayPendingQueue,
  type CanonDualWriteDeps,
  type CanonPendingRecord,
  type CanonWriteOutcome,
  type ReplayReport,
} from "./canon-dual-write"

// ──────────────────────────────────────────────────────────────────────────
// fast-diff 差异度量（Myers O(ND) 替代 LCS）
// ──────────────────────────────────────────────────────────────────────────

/** 单条编辑操作（normalized 自 fast-diff 的 [-1|0|1, string] 元组）。 */
export interface DiffOp {
  /** "equal"=不变 / "insert"=新增 / "delete"=删除。 */
  type: "equal" | "insert" | "delete"
  /** 该段文本。 */
  text: string
}

/** 两段文本的差异度量结果。 */
export interface DiffMetric {
  /** Myers 编辑脚本（保序）。 */
  edits: DiffOp[]
  /** 总编辑距离 = insertions + deletions（字符数）。 */
  distance: number
  /** 插入字符数。 */
  insertions: number
  /** 删除字符数。 */
  deletions: number
}

/**
 * 计算两段文本的 Myers O(ND) 差异度量。
 *
 * fast-diff 返回 `[-1|0|1, string][]`（DELETE/EQUAL/INSERT）；本函数归一化为
 * `DiffOp[]` 并汇总编辑距离 / 插入 / 删除字符数。相比 LCS，Myers 在大文本与
 * 稀疏差异下更优（O(ND) 复杂度，N=文本长，D=差异量）。
 */
export function diffMetric(a: string, b: string): DiffMetric {
  const raw = fastDiff(a, b) as Array<[-1 | 0 | 1, string]>
  const edits: DiffOp[] = []
  let insertions = 0
  let deletions = 0
  for (const [op, text] of raw) {
    if (op === 0) {
      edits.push({ type: "equal", text })
    } else if (op === 1) {
      edits.push({ type: "insert", text })
      insertions += text.length
    } else {
      edits.push({ type: "delete", text })
      deletions += text.length
    }
  }
  return { edits, distance: insertions + deletions, insertions, deletions }
}

// ──────────────────────────────────────────────────────────────────────────
// 重放留痕（trace 事件）
// ──────────────────────────────────────────────────────────────────────────

/** 两阶段重放过程中的留痕事件（永不静默吞差异）。 */
export interface ReplayTraceEvent {
  /** 事件阶段。 */
  phase: "reconcile-initial" | "replay" | "reconcile-final" | "alert" | "noop"
  /** 关联 digest（按需）。 */
  digest?: string
  /** 可读描述。 */
  message: string
  /** 事件时间（epoch ms）。 */
  at: number
}

/** 单条对账差异项（与 T15 `reconcileOutcomes` 输出同构）。 */
export interface DivergenceItem {
  digest: string
  reasons: string[]
}

/** 单条差异的度量附件：digest + 编辑距离 + 编辑脚本。 */
export interface DivergenceWithMetric extends DivergenceItem {
  /** legacy 与 canon 序列化负载的编辑距离（差异严重度）。 */
  metric: DiffMetric
}

// ──────────────────────────────────────────────────────────────────────────
// 两阶段重放对账报告
// ──────────────────────────────────────────────────────────────────────────

/** `twoPhaseReconcile` 汇总报告。 */
export interface TwoPhaseReconcileReport {
  /** 初始（重放前）对账是否一致。 */
  initialConsistent: boolean
  /** 初始差异项。 */
  initialDivergences: DivergenceItem[]
  /** 重放统计；null = 无需重放（初始即一致）。 */
  replayReport: ReplayReport | null
  /** 重放前持久队列中的 digest 集（按出现序）。 */
  pendingDigests: string[]
  /** 重放成功补齐的 digest 集（重放前在队列、重放后已出队）。 */
  replayedDigests: string[]
  /** 重放后是否一致。 */
  finalConsistent: boolean
  /** 重放后仍存在的差异项。 */
  finalDivergences: DivergenceWithMetric[]
  /** 全程留痕事件（绝不静默吞差异）。 */
  trace: ReplayTraceEvent[]
  /** 是否告警：true 当且仅当重放后仍不一致。 */
  alerted: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// 内部：由 pending 记录构造 fast-diff 度量
// ──────────────────────────────────────────────────────────────────────────

/**
 * 对单条 pending 记录计算 legacy 与 canon 序列化负载的 Myers 差异度量。
 * 用于把"为何不一致"量化为可读编辑脚本 + 编辑距离。
 */
export function divergenceMetric(rec: CanonPendingRecord): DiffMetric {
  return diffMetric(JSON.stringify(rec.legacyPayload), JSON.stringify(rec.canonPayload))
}

// ──────────────────────────────────────────────────────────────────────────
// 两阶段重放编排入口
// ──────────────────────────────────────────────────────────────────────────

/**
 * 两阶段重放对账编排（T17 核心）：
 *
 *   阶段 1 —— 初始对账；若不一致，快照持久队列 digest 集，调用 T15
 *             `replayPendingQueue` 按 digest 幂等重放一次，补齐失败写缺口。
 *
 *   阶段 2 —— 重放后重新读队列，**成功出队的 digest 视为已补齐**；剩余差异 =
 *             初始差异扣除已补齐 digest。仅当剩余差异非空才 `alerted=true`。
 *             对每条剩余差异附 fast-diff 编辑度量（legacy vs canon 序列化负载）。
 *
 *   全程 `trace` 留痕：即便重放成功补齐，也保留"曾不一致→重放补齐"的证据，
 *   **绝不静默吞差异**。
 *
 * @param deps 双写依赖（与 T15 同契约，注入队列 IO + 写适配器）。
 * @param projectPath 项目路径（队列落在 `{project}/.novel/canon-pending.jsonl`）。
 * @param results 本次双写的逐操作结果（来自 `shadowWriteCanon` 的 `results`）。
 * @param now 当前时间（epoch ms，决定重放哪些到期项）。
 */
export async function twoPhaseReconcile(
  deps: CanonDualWriteDeps,
  projectPath: string,
  results: CanonWriteOutcome[],
  now: number,
): Promise<TwoPhaseReconcileReport> {
  const trace: ReplayTraceEvent[] = []
  const initial = reconcileOutcomes(results)
  trace.push({
    phase: "reconcile-initial",
    at: now,
    message: initial.consistent
      ? "consistent"
      : `${initial.divergences.length} divergence(s) detected`,
  })

  if (initial.consistent) {
    trace.push({ phase: "noop", at: now, message: "no replay needed" })
    return {
      initialConsistent: true,
      initialDivergences: [],
      replayReport: null,
      pendingDigests: [],
      replayedDigests: [],
      finalConsistent: true,
      finalDivergences: [],
      trace,
      alerted: false,
    }
  }

  // ── 阶段 1：快照队列 → 按 digest 重放 ──
  const queuePath = canonPendingQueuePath(projectPath)
  const before = await loadPendingQueue(deps, queuePath)
  const pendingDigests = before.map((r) => r.digest)
  trace.push({
    phase: "replay",
    at: now,
    message: `replaying ${before.length} pending record(s) by digest`,
  })

  const replayReport = await replayPendingQueue(deps, projectPath, now)

  // ── 阶段 2：重放后重新对账（成功出队的 digest 视为已补齐） ──
  const after = await loadPendingQueue(deps, queuePath)
  const afterSet = new Set(after.map((r) => r.digest))
  const replayedDigests: string[] = []
  for (const d of pendingDigests) {
    if (!afterSet.has(d)) {
      replayedDigests.push(d)
      trace.push({ phase: "replay", digest: d, at: now, message: "gap filled by replay" })
    }
  }

  const resolved = new Set(replayedDigests)
  const stillDivergent = initial.divergences.filter((d) => !resolved.has(d.digest))
  for (const d of stillDivergent) {
    trace.push({
      phase: "replay",
      digest: d.digest,
      at: now,
      message: "still divergent after replay",
    })
  }

  // 为剩余差异附 fast-diff 度量（从队列记录取 legacy/canon 负载）
  const afterByDigest = new Map<string, CanonPendingRecord>()
  for (const r of after) afterByDigest.set(r.digest, r)
  const finalDivergences: DivergenceWithMetric[] = stillDivergent.map((d) => {
    const rec = afterByDigest.get(d.digest)
    const metric = rec ? divergenceMetric(rec) : diffMetric(d.reasons.join(";"), "")
    return { digest: d.digest, reasons: d.reasons, metric }
  })

  const finalConsistent = finalDivergences.length === 0
  trace.push({
    phase: "reconcile-final",
    at: now,
    message: finalConsistent
      ? "consistent after replay (all gaps filled)"
      : `${finalDivergences.length} divergence(s) remain`,
  })

  const alerted = !finalConsistent
  if (alerted) {
    trace.push({
      phase: "alert",
      at: now,
      message: `alert: ${finalDivergences.length} unresolved divergence(s) — replay did NOT silently swallow`,
    })
  }

  return {
    initialConsistent: false,
    initialDivergences: initial.divergences,
    replayReport,
    pendingDigests,
    replayedDigests,
    finalConsistent,
    finalDivergences,
    trace,
    alerted,
  }
}
