/**
 * 续写简报的确定性聚合（F-003）。
 *
 * 硬规则：
 * 1. **零 LLM**。本模块只做读取 + 结构映射，不生成任何事实。
 * 2. **每条断言必须带 `source`**（`{ kind, path, jsonPointer }`）；没有 source 的断言
 *    在类型上就无法构造，渲染层也会二次过滤（`assertSourced`）。
 * 3. **默认无写入路径**。本文件不 import 任何写入命令，也不做任何 IO —— 输入由调用方
 *    通过 `BriefingSourceBundle` 注入，输出是纯数据。写记忆补丁是调用方在用户显式确认后
 *    走既有 fs 写入命令（并被 TASK-001 的确认门拦截）。
 */

import { loadFactsFile, type FactRecord } from "../facts-store"

/** 五个确定性来源的 kind 字面量。 */
export const BRIEFING_SOURCE_KINDS = [
  "emotion-ledger",
  "foreshadowing",
  "behavior-state-machine",
  "fact-store",
  "status-projection",
] as const

export type BriefingSourceKind = (typeof BRIEFING_SOURCE_KINDS)[number]

export interface BriefingSource {
  kind: BriefingSourceKind
  /** 来源文件路径；行为状态机无存储文件，用章节文件路径。 */
  path: string
  /** RFC6901 指针，指向该断言在来源里的确切位置。 */
  jsonPointer: string
}

export type BriefingBlockKind = "emotion" | "debts" | "behavior" | "facts" | "progress"

export interface BriefingAssertion {
  id: string
  block: BriefingBlockKind
  /** 面向读者的一句话；由确定性字段拼出，不含推断。 */
  text: string
  source: BriefingSource
  /** 用于与 canon 对齐的稳定键；无对应键时为 null。 */
  claimKey: string | null
}

export interface OpenDebt {
  id: string
  name: string
  plantedChapter: number
  /** 从未回收已过去的章数（由当前章 − 播种章派生，来源可溯）。 */
  chaptersSincePlanted: number
  /** 真实 store 无 dueChapter 字段 → 恒 null，绝不臆造（见波次记录偏差）。 */
  dueChapter: number | null
  source: BriefingSource
}

export interface BriefingDigest {
  blocks: BriefingBlockKind[]
  assertions: BriefingAssertion[]
  openDebts: OpenDebt[]
  warnings: string[]
}

export interface BriefingSourceBundle {
  /** `.novel/status.json` 解析结果。 */
  status: unknown | null
  /** `.novel/emotion-ledger.json` 解析结果。 */
  emotionLedger: unknown | null
  /** `.novel/foreshadowing-tracker.json` 解析结果。 */
  foreshadowing: unknown | null
  /** `.novel/facts.json` 原始文本（交给既有 fail-loud 加载器解析）。 */
  factsRaw: string | null
  /** 行为状态机报告（派生自章节文本，无存储文件）。 */
  behavior: unknown | null
  behaviorSourcePath: string
  paths?: Partial<Record<BriefingSourceKind, string>>
}

export const BRIEFING_PATHS: Record<BriefingSourceKind, string> = {
  "emotion-ledger": ".novel/emotion-ledger.json",
  foreshadowing: ".novel/foreshadowing-tracker.json",
  "behavior-state-machine": "",
  "fact-store": ".novel/facts.json",
  "status-projection": ".novel/status.json",
}

