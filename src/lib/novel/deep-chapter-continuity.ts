/**
 * deep-chapter-continuity — 连贯性预检/临界检测子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的独立 async 函数：runContinuityPreCheck/
 * checkContinuityCritical + 纯函数 buildPlotForecastHint。主文件只做编排——
 * 连贯性检测逻辑独立可测，不再埋在编排体里。
 */

import { loadContinuityOverrides } from "./continuity-overrides-store"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadSubplotBoard } from "./subplot-board"
import { loadCharacterStates } from "./character-state"
import {
  checkContinuity,
  buildReadonlyStoreFromInput,
  DEFAULT_CONTINUITY_CONFIG,
  summarizeContinuityFindings,
  formatContinuityFindingsForPrompt,
  type ContinuityInput,
  type ContinuityFinding,
  type ContinuityOverrideStore,
} from "./deterministic-continuity-engine"
import { forecastBranches } from "./plot-forecast"
import { collectContinuityMetric } from "@/lib/llm-client"
import { runAuditTriadPreflight, type NovelReviewResult } from "./review-adapter"
import { logger } from "@/lib/utils"

export async function runContinuityPreCheck(
  projectPath: string,
  currentChapter: number | undefined,
): Promise<string> {
  const startMs = Date.now()
  try {
    const chapterNum = currentChapter ?? 0
    const [foreshadowingStore, subplotStore, characterStore] = await Promise.all([
      loadForeshadowingTracker(projectPath)/* v8 ignore start */ /* v8 ignore stop */.catch(() => ({ items: [], lastUpdated: "" })),
      loadSubplotBoard(projectPath)/* v8 ignore start */ /* v8 ignore stop */.catch(() => ({ items: [], lastUpdated: "" })),
      loadCharacterStates(projectPath).catch(() => ({ characters: [], lastUpdated: "" })),
    ])
    const continuityInput: ContinuityInput = {
      foreshadowing: foreshadowingStore.items,
      subplots: subplotStore.items,
      characters: characterStore.characters,
      snapshots: [],
      currentChapter: chapterNum,
    }
    // G3 override 写入端接线 (AC-006.5): loadContinuityOverrides try/catch 降级, 失败
    // 返 undefined 走 rawFindings 不阻断 (守 fold_rebuildable)。生成层不双跑
    // (不关心 overrides_hit metric, Decision 5)。overrideStore 仅传非空。
    let overrideStore: ContinuityOverrideStore | undefined
    try {
      const loaded = await loadContinuityOverrides(projectPath)
      overrideStore = loaded.overrides.length > 0 ? loaded : undefined
    } catch (err) {
      logger.warn(
        "continuity-engine",
        `override store load degraded: ${err instanceof Error ? err.message : String(err)}`,
      )
      overrideStore = undefined
    }
    const findings: ContinuityFinding[] = checkContinuity(
      buildReadonlyStoreFromInput(continuityInput),
      DEFAULT_CONTINUITY_CONFIG,
      overrideStore,
    )
    const summary = summarizeContinuityFindings(findings)
    // ADR-30: 3 级 severity (critical/warning/info) — blueprint 对齐 (非 4 级无 high)。
    // 生成层预检注入 critical+warning 提醒级 (非阻断守 Draft-first)。
    // warning 级 = dormant_thread/absent_character/unresolved_foreshadowing (3 级方案)。
    // data_gap (info) 不注入 (仅可见标注)。
    // TASK-010 (Decision 7.2): continuity 观测层 metric — 生成层预检 gate=consistency,
    // 只记 count+ms (CWE-532)。short_circuit_hits=0 (预检非阻断不短路 LLM)。
    // high_count=0 (3 级方案无 high, dormant/absent/unresolved 归 warning)。
    // overrides_hit=0 (生成层不双跑, 不关心 override metric, Decision 5)。
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: summary.critical,
      high_count: 0,
      warning_count: summary.warning,
      data_gap_count: summary.data_gap,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 0,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    // 64 号实施接线（plot-forecast 消费）：写章前对未回收支线做并发/逾期
    // 预检（确定性零 LLM）。error 级风险追加到注入文本（仅提示，非阻断，
    // 守 Draft-first）；无风险不产生输出。
    const forecastText = buildPlotForecastHint(subplotStore, chapterNum)
    const base = formatContinuityFindingsForPrompt(findings, { includeChapter: false })
    return forecastText ? [base, forecastText].filter(Boolean).join("\n\n") : base
  } catch (err) {
    logger.warn("continuity-engine", "precheck degraded: " + (err as Error).message)
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: 0,
      high_count: 0,
      warning_count: 0,
      data_gap_count: 0,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 1,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    return ""
  }
}
export async function checkContinuityCritical(
  projectPath: string,
  currentChapter: number | undefined,
  chapterText?: string,
): Promise<{ tripped: boolean; reason: string }> {
  const startMs = Date.now()
  try {
    const chapterNum = currentChapter ?? 0
    const [foreshadowingStore, subplotStore, characterStore] = await Promise.all([
      loadForeshadowingTracker(projectPath)/* v8 ignore start */ /* v8 ignore stop */.catch(() => ({ items: [], lastUpdated: "" })),
      loadSubplotBoard(projectPath)/* v8 ignore start */ /* v8 ignore stop */.catch(() => ({ items: [], lastUpdated: "" })),
      loadCharacterStates(projectPath).catch(() => ({ characters: [], lastUpdated: "" })),
    ])
    const continuityInput: ContinuityInput = {
      foreshadowing: foreshadowingStore.items,
      subplots: subplotStore.items,
      characters: characterStore.characters,
      snapshots: [],
      currentChapter: chapterNum,
    }
    // G3 override 写入端接线 (AC-006.5): loadContinuityOverrides try/catch 降级, 失败
    // 返 undefined 走 rawFindings 不阻断 (守 fold_rebuildable)。生成层不双跑
    // (不关心 overrides_hit metric, Decision 5)。overrideStore 仅传非空。
    let overrideStore: ContinuityOverrideStore | undefined
    try {
      const loaded = await loadContinuityOverrides(projectPath)
      overrideStore = loaded.overrides.length > 0 ? loaded : undefined
    } catch (err) {
      logger.warn(
        "continuity-engine",
        `override store load degraded: ${err instanceof Error ? err.message : String(err)}`,
      )
      overrideStore = undefined
    }
    const findings: ContinuityFinding[] = checkContinuity(
      buildReadonlyStoreFromInput(continuityInput),
      DEFAULT_CONTINUITY_CONFIG,
      overrideStore,
    )
    const summary = summarizeContinuityFindings(findings)
    const critical = findings.filter(
      (f) => f.severity === "critical" && f.subtype === "consistency_mechanical",
    )
    // E-04 (C-8 生成侧为辅): 审计三口诀 critical 并入 — 复用审查侧预检 (含 JSONL
    // 落盘幂等), 正文在场实体提取 + 证据分级; critical → error 并入 tripped 判定,
    // manualHandoff 语义不变 (机械 critical 不进 fix-loop LLM 重写)。
    let auditCritical: NovelReviewResult[] = []
    try {
      auditCritical = await runAuditTriadPreflight(projectPath, chapterNum, { chapterText })
        .then((rs) => rs.filter((r) => r.severity === "error"))
    } catch {
      auditCritical = []
    }
    // TASK-010 (Decision 7.2): critical 分流 metric — short_circuit_hits=tripped 数
    // (机械 critical 短路 LLM fix-loop, 走 manualHandoff 非 LLM 重写)。
    // high_count=0 (3 级方案无 high, ADR-30 blueprint 对齐)。
    // overrides_hit=0 (生成层不双跑, 不关心 override metric, Decision 5)。
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: summary.critical,
      high_count: 0,
      warning_count: summary.warning,
      data_gap_count: summary.data_gap,
      overrides_hit: 0,
      short_circuit_hits: critical.length,
      engine_error_count: 0,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    if (critical.length === 0 && auditCritical.length === 0) {
      return { tripped: false, reason: "" }
    }
    const list = [
      ...critical.map((f) => `${f.ref}(${f.type})`),
      ...auditCritical.map((r) => `${r.continuityMeta?.ref ?? r.message}(${r.type})`),
    ].join(", ")
    return {
      tripped: true,
      reason: `连续性机械 critical: ${list} (死亡角色活跃态/伏笔逾期未回收/信息边界泄露, 走人工处理避免 fix-loop LLM 重写加深不一致)`,
    }
  } catch (err) {
    logger.warn("continuity-engine", "critical check degraded: " + (err as Error).message)
    collectContinuityMetric({
      execution_ms: Date.now() - startMs,
      critical_count: 0,
      high_count: 0,
      warning_count: 0,
      data_gap_count: 0,
      overrides_hit: 0,
      short_circuit_hits: 0,
      engine_error_count: 1,
      gate: "consistency",
      timestamp: new Date().toISOString(),
    })
    return { tripped: false, reason: "" }
  }
}
export function buildPlotForecastHint(
  subplotStore: { items: { id: string; title: string; status: string; abandoned?: boolean; targetResolutionChapter?: number }[] },
  currentChapter: number,
): string {
  if (!subplotStore.items || subplotStore.items.length === 0) return ""
  const branches = subplotStore.items
    .filter((s) => s.status !== "resolved" && s.status !== "done" && !s.abandoned)
    .map((s) => ({
      id: s.id,
      subplotId: s.id,
      direction: `推进支线「${s.title}」`,
      projectedChapter: s.targetResolutionChapter ?? currentChapter + 2,
    }))
  if (branches.length === 0) return ""
  const results = forecastBranches(
    { items: subplotStore.items as never, lastUpdated: "" },
    branches,
  )
  const errors = results.flatMap((r) =>
    r.risks.filter((risk) => risk.severity === "error").map((risk) => `- [支线预检] ${risk.message}`),
  )
  return errors.length > 0 ? `## 支线推进预检\n${errors.join("\n")}` : ""
}
