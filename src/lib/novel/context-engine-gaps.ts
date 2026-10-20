/**
 * context-engine-gaps.ts — 上下文分层/预算裁剪 + gap 契约 + 降级分级日志
 *（纯搬迁，零逻辑变更）
 *
 * 从 context-engine.ts 抽出（P1 巨文件拆分，swarm ts-bloat-20261017 裁决）。
 * 承载 SECTION_PRIORITY / CHAPTER_OUTLINE_PROTECTED_CAP / tieredSlice /
 * IC-02 gap 契约状态（contextGaps + 激活开关）/ build-scoped mutex /
 * build 预算持有 / 降级分级日志 logDegradation。
 */
import { logger, toErrorMessage } from "@/lib/utils"
import { classifyKbError, recoveryPlanFor } from "./kb-observability"
import type { ContextGapReason } from "./context-data-source"
import type { ContextBudget } from "@/lib/context-budget"

export const SECTION_PRIORITY: Record<string, number> = {
  "当前任务": 1,
  "当前章节目标": 2,
  "项目灵魂": 3,
  "大纲要求": 4,
  "禁止违背": 5,
  // E-02 (GLM 建议 5.5): 硬注入事实介于「禁止违背」与「最近剧情摘要」之间 —
  // 恒真 canon/过程库投影，先于软性检索摘要呈现。
  "硬注入事实": 5.5,
  "最近剧情摘要": 6,
  "上一章结尾": 7,
  "当前人物状态": 8,
  "角色灵魂": 9,
  "当前伏笔状态": 10,
  "时间线": 11,
  "角色认知状态": 12,
  "相关地点/组织/物品": 13,
  "相关记忆检索": 14,
  "引用检索": 14.5,
  "修改反馈": 15,
  "下一章推进建议": 16,
  "写作风格": 17,
  "语音风格指南": 17.5,
  "曾成立的事实（已失效，仅供人物误信/发现变化/回忆对照，禁止作为当前叙述事实）": 18,
  // P2-IMP-10 (M2): stateDelta 键控子表紧随「最近剧情摘要」呈现（6 → 6.1）。
  "最近章节状态变更": 6.1,
  // P1-IMP-13 (A1a): 素材引用绑定紧随「引用检索」呈现（14.5 → 14.6）。
  "素材引用绑定": 14.6,
}

/**
 * Tier caps (TASK-003 protected/compressible layering).
 *
 * Protected sources carry load-bearing constraints for the current chapter
 * and get a generous cap — they SHOULD survive whole into the prompt.
 * Canon rules in particular are never compressed, only truncated as a last
 * resort with a `budget_exceeded` gap.
 *
 * Compressible sources are budget-elastic; they're truncated under pressure
 * with a `tier_compressible` gap and are candidates for community-summary
 * compression (TASK-003 subtask 3) before injection.
 */
export const CHAPTER_OUTLINE_PROTECTED_CAP = 6000

/**
 * ANL-013 S4 (TASK-003): protected/compressible context tiering.
 *
 * Context sources are classified into two tiers:
 *   - `protected`: canon facts / character cognition (knows + doesNotKnow) /
 *     current chapter outline / active foreshadowing. These MUST NOT be
 *     silently compressed — they carry load-bearing constraints. Truncation
 *     (only when a single source file vastly exceeds the cap) is recorded
 *     as a gap with reason `budget_exceeded`.
 *   - `compressible`: historical chapter summaries / community summaries /
 *     older snapshots / derived fallback state. These are budget-elastic —
 *     truncated under budget pressure and the compression is recorded as a
 *     gap with reason `tier_compressible`.
 *
 * `gaps[]` is the IC-02 contract: every compression / truncation MUST be
 * surfaced explicitly, never silently degraded. Callers (and tests) can
 * inspect `pack.gaps` to verify no source was silently dropped.
 */
export type SourceTier = "protected" | "compressible"

export interface ContextGap {
  type: "compressed" | "truncated" | "load_failed"
  ref: string
  reason: ContextGapReason
  originalLength: number
  retainedLength: number
}

/**
 * Module-level gap recorder.
 *
 * The per-source data sources in `context-data-sources.ts` record gaps when
 * they compress/truncate their payload (tieredSlice reports into this
 * buffer). `buildContextPack` resets the buffer before loading data sources
 * and collects the recorded gaps after. The lifecycle is exactly one
 * `buildContextPack` call — the buffer is per-build, not global-persistent.
 *
 * DC-8 (odyssey-improve): `recordDatasourceLoadFailure` is exported so data
 * sources can record a `load_failed` gap when their load throws (previously
 * the `catch {}` swallowed the error silently, violating the IC-02 contract
 * that every context truncation/omission be visible in pack.gaps). The
 * helper is guarded by `contextGapsActive` so it is a no-op outside a build.
 */
export const contextGaps: ContextGap[] = []
let contextGapsActive = false

