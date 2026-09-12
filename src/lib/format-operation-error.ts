// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 后端诊断串的用户可见包装。
//
// 背景：Rust 侧多处返回机器英文诊断（如 `MCP_NOT_CONNECTED: transport is 'stdio'`、
// `BATCH_REPLACE_GATE_REJECTED: ...`），组件里常见写法是
//   setError(err instanceof Error ? err.message : String(err))
// —— 用户直接看到英文机器串，且没有一句本地化引导。
//
// 统一为「本地化引导 + 原始诊断」：引导语缺失时诊断仍然保留（不会随键丢失一起消失），
// 诊断原文也始终可用于排查/上报。

import type { TFunction } from "i18next"

/**
 * 把任意异常渲染为用户可见的错误文案。
 *
 * @param t 组件内的翻译函数
 * @param err 捕获到的异常
 */
export function formatOperationError(t: TFunction, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return `${t("common.operationFailed", "操作失败")}：${detail}`
}
