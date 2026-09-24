/**
 * repair-loop.ts — 波2-C：反 AI 修正闭环率 + FP 误报统计（账本聚合）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 15 深化）：
 *   - GLM P1 缺口「anti-ai-correction-loop」：反 AI 修正闭环缺闭环率指标与
 *     FP 统计——本模块从事件账本切片**聚合**出数值（不新增真源、不写状态）；
 *   - GLM/DS 验收：闭环率与误报率可从账本切片聚合出数值并 UI 展示。
 *
 * 机械口径（账本可证，全部派生自 append-only 事件流）：
 *   - 一次 fail 的门运行 = 待闭环项（scope = gate+bookId+chapterId）；
 *   - fail 后同 scope 出现 pass 且其间存在 retry/generate 事件 → **修正闭环**
 *     （correction：检测→修正→复检通过走完闭环）；
 *   - fail 后同 scope 出现 pass 且其间**无任何 retry/generate** → **FP 误报**
 *     （内容未变而裁定翻转 = 原检测为假阳性的机械代理口径）；
 *   - fail 后无后续运行 = 未闭环（open，不计入闭环率分子）；
 *   - closureRate = corrections / failRuns；fpRate = falsePositives / failRuns；
 *     无 fail 运行 → 双率 null（无可闭环项，不臆造 100%）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

import { GATE_PRIORITY_ORDER, type GateKey } from "./audit-taxonomy"
import { readGateRunPayload, sliceRunEvents, type RunEvent, type RunEventLedger } from "./run-event-ledger"
import { checkChapterContract, parseChapterContractSection, type ChapterContractSection } from "./deep-chapter-task-brief"
import {
  dimensionResultsToReviewResults,
  minimalReworkSetFromDimensionIssues,
  type DimensionReviewIssue,
  type DimensionReviewResult,
  type SixReviewDimensionKey,
} from "./dimension-review-adapter"
import type { NovelReviewResult } from "./review-adapter"

// ============================================================================
// 契约
// ============================================================================

/** 单门修正闭环统计。 */
export interface CorrectionLoopGateStat {
  readonly gate: GateKey
  /** fail 运行数（待闭环项）。 */
  readonly failRuns: number
  /** fail→pass 间出现 retry/generate 的闭环数（真修正）。 */
  readonly corrections: number
  /** fail→pass 间无修正动作的翻转数（FP 机械代理口径）。 */
  readonly falsePositives: number
  /** 尚未出现后续同 scope 运行的 fail 数（open）。 */
  readonly openFailRuns: number
  /** corrections / failRuns；无 fail 运行 → null。 */
  readonly closureRate: number | null
  /** falsePositives / failRuns；无 fail 运行 → null。 */
  readonly fpRate: number | null
}

/** 修正闭环统计总表（按门 + 全局合计）。 */
export interface CorrectionLoopStats {
  readonly gates: readonly CorrectionLoopGateStat[]
  readonly totals: {
    readonly failRuns: number
    readonly corrections: number
    readonly falsePositives: number
    readonly openFailRuns: number
    readonly closureRate: number | null
    readonly fpRate: number | null
  }
}

// ============================================================================
// 聚合
// ============================================================================

/** 门运行事件的 scope 键（gate+bookId+chapterId；未提供维度视为空串）。 */
function scopeKeyOf(event: RunEvent): string {
  return [
    readGateRunPayload(event)?.gate ?? "",
    event.bookId ?? "",
    event.chapterId === undefined ? "" : String(event.chapterId),
  ].join("|")
}

/**
 * 修正闭环统计（纯聚合）：
 *   1. gate-run 事件按 seq 升序扫描（账本天然全序）；
 *   2. 每个 fail 运行向后找同 scope 的下一条 gate-run：
 *      pass 且间隔内有 retry/generate → correction；pass 且无 → FP；
 *      fail / 无后续 → open（不计分子）；
 *   3. 事件 payload.gate 与事件键以账本事实为准（readGateRunPayload 判读）。
 */