function pathOf(bundle: BriefingSourceBundle, kind: BriefingSourceKind): string {
  return bundle.paths?.[kind] ?? BRIEFING_PATHS[kind]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * 情绪条目的人类可读摘要。字段名以候选表访问；全部未命中时原样回显并打 `UNMAPPED`
 * 标记 —— 不发明字段、不猜语义。
 */
export function formatEmotionEntry(entry: unknown): string {
  if (!isRecord(entry)) {
    return `UNMAPPED ${JSON.stringify(entry)}`
  }
  const chapter = num(entry.chapter) ?? num(entry.chapterNumber)
  const emotion = str(entry.emotion) ?? str(entry.emotionTag) ?? str(entry.tag)
  const intensity = num(entry.intensity) ?? num(entry.value) ?? num(entry.netValue)
  if (chapter === null && emotion === null && intensity === null) {
    return `UNMAPPED ${JSON.stringify(entry)}`
  }
  const parts: string[] = []
  if (chapter !== null) parts.push(`第${chapter}章`)
  if (emotion !== null) parts.push(`情绪=${emotion}`)
  if (intensity !== null) parts.push(`强度=${intensity}`)
  return parts.join(" ")
}

/** 当前章号：只认 status 里的确定性字段。 */
export function currentChapterOf(status: unknown): number | null {
  if (!isRecord(status)) return null
  return (
    num(status.currentChapter) ??
    num(status.current_chapter) ??
    num(status.chapter) ??
    null
  )
}

function emotionAssertions(bundle: BriefingSourceBundle): BriefingAssertion[] {
  const path = pathOf(bundle, "emotion-ledger")
  const store = bundle.emotionLedger
  const entries = isRecord(store) ? asArray(store.entries) : []
  return entries.map((entry, i) => ({
    id: `emotion:${i}`,
    block: "emotion" as const,
    text: `情绪曲线 ${formatEmotionEntry(entry)}`,
    source: { kind: "emotion-ledger" as const, path, jsonPointer: `/entries/${i}` },
    claimKey: null,
  }))
}

/** 未回收伏笔债务：`status !== "resolved"`，按播种章升序（越早播种越紧急）。 */
export function openDebtsOf(bundle: BriefingSourceBundle): OpenDebt[] {
  const path = pathOf(bundle, "foreshadowing")
  const store = bundle.foreshadowing
  const items = isRecord(store) ? asArray(store.items) : []
  const current = currentChapterOf(bundle.status)
  const debts: OpenDebt[] = []
  items.forEach((item, i) => {
    if (!isRecord(item)) return
    const status = str(item.status)
    if (status === "resolved") return
    const planted = num(item.plantedChapter)
    if (planted === null) return
    debts.push({
      id: str(item.id) ?? `item-${i}`,
      name: str(item.name) ?? str(item.description) ?? `item-${i}`,
      plantedChapter: planted,
      chaptersSincePlanted: current === null ? 0 : Math.max(0, current - planted),
      dueChapter: null,
      source: { kind: "foreshadowing", path, jsonPointer: `/items/${i}` },
    })
  })
  debts.sort((a, b) => a.plantedChapter - b.plantedChapter || a.id.localeCompare(b.id))
  return debts
}

function debtAssertions(debts: OpenDebt[]): BriefingAssertion[] {
  return debts.map((debt) => ({
    id: `debt:${debt.id}`,
    block: "debts" as const,
    text:
      `未回收伏笔「${debt.name}」播种于第${debt.plantedChapter}章` +
      (debt.chaptersSincePlanted > 0 ? `，已过${debt.chaptersSincePlanted}章` : ""),
    source: debt.source,
    claimKey: `foreshadowing/${debt.id}`,
  }))
}

function behaviorAssertions(bundle: BriefingSourceBundle): BriefingAssertion[] {
  const report = bundle.behavior
  if (!isRecord(report)) return []
  const anomalies = asArray(report.anomalies)
  const out: BriefingAssertion[] = []
  anomalies.forEach((anomaly, i) => {
    if (!isRecord(anomaly)) return
    const character = str(anomaly.character) ?? "?"
    const severity = str(anomaly.severity) ?? "info"
    const kind = str(anomaly.type) ?? "unknown"
    const message = str(anomaly.message) ?? ""
    out.push({
      id: `behavior:${i}`,
      block: "behavior",
      text: `行为异常 [${severity}/${kind}] ${character}: ${message}`,
      source: {
        kind: "behavior-state-machine",
        path: bundle.behaviorSourcePath,
        jsonPointer: `/anomalies/${i}`,
      },
      claimKey: `behavior/${character}`,
    })
  })
  const scores = isRecord(report.consistencyScores) ? report.consistencyScores : {}
  Object.entries(scores).forEach(([character, score], i) => {
    out.push({
      id: `behavior-score:${character}:${i}`,
      block: "behavior",
      text: `${character} 行为一致性 ${String(score)}`,
      source: {
        kind: "behavior-state-machine",
        path: bundle.behaviorSourcePath,
        jsonPointer: `/consistencyScores/${character}`,
      },
      claimKey: `behavior/${character}`,
    })
  })
  return out
}

function factAssertions(bundle: BriefingSourceBundle): BriefingAssertion[] {
  if (bundle.factsRaw === null) return []
  const path = pathOf(bundle, "fact-store")
  const file = loadFactsFile(bundle.factsRaw)
  return file.facts.map((fact: FactRecord, i) => ({
    id: `fact:${fact.id}`,
    block: "facts" as const,
    text: `事实 ${fact.subject} ${fact.predicate} ${fact.object}（第${fact.valid_at}章成立）`,
    source: { kind: "fact-store" as const, path, jsonPointer: `/facts/${i}` },
    claimKey: `fact/${fact.id}`,
  }))
}

function progressAssertions(bundle: BriefingSourceBundle): BriefingAssertion[] {
  const path = pathOf(bundle, "status-projection")
  const current = currentChapterOf(bundle.status)
  if (current === null) return []
  return [
    {
      id: "progress:current-chapter",
      block: "progress",
      text: `当前进度：第${current}章`,
      source: { kind: "status-projection", path, jsonPointer: "/currentChapter" },
      claimKey: "progress/currentChapter",
    },
  ]
}

/** 二次兜底：任何缺 source 的断言都不能进入简报。 */
export function assertSourced(assertions: BriefingAssertion[]): BriefingAssertion[] {
  return assertions.filter(
    (a) =>
      a.source !== null &&
      typeof a.source === "object" &&
      a.source.path.length > 0 &&
      a.source.jsonPointer.length > 0,
  )
}

export function buildBriefingDigest(bundle: BriefingSourceBundle): BriefingDigest {
  const warnings: string[] = []
  const debts = openDebtsOf(bundle)

  let facts: BriefingAssertion[] = []
  try {
    facts = factAssertions(bundle)
  } catch (e) {
    // facts.json schema 不匹配时既有加载器 fail-loud；简报降级为「该块缺失」而不是猜测。
    warnings.push(`fact-store unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }

  const bundles: Array<[BriefingBlockKind, BriefingAssertion[]]> = [
    ["emotion", emotionAssertions(bundle)],
    ["debts", debtAssertions(debts)],
    ["behavior", behaviorAssertions(bundle)],
    ["facts", facts],
    ["progress", progressAssertions(bundle)],
  ]

  const assertions = assertSourced(bundles.flatMap(([, list]) => list))
  const blocks = bundles.filter(([, list]) => list.length > 0).map(([kind]) => kind)

  return { blocks, assertions, openDebts: debts, warnings }
}
