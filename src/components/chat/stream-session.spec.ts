import { describe, expect, it, vi } from "vitest"
import { createStreamSessionGuard } from "./stream-session"

describe("createStreamSessionGuard", () => {
  it("finalizes immediately on stop and ignores late stream callbacks", () => {
    const guard = createStreamSessionGuard()
    const conversationId = "conv-1"
    const sessionId = guard.start(conversationId)
    const finalize = vi.fn()

    guard.stop(conversationId, sessionId, () => finalize("已停止生成。"))
    guard.runIfActive(conversationId, sessionId, () => finalize("迟到的模型输出"))

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith("已停止生成。")
  })

  it("starts per-conversation counters that never invalidate each other", () => {
    const guard = createStreamSessionGuard()
    expect(guard.start("a")).toBe(1)
    expect(guard.start("a")).toBe(2)
    expect(guard.start("b")).toBe(1)
    // A 会话的 start 不影响 B 会话
    expect(guard.isActive("a", 2)).toBe(true)
    expect(guard.isActive("a", 1)).toBe(false)
    expect(guard.isActive("b", 1)).toBe(true)
    // 未启动会话的 fallback 计数为 0，sessionId 0 视为活跃（?? 分支）
    expect(guard.isActive("c", 0)).toBe(true)
    expect(guard.isActive("c", 1)).toBe(false)
  })

  it("runIfActive executes only while the session is the latest one", () => {
    const guard = createStreamSessionGuard()
    const conv = "conv-run"
    const current = guard.start(conv)
    const stale = current - 1
    const cb = vi.fn()

    guard.runIfActive(conv, current, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    guard.runIfActive(conv, stale, cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("finish runs the callback and advances the session only for the active session", () => {
    const guard = createStreamSessionGuard()
    const conv = "conv-fin"
    const sessionId = guard.start(conv)
    const fin = vi.fn()

    guard.finish(conv, sessionId, fin)
    expect(fin).toHaveBeenCalledTimes(1)
    expect(guard.isActive(conv, sessionId)).toBe(false)

    // 过期 session 的 finish 被忽略
    const staleFin = vi.fn()
    guard.finish(conv, sessionId, staleFin)
    expect(staleFin).not.toHaveBeenCalled()
  })

  it("finish on a never-started conversation with sessionId 0 hits the ?? fallback", () => {
    const guard = createStreamSessionGuard()
    const cb = vi.fn()
    // sessionId 0 === getCounter(未启动会话)=0 → isActive true → 执行回调并推进
    guard.finish("fresh", 0, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(guard.isActive("fresh", 0)).toBe(false)
  })
})
