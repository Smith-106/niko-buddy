/**
 * sync-kb-view-to-qmai.mjs 的最小类型声明（供 vitest 规格与 IDE 引用；
 * 实现真源为同名 .mjs，P1-IMP-08 KB-VIEW 消费面同步脚本）。
 */

/** collections / byQueryIntent 的条目投影（content 类大字段永不入包）。 */
export interface KbViewEntry {
  collection?: string
  name?: string
  trust?: string
  title?: string
  query_intent?: string[]
  [key: string]: unknown
}

/** 抽取后的最小消费面（search-adapter 静态 import 的形状）。 */
export interface KbRoutingView {
  _generated: string
  schemaVersion: number
  builtFrom: string
  routing: { agent: Record<string, string[]> }
  collectionCounts: Record<string, number>
  byQueryIntent: Record<string, KbViewEntry[]>
  collections: Record<string, KbViewEntry[]>
}

/** 源视图（hub reference/REFERENCE-KB-VIEW.json）的消费相关子集。 */
export interface KbViewSourceLike {
  schemaVersion?: number
  builtFrom?: string
  routing?: { agent?: Record<string, string[]>; eng?: Record<string, string[]> }
  collections?: Record<string, KbViewEntry[]>
  counts?: Record<string, number>
  byQueryIntent?: Record<string, KbViewEntry[]>
  [key: string]: unknown
}

/**
 * 源视图 → 最小消费面。缺 builtFrom / routing.agent / collections，或 counts 与
 * collections.length 漂移时抛错（不产出不可信消费面）。
 */
export declare function extractConsumerSurface(
  source: KbViewSourceLike,
  sourceLabel?: string,
): KbRoutingView

/** 产物序列化口径（写盘与 --check 比对共用，保证逐字节可比）。 */
export declare function serialize(view: KbRoutingView): string