/**
 * ISS-20260709-029 (F-003) 短期缓解: build-scoped mutex 串行化 buildContextPack
 * 调用。消除跨调用 interleave race——两并发 buildContextPack 在 await
 * registry.loadAll 让出事件循环后交错，致 gaps 串包 + budget 错配。模块级
 * Promise 链把所有 buildContextPack 调用排队串行执行，牺牲并发换正确性。
 * 保留现有 try/finally（单次内泄漏已修 PAT-M2/DC-6），mutex 防的是跨调用层级。
 * 触发需特定并发时序（生成+审查同进程交错），单用户桌面串行为主，mutex 是
 * 保险。fix_direction 标注的完整 build-scoped BuildContext 对象重构（6+
 * 函数签名改动）归 Stage 3/4 稳定化推进。
 */
export let buildMutex: Promise<unknown> = Promise.resolve()

export function resetContextGaps(): void {
  contextGaps.length = 0
  contextGapsActive = true
}

export function collectContextGaps(): ContextGap[] {
  contextGapsActive = false
  return [...contextGaps]
}

/**
 * DC-8 (odyssey-improve): record a `load_failed` gap for a data source whose
 * `load()` threw. Exposed to buildContextPack via the `recordGap` callback on
 * ContextLoadContext (injected into the context object), so data sources in
 * context-data-sources.ts can record failures without importing context-engine
 * (avoids the circular dependency). No-op outside an active build.
 */
export function recordDatasourceLoadFailure(ref: string, reason: ContextGapReason = "datasource_error"): void {
  if (!contextGapsActive) return
  contextGaps.push({
    type: "load_failed",
    ref,
    reason,
    originalLength: 0,
    retainedLength: 0,
  })
}

/**
 * PERF-011 (TASK-007): module-level build-scoped budget.
 *
 * The `chapterOutlineDataSource` runs during `registry.loadAll` — BEFORE
 * `buildContextPackFromRawData`. So the tieredSlice caps in
 * `readChapterOutlineContent` / `pickChapterOutlineByNumber` can't read the
 * budget off `context` directly (the budget is computed in `buildContextPack`,
 * not threaded through the DataSource load contract). We mirror the existing
 * `contextGaps` module-level pattern: `buildContextPack` populates this before
 * loading data sources and clears it after; the tieredSlice call sites read it
 * to drive adaptive caps. Lifecycle is exactly one `buildContextPack` call,
 * matching `contextGaps` — never global-persistent.
 *
 * `null` (outside a build, or when `computeContextBudget` wasn't called)
 * falls back to the legacy `CHAPTER_OUTLINE_PROTECTED_CAP` constant so every
 * existing caller that doesn't go through `buildContextPack` (tests, direct
 * `readChapterOutlineContent` invocations) keeps the original static behavior.
 */
export let currentBuildBudget: ContextBudget | null = null

/**
 * Tier-aware slice. Replaces the bare `content.slice(0, N)` calls that
 * previously truncated sources indiscriminately.
 *
 * - `protected` tier: cap is generous (the source SHOULD survive whole).
 *   If the source still exceeds the cap, record a `truncated` gap with
 *   reason `budget_exceeded` and return the prefix. We never route
 *   protected sources through community-summary compression.
 * - `compressible` tier: cap is tighter; when the source exceeds it,
 *   record a `truncated` gap with reason `tier_compressible`. The
 *   community-summary integration (TASK-003 subtask 3) consumes
 *   compressible-tier sources for summarization before injection.
 */
export function tieredSlice(
  content: string,
  tier: SourceTier,
  cap: number,
  ref: string,
): string {
  if (!content) return ""
  const originalLength = content.length
  if (originalLength <= cap) return content
  const retained = content.slice(0, cap)
  if (contextGapsActive) {
    contextGaps.push({
      type: "truncated",
      ref,
      reason: tier === "protected" ? "budget_exceeded" : "tier_compressible", /* v8 ignore start */ /* v8 ignore stop */
      originalLength,
      retainedLength: retained.length,
    })
  }
  return retained
}




/**
 * P1-IMP-13 (A1a 前移子集): 检索/注入降级路径统一分级记录 —
 * 裸 logger.warn 升级为 classifyKbError + recoveryPlanFor 分级日志
 * （GOV-OBS-04：DISASTER / DEGRADED / RECOVERABLE / CONTROLLED）。
 * 降级不改变既有恢复语义（各 catch 块原本的降级动作一字不动），
 * 仅在日志侧补充分级字段（class / eventType / recovery / terminal）供观测消费。
 */
export function logDegradation(
  message: string,
  error: unknown,
  ctx: Parameters<typeof classifyKbError>[1] = {},
): void {
  const cls = classifyKbError(error, ctx)
  const plan = recoveryPlanFor(cls)
  logger.warn("ContextEngine", message, {
    error: toErrorMessage(error),
    class: cls,
    eventType: plan.eventType,
    recovery: plan.action,
    terminal: plan.terminal,
  })
}

/** 设置当前 build 预算（原 context-engine 内联赋值；跨模块写入的唯一入口）。 */
export function setCurrentBuildBudget(v: ContextBudget | null): void {
  currentBuildBudget = v
}

/** 续接 build mutex（原内联赋值；跨模块写入的唯一入口）。 */
export function setBuildMutex(next: Promise<unknown>): void {
  buildMutex = next
}

/** gap 采集开关读写（原内联赋值；跨模块访问的唯一入口）。 */
export function setContextGapsActive(v: boolean): void {
  contextGapsActive = v
}

export function getContextGapsActive(): boolean {
  return contextGapsActive
}
