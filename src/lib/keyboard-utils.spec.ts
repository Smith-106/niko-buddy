import { describe, expect, it } from "vitest"
import type { KeyboardEvent } from "react"
import { isImeComposing } from "./keyboard-utils"

function makeEvent(overrides: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return {
    nativeEvent: { isComposing: overrides.isComposing ?? false },
    keyCode: overrides.keyCode ?? 0,
  } as unknown as KeyboardEvent
}

describe("isImeComposing", () => {
  it("returns true while the IME is composing", () => {
    expect(isImeComposing(makeEvent({ isComposing: true }))).toBe(true)
  })

  it("returns true for the commit-press keyCode 229", () => {
    expect(isImeComposing(makeEvent({ keyCode: 229 }))).toBe(true)
  })

  it("returns true when either signal is present", () => {
    expect(isImeComposing(makeEvent({ isComposing: true, keyCode: 229 }))).toBe(true)
  })

  it("returns false for a plain Enter keypress", () => {
    expect(isImeComposing(makeEvent({ keyCode: 13 }))).toBe(false)
    expect(isImeComposing(makeEvent({}))).toBe(false)
  })
})
