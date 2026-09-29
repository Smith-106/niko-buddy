// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// chat-message-markers.ts — F4-3 (Round-3 评估)：chat-panel 纯字符串 helpers。
//
// 从 chat-panel.tsx（2928 行）拆出的第一个纯函数子模块：隐藏 HTML 注释标记
// 编解码（novel-session-debug / deep-chapter-draft / context-usage 三种标记）。
// 零依赖 ChatPanel（仅 type-only import ContextUsage），chat-panel 经 re-export
// 保持既有 import 面不变。

import type { ContextUsage } from "@/lib/context-usage"

export interface DeepChapterDraftMarker {
  conversationId: string
  sessionId?: string
  draftStatus: "ready" | "accepted" | "rejected" | "pending" | "superseded"
}

export function appendHiddenNovelSessionDebug(content: string, debug: Record<string, unknown>): string {
  try {
    return `${content}\n<!-- niko-buddy-novel-session-debug:${encodeURIComponent(JSON.stringify(debug))} -->`
  } catch {
    return content
  }
}

export function appendManagedDeepChapterDraftMarker(content: string, marker: DeepChapterDraftMarker): string {
  try {
    return `${content}\n<!-- niko-buddy-deep-chapter-draft:${encodeURIComponent(JSON.stringify(marker))} -->`
  } catch {
    return content
  }
}

export function replaceManagedDeepChapterDraftMarker(content: string, marker: DeepChapterDraftMarker): string {
  const withoutExisting = content.replace(/<!--\s*niko-buddy-deep-chapter-draft:[\s\S]*?\s*-->/gi, "").trimEnd()
  return appendManagedDeepChapterDraftMarker(withoutExisting, marker)
}

// Wave 5 (v2.5.0): 上下文用量标记（与 draft 标记同款编码模式）。缺省 undefined
// → 原样返回（空包降级/非 build 路径不渲染 ring）。
export function appendContextUsageMarker(
  content: string,
  usage: ContextUsage | undefined,
): string {
  if (!usage) return content
  try {
    return `${content}\n<!-- niko-buddy-context-usage:${encodeURIComponent(JSON.stringify(usage))} -->`
  } catch {
    return content
  }
}
