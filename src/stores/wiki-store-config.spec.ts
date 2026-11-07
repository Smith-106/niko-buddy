// @vitest-environment jsdom
// wiki-store-config：放弃未保存草稿的确认门（jsdom 下 window.confirm 存在）。
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmDiscardSkillLibraryDraft } from "./wiki-store-config"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("confirmDiscardSkillLibraryDraft", () => {
  it("window.confirm 可用 → 返回用户选择", () => {
    const confirmMock = vi.fn(() => false)
    vi.stubGlobal("confirm", confirmMock)
    expect(confirmDiscardSkillLibraryDraft()).toBe(false)
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it("window.confirm 不可用 → 直接放行（返回 true，不阻塞流程）", () => {
    vi.stubGlobal("confirm", undefined)
    expect(confirmDiscardSkillLibraryDraft()).toBe(true)
  })
})