export function buildCorrectionLoopStats(
  ledger: RunEventLedger,
  options?: { readonly gates?: readonly GateKey[] },
): CorrectionLoopStats {
  const gateFilter = options?.gates
  const gateRuns = sliceRunEvents(ledger, { kind: "gate-run" })
  // 按 scope 分组（组内保持 seq 升序）
  const byScope = new Map<string, RunEvent[]>()
  for (const event of gateRuns) {
    const key = scopeKeyOf(event)
    const list = byScope.get(key)
    if (list) list.push(event)
    else byScope.set(key, [event])
  }

  const statsByGate = new Map<GateKey, { failRuns: number; corrections: number; falsePositives: number; openFailRuns: number }>()
  const ensure = (gate: GateKey) => {
    const current = statsByGate.get(gate)
    if (current) return current
    const fresh = { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 }
    statsByGate.set(gate, fresh)
    return fresh
  }

  for (const [, runs] of byScope) {
    for (let i = 0; i < runs.length; i += 1) {
      const event = runs[i] as RunEvent
      const payload = readGateRunPayload(event)
      if (!payload || payload.status !== "fail") continue
      const gate = payload.gate
      if (gateFilter !== undefined && !gateFilter.includes(gate)) continue
      const stat = ensure(gate)
      stat.failRuns += 1
      // 向后扫：同 scope 的下一条 gate-run（i+1 起，组内全序）
      const next = (runs[i + 1] as RunEvent | undefined) ?? null
      if (next === null) {
        stat.openFailRuns += 1
        continue
      }
      const nextPayload = readGateRunPayload(next)
      if (!nextPayload || nextPayload.status !== "pass") continue
      // 间隔内是否存在修正动作（retry / generate，seq 严格位于两者之间）
      const hadCorrection = sliceRunEvents(ledger, { kinds: ["retry", "generate"] }).some(
        (action) => action.seq > event.seq && action.seq < next.seq,
      )
      if (hadCorrection) stat.corrections += 1
      else stat.falsePositives += 1
    }
  }

  const gates = (gateFilter !== undefined ? gateFilter : GATE_PRIORITY_ORDER).map((gate) => {
    const stat = statsByGate.get(gate) ?? { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 }
    const rate = (numerator: number): number | null => (stat.failRuns === 0 ? null : numerator / stat.failRuns)
    return {
      gate,
      failRuns: stat.failRuns,
      corrections: stat.corrections,
      falsePositives: stat.falsePositives,
      openFailRuns: stat.openFailRuns,
      closureRate: rate(stat.corrections),
      fpRate: rate(stat.falsePositives),
    }
  })
  const totals = gates.reduce(
    (acc, g) => ({
      failRuns: acc.failRuns + g.failRuns,
      corrections: acc.corrections + g.corrections,
      falsePositives: acc.falsePositives + g.falsePositives,
      openFailRuns: acc.openFailRuns + g.openFailRuns,
    }),
    { failRuns: 0, corrections: 0, falsePositives: 0, openFailRuns: 0 },
  )
  const totalRate = (numerator: number): number | null =>
    totals.failRuns === 0 ? null : numerator / totals.failRuns
  return {
    gates,
    totals: { ...totals, closureRate: totalRate(totals.corrections), fpRate: totalRate(totals.falsePositives) },
  }
}

// ============================================================================
// §GAP-91 三权分立单章编排（ainovel Architect→Writer→Editor 模式吸收）
//
// 落点说明：本容器初版误放在 chapter-pipeline.ts，触发循环导入
// （pipeline→dim-adapter→context-engine→…→chapter-ingest→pipeline，
// createChapterPipeline 初始化失效）。repair-loop 零生产反向依赖
// （仅 index.ts barrel 引用），单向拉重型链无循环 —— 安全容器。
//
// #88/#89/#90 已把三权机制件全部代码化（散落各模块）：
//   Architect（规划）：章节契约 parse（写前约束）+ story-compass 指南针 +
//     director-pipeline 五阶段门（开书级）；
//   Writer（执行）：checkChapterContract 写后核对 + recentCast 配角回读；
//   Editor（裁定）：dimensionResultsToReviewResults（举证硬门内嵌）+
//     deriveScoreVerdict（模型只打分不判刑）+ minimalReworkSet（授权边界）。
// 本容器只做显式三阶段串联（plan → draft → review → done | rework → draft），
// 不新增机制：三阶段判定全部委托上述已有纯函数。
//
// 状态机语义（ainovel writer.md/editor.md 执行协议收缩态）：
//   plan：契约就绪判定（contract 缺失 = 如实标记无契约约束，不阻断 —— #88）；
//   draft：写后核对（forbidden 禁区 error 阻断返工，其余 warning 只告警 —— #88）；
//   review：editor 裁定（error 级 finding 或非空最小返工集 → rework；
//     举证硬门已在 dimensionResultsToReviewResults 内执行 —— #88-03）；
//   rework 上限 TRIAD_MAX_REWORK=2（ainovel arbiter 干预前两轮自修语义），
//     超限 → handoff 人工（不 stranded 静默）。
// 纯函数，零 LLM / 零 IO。
// ============================================================================

