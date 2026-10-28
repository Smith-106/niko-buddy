import { describe, expect, it } from "vitest"
import { isSameSessionBase } from "./novel-status-construction"

/**
 * ISS-20260709-008（PAT-G7）：写入路径「同会话基底」判定的语义锁定。
 * 关键区分：session_id 缺失是 missing-as-different（不得当作 same-session 复用），
 * 不是 missing-as-skip。此前 5 处裸 `existing.session_id === id` 各自手写，
 * 这条 spec 防止有人再把它简化成 `!existing.session_id || ...` 之类的宽松判定。
 */
describe("isSameSessionBase", () => {
  it("null 既有状态 → false", () => {
    expect(isSameSessionBase(null, "session-a")).toBe(false)
  })

  it("session_id 缺失（legacy 草稿/状态）→ false，不能当同会话复用", () => {
    expect(isSameSessionBase({}, "session-a")).toBe(false)
    expect(isSameSessionBase({ session_id: undefined }, "session-a")).toBe(false)
  })

  it("不同 session_id → false", () => {
    expect(isSameSessionBase({ session_id: "session-b" }, "session-a")).toBe(false)
  })

  it("同一 session_id → true", () => {
    expect(isSameSessionBase({ session_id: "session-a" }, "session-a")).toBe(true)
  })

  it("泛型同时覆盖 status 与 draft artifact 形状（都只有可选 session_id 要求）", () => {
    const draftLike = { session_id: "s1", draft_status: "ready" as const }
    expect(isSameSessionBase(draftLike, "s1")).toBe(true)
    expect(isSameSessionBase(draftLike, "s2")).toBe(false)
  })
})
