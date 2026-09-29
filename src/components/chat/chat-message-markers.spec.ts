// @vitest-environment node
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// chat-message-markers.spec — F4-3（Round-3 评估）拆分产物单测：
// 隐藏标记编解码（与 chat-panel 内联实现语义一致）。

import { describe, expect, it } from "vitest"
import {
  appendContextUsageMarker,
  appendHiddenNovelSessionDebug,
  appendManagedDeepChapterDraftMarker,
  replaceManagedDeepChapterDraftMarker,
} from "./chat-message-markers"

describe("chat-message-markers (F4-3 split)", () => {
  it("appendHiddenNovelSessionDebug：可逆编码（URIComponent JSON）", () => {
    const out = appendHiddenNovelSessionDebug("hello", { a: 1 })
    expect(out.startsWith("hello\n<!-- niko-buddy-novel-session-debug:")).toBe(true)
    const payload = out.match(/debug:(.*?) -->/)![1]
    expect(JSON.parse(decodeURIComponent(payload))).toEqual({ a: 1 })
  })

  it("draft marker：append + replace 去旧换新（append-only 语义）", () => {
    const m1 = { conversationId: "c1", draftStatus: "pending" as const }
    const m2 = { conversationId: "c1", draftStatus: "accepted" as const }
    const once = appendManagedDeepChapterDraftMarker("body", m1)
    expect(once).toContain("niko-buddy-deep-chapter-draft:")
    const twice = replaceManagedDeepChapterDraftMarker(once, m2)
    // 旧标记被整体移除，只剩新标记
    expect(twice.split("niko-buddy-deep-chapter-draft:").length - 1).toBe(1)
    expect(twice).toContain(encodeURIComponent(JSON.stringify(m2)))
  })

  it("appendContextUsageMarker：undefined 原样返回", () => {
    expect(appendContextUsageMarker("x", undefined)).toBe("x")
    const out = appendContextUsageMarker("x", { ratio: 0.5 } as never)
    expect(out).toContain("niko-buddy-context-usage:")
  })

  it("循环引用 debug 对象不抛错（原样返回触发 catch 的输入）", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(appendHiddenNovelSessionDebug("c", circular)).toBe("c")
  })
})
