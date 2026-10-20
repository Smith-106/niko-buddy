// Canon IPC 适配层（T18a / F-01）。
//
// 当前直连 `canon_query_batch`（T13，src-tauri/src/canon_commands.rs）。
// T14 落地 `canon-graph-client` 后，可把本文件实现替换为该 client 的调用，
// 组件层（canon-editor.tsx）无需改动——本文件即是唯一的 IPC 缝合点。
//
// 嵌套 filter 字段保持 snake_case（与 Rust serde 结构体字段一致），
// 仅顶层 invoke 参数名使用 camelCase（Tauri 自动转换为 Rust 的 project_id）。

import { invoke } from "@tauri-apps/api/core"
import type { CanonEdgeFilter, CanonQueryBatchResponse, EdgeKind } from "./canon-types"
import { buildCanonEdgeFilter } from "@/lib/novel"

/**
 * 调用 `canon_query_batch`：一批 filter → 一批结果 + max_revision。
 *
 * 只读视图默认只发 1 个 filter（当前活动过滤），但仍走 batch 端点，
 * 以验证多查询单 invoke 的契约（与 T13 单测一致）。
 *
 * v2.8 P1-2：服务端分页随 filter 搭载（offset/limit，签名不变）；
 * 响应含 `totals`（与 results 下标对齐的过滤后全量计数）供分页器消费。
 */
export async function queryCanonBatch(
  projectId: string,
  filters: CanonEdgeFilter[],
): Promise<CanonQueryBatchResponse> {
  return invoke<CanonQueryBatchResponse>("canon_query_batch", {
    projectId,
    filters,
  })
}


/**
 * 将当前过滤输入构建为单个 CanonEdgeFilter。
 * v2.8 P1-2：委托共享构造器 buildCanonEdgeFilter（42-spec §17 P1-2 骨架接线），
 * 产物为全 null 字段对象（未提供的维不过滤）。分页 offset/limit 不在此处搭载，
 * 仅在 reload 调用点注入（避免 page → filter → 重置 page 死循环）。
 */
export function buildFilter(input: {
  knownBy: string
  validAtChapter: string
  edgeKind: EdgeKind | "all"
}): CanonEdgeFilter {
  const chapter = Number.parseInt(input.validAtChapter, 10)
  return buildCanonEdgeFilter({
    knownBy: input.knownBy.trim() || undefined,
    validAtChapter: Number.isFinite(chapter) ? chapter : undefined,
    edgeKinds: input.edgeKind === "all" ? undefined : [input.edgeKind],
  })
}

/** 解析 revealed_at 输入框文本：空白 → null（未登记）；非法整数 → NaN。 */
export function parseChapterInput(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return Number.parseInt(trimmed, 10)
}
