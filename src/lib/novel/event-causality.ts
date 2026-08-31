/**
 * R-narrative-2 (27 号评估落地): EventCausality — append-only 事件日志与因果链.
 *
 * 吸收来源：underworld-graph (MIT) src/event-log.ts（JSONL append-only +
 * traceBack 沿 causedBy 回溯）+ src/types.ts EventRecord（birth/death/change
 * 三类原子事件 + invalidated/newFacts + engine/user 来源）+ 实体生命周期
 * 级联闭合（death 时关闭全部声明）。
 *
 * 27 号评估采纳优先级第二名。对 underworld-graph 实现的两点确定性增强：
 * ①traceBack 增加环检测（原版 while 链在环数据上死循环）；②级联闭合为
 * 纯函数（原版散在 processEvent 副作用中）。
 */

import type { NarrativeModality } from "./narrative-state"

export type NarrativeEventType = "birth" | "death" | "change"
export type NarrativeEventSource = "engine" | "user"

export interface NarrativeEvent {
  eventId: string
  type: NarrativeEventType
  storyTime: string
  entityId: string
  source: NarrativeEventSource
  /** 事件摘要（birth 填实体客观描述；change 填变更说明）。 */
  summary?: string
  /** 因果前驱事件 id（链式溯源）。 */
  causedBy?: string
  /** change 事件：被本事件闭合（作废）的声明 id。 */
  invalidated?: Array<{ declarationId: string }>
  /** change 事件：新产生的事实声明（与 invalidated 对应替换）。 */
  newFacts?: Array<{
    declarationId: string
    entityId: string
    property: string
    description: string
    modality: NarrativeModality
  }>
}

/**
 * 沿 causedBy 回溯因果链：从 eventId 起逐级上溯到根。
 * 增强（相对原版）：visited 集合防环——环上重复节点只记一次并截断；
 * 未知 causedBy（前驱缺失）安全终止。返回顺序：根 → 触发事件。
 * 目标事件不存在 → 空数组。
 */
export function traceCausality(events: NarrativeEvent[], eventId: string): NarrativeEvent[] {
  const byId = new Map(events.map((e) => [e.eventId, e]))
  const chain: NarrativeEvent[] = []
  const visited = new Set<string>()
  let cur = byId.get(eventId)
  while (cur && !visited.has(cur.eventId)) {
    visited.add(cur.eventId)
    chain.unshift(cur)
    cur = cur.causedBy ? byId.get(cur.causedBy) : undefined
  }
  return chain
}

/**
 * 实体死亡级联闭合：返回该实体全部未闭合声明（validTo === TEMPORAL_OPEN）
 * 的闭合结果（纯函数，不修改输入）。吸收 underworld-graph「实体生命周期
 * 级联」——知识持续语义（已闭合声明仍可被 characterView 检索）由
 * narrative-state.characterView 保证，此处只负责闭合本身。
 */
export function closeDeclarationsOnDeath(
  declarations: Array<{ declarationId: string; entityId: string; validTo: string }>,
  entityId: string,
  deathStoryTime: string,
): Array<{ declarationId: string; validTo: string }> {
  return declarations
    .filter((d) => d.entityId === entityId && d.validTo === "Infinity")
    .map((d) => ({ declarationId: d.declarationId, validTo: deathStoryTime }))
}

/** 事件日志结构校验：eventId 唯一、causedBy 指向存在事件且不成环。 */
export function validateEventLog(events: NarrativeEvent[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const e of events) {
    if (seen.has(e.eventId)) errors.push(`事件 id 重复：${e.eventId}`)
    seen.add(e.eventId)
  }
  const byId = new Map(events.map((e) => [e.eventId, e]))
  for (const e of events) {
    if (e.causedBy && !byId.has(e.causedBy)) {
      errors.push(`事件 ${e.eventId} 的 causedBy 指向不存在事件 ${e.causedBy}`)
    }
  }
  // 环检测：从每个事件出发，链上回到自身即为环
  for (const e of events) {
    const visited = new Set<string>()
    let cur: NarrativeEvent | undefined = e
    while (cur?.causedBy) {
      if (cur.causedBy === e.eventId) {
        errors.push(`因果环：${e.eventId} → … → ${e.causedBy}`)
        break
      }
      if (visited.has(cur.causedBy)) break
      visited.add(cur.causedBy)
      cur = byId.get(cur.causedBy)
    }
  }
  return errors
}

/**
 * change 事件一致性校验：invalidated 的声明 id 必须与 newFacts 声明的
 * property 覆盖一致（吸收 underworld-graph 0.2.0 strict 模式校验语义）。
 * 输入：事件 + 全量声明（用于查 property）。
 */
export function validateChangeConsistency(
  event: NarrativeEvent,
  declarations: Array<{ declarationId: string; property: string }>,
): string[] {
  if (event.type !== "change") return []
  const propById = new Map(declarations.map((d) => [d.declarationId, d.property]))
  const invalidatedProps = (event.invalidated ?? []).map((i) => {
    const p = propById.get(i.declarationId)
    return { declarationId: i.declarationId, property: p }
  })
  const errors: string[] = []
  for (const inv of invalidatedProps) {
    if (!inv.property) {
      errors.push(`事件 ${event.eventId} invalidated 引用不存在声明 ${inv.declarationId}`)
    }
  }
  // newFacts 声明的 property 应与被 invalidated 的 property 对应（同实体同 property 替换）
  for (const nf of event.newFacts ?? []) {
    const matched = invalidatedProps.some((inv) => inv.property === nf.property)
    if ((event.invalidated?.length ?? 0) > 0 && !matched) {
      errors.push(`事件 ${event.eventId} newFact property「${nf.property}」无对应 invalidated 声明`)
    }
  }
  return errors
}
