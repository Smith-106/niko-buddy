/**
 * gate-run-authority.ts — 账本层**唯一**权威口径过滤器（防污染单一真源）。
 *
 * ## 为什么单独成模块
 * `gate-run` 事件有两种来源：正式章运行（写/续写/重写/润色/断点续写）与
 * 「草稿复核」类动作（主控重跑门控 `intent:main-control-rerun`）。两者都落同一本
 * 账（可审计、可回读），但只有前者是**权威结论**。若消费方各写各的字符串比较，
 * 就会出现「一半消费方过滤了、另一半没过滤」——未采纳草稿的重跑结论于是漏进
 * 阻塞队列/证据卡时间戳/闭环率等派生面（「结论丢失」换成「结论污染」）。
 *
 * 因此本模块是权威判据的**唯一实现**：
 *   - 意图解析：`readGateRunIntent`（evidenceRefs 里的 `intent:<name>`）；
 *   - 排除注册表：`NON_AUTHORITATIVE_GATE_RUN_INTENTS`（新增草稿类意图只登记这里）；
 *   - 判据：`isAuthoritativeGateRun`（单事件）；
 *   - 账本视图：`selectAuthoritativeEvents` / `toAuthoritativeLedger`（整本）。
 *
 * ## 依赖方向（为何不形成循环依赖）
 * 本模块**只**依赖 `./run-event-ledger`（账本原语：类型 + schema 版本常量），
 * 不依赖 `dashboard-evidence` / `evidence-snapshot` / `deep-chapter-gate-evidence`，
 * 也不依赖落盘层（run-event-ledger-store）。因此任何消费方（首页派生、快照、
 * 导演跟进、修正闭环、重试差分、回读 UI）都可以单向引用它，不存在回边。
 * `deep-chapter-gate-evidence` 转出这些符号，保持既有公开面不破。
 *
 * ## 过滤语义
 * 「权威账本视图」= 剔除命中排除表的 gate-run 事件，**其余事件（含 seq 顺序、
 * stage/retry/generate 等）原样保留**：账本仍是 append-only 全序，只是结论派生
 * 不看草稿复核那几条。成本归因等「真实花费」口径不应过滤（花钱是真花的）。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

import {
  RUN_EVENT_LEDGER_SCHEMA_VERSION,
  type RunEvent,
  type RunEventLedger,
} from "./run-event-ledger"

/** evidenceRefs 中的意图 ref 前缀（写入见 buildChapterGateRunEvents；`intent:<name>`）。 */
export const GATE_RUN_INTENT_REF_PREFIX = "intent:"

/** 主控「重跑门控」意图：草稿复核，不是正式章运行，不参与权威口径。 */
export const MAIN_CONTROL_RERUN_INTENT = "main-control-rerun"

/**
 * 非权威 gate-run 意图注册表（唯一扩展点）：命中的事件仍留在账本（可审计/可回读），
 * 但不参与任何权威结论派生（首页三门/列表健康列/阻塞队列/证据卡归因/闭环率/重试差分）。
 */
export const NON_AUTHORITATIVE_GATE_RUN_INTENTS: readonly string[] = [MAIN_CONTROL_RERUN_INTENT]

/** 权威口径选项（`excludeIntents` 传入时**替换**默认注册表，便于诊断视图显式收窄）。 */
export interface GateRunAuthorityOptions {
  readonly excludeIntents?: readonly string[]
}

/** 读事件 evidenceRefs 携带的意图（`intent:xxx` → "xxx"；无 → undefined）。 */
export function readGateRunIntent(event: RunEvent): string | undefined {
  for (const ref of event.evidenceRefs ?? []) {
    if (!ref.startsWith(GATE_RUN_INTENT_REF_PREFIX)) continue
    const intent = ref.slice(GATE_RUN_INTENT_REF_PREFIX.length).trim()
    if (intent.length > 0) return intent
  }
  return undefined
}

/**
 * 该事件是否属于「权威」正式章门运行：
 *   - 非 gate-run → false（kind 谓词，stage 系事件结构性收容）；
 *   - 无 intent ref → true（正式章运行不带意图；历史账本兼容）；
 *   - 意图命中排除表（默认 NON_AUTHORITATIVE_GATE_RUN_INTENTS）→ false。
 */
export function isAuthoritativeGateRun(
  event: RunEvent,
  excludedIntents: readonly string[] = NON_AUTHORITATIVE_GATE_RUN_INTENTS,
): boolean {
  if (event.kind !== "gate-run") return false
  const intent = readGateRunIntent(event)
  if (intent === undefined) return true
  return !excludedIntents.includes(intent)
}

/**
 * 权威事件切片（账本全序保持）：只剔除「非权威意图」的 gate-run，
 * 其它 kind 的事件（stage/retry/generate/quota…）原样保留——消费方按 kind 自己收容。
 */
export function selectAuthoritativeEvents(
  ledger: RunEventLedger,
  options: GateRunAuthorityOptions = {},
): readonly RunEvent[] {
  const excludedIntents = options.excludeIntents ?? NON_AUTHORITATIVE_GATE_RUN_INTENTS
  return ledger.events.filter(
    (event) => event.kind !== "gate-run" || isAuthoritativeGateRun(event, excludedIntents),
  )
}

/**
 * 权威账本视图（可直接传给 `checkGateEventCoverage` / `checkPromptLineageCoverage`
 * / `sliceRunEvents` 等以 RunEventLedger 为入参的只读派生函数）。
 */
export function toAuthoritativeLedger(
  ledger: RunEventLedger,
  options: GateRunAuthorityOptions = {},
): RunEventLedger {
  return {
    schemaVersion: RUN_EVENT_LEDGER_SCHEMA_VERSION,
    events: selectAuthoritativeEvents(ledger, options),
  }
}