/** 三权阶段。 */
export type ChapterTriadPhase = "plan" | "draft" | "review" | "done" | "handoff";

/** 自修返工上限（ainovel arbiter 干预前两轮自修）。 */
export const TRIAD_MAX_REWORK = 2;

export interface ChapterTriadState {
  phase: ChapterTriadPhase;
  /** 已用返工轮次（review → draft 回跳计数）。 */
  reworkCount: number;
  /** 当前最小返工集（review 裁定产出，done 时为空）。 */
  reworkChapters: number[];
  /** 阻断/返工原因（人类可读，handoff 时必填）。 */
  reason: string;
}

export interface ChapterTriadReviewInput {
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>;
  issues: DimensionReviewIssue[];
  chapterBody?: string;
}

export function createChapterTriadState(): ChapterTriadState {
  return { phase: "plan", reworkCount: 0, reworkChapters: [], reason: "" };
}

/** plan 阶段：契约就绪判定（只读 taskBrief，不阻断）。 */
export function triadPlanGate(taskBrief: string): { contract: ChapterContractSection | null; ready: boolean; reason: string } {
  const contract = parseChapterContractSection(taskBrief);
  if (!contract) return { contract, ready: true, reason: "无章节契约：无契约约束写作（如实标记）" };
  return { contract, ready: true, reason: "章节契约就绪：写前约束已携带" };
}

/** draft 阶段：写后核对（禁区 error → 返工；其余只告警）。 */
export function triadDraftGate(
  contract: ChapterContractSection | null,
  chapterBody: string,
): { blocked: boolean; findings: NovelReviewResult[] } {
  if (!contract) return { blocked: false, findings: [] };
  // DEBT-89b 联动：过渡章自声明由契约段透传（与 applyChapterContractCheck 同语义）。
  const { findings } = checkChapterContract(contract, chapterBody, { transitional: contract.transitional });
  return { blocked: findings.some((f) => f.severity === "error"), findings };
}

/** review 阶段：editor 裁定（fold 结果 error 或最小返工集非空 → 返工）。 */
export function triadReviewGate(input: ChapterTriadReviewInput): { rework: boolean; findings: NovelReviewResult[]; reworkChapters: number[] } {
  // §GAP-88-03 举证硬门内嵌于 fold（有 chapterBody 时无举证 issue 被丢弃+扣分）。
  const findings = dimensionResultsToReviewResults(input.dimensionResults, input.chapterBody);
  const reworkChapters = minimalReworkSetFromDimensionIssues(input.issues);
  const rework = findings.some((f) => f.severity === "error") || reworkChapters.length > 0;
  return { rework, findings, reworkChapters };
}

/**
 * 三权状态机推进（确定性，同输入同输出）：
 *   plan → draft（恒推进，reason 记录契约状态）；
 *   draft → review（禁区阻断时记 reworkCount+1 回 draft，超限 handoff）；
 *   review → done（无返工）| draft（返工+1）| handoff（超限）。
 */
export function advanceChapterTriad(
  state: ChapterTriadState,
  gate: { blocked?: boolean; rework?: boolean; reworkChapters?: number[]; reason: string },
): ChapterTriadState {
  if (state.phase === "plan") {
    return { ...state, phase: "draft", reason: gate.reason };
  }
  if (state.phase === "draft") {
    if (!gate.blocked) return { ...state, phase: "review", reason: gate.reason };
    const reworkCount = state.reworkCount + 1;
    if (reworkCount > TRIAD_MAX_REWORK) {
      return { ...state, phase: "handoff", reworkCount, reason: gate.reason };
    }
    return { ...state, phase: "draft", reworkCount, reason: gate.reason };
  }
  if (state.phase === "review") {
    if (!gate.rework) {
      return { ...state, phase: "done", reworkChapters: [], reason: gate.reason };
    }
    const reworkCount = state.reworkCount + 1;
    if (reworkCount > TRIAD_MAX_REWORK) {
      return { ...state, phase: "handoff", reworkCount, reworkChapters: gate.reworkChapters ?? [], reason: gate.reason };
    }
    return { ...state, phase: "draft", reworkCount, reworkChapters: gate.reworkChapters ?? [], reason: gate.reason };
  }
  return state;
}