// Canon IPC 适配层（T18a / F-01）。
//
// 当前直连 `canon_query_batch`（T13，src-tauri/src/canon_commands.rs）。
// T14 落地 `canon-graph-client` 后，可把本文件实现替换为该 client 的调用，
// 组件层（canon-editor.tsx）无需改动——本文件即是唯一的 IPC 缝合点。
//
// 嵌套 filter 字段保持 snake_case（与 Rust serde 结构体字段一致），
// 仅顶层 invoke 参数名使用 camelCase（Tauri 自动转换为 Rust 的 project_id）。

import { invoke } from "@tauri-apps/api/core"
import type { CanonEdgeFilter, CanonQueryBatchResponse } from "./canon-types"

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
