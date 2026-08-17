import { describe, expect, it } from "vitest"
import { clampResizableInputHeight, resolveResizableInputMaxHeight } from "./chat-input-resize"

describe("chat input resize bounds", () => {
  it("keeps the input height between the default height and half of the panel", () => {
    expect(clampResizableInputHeight(20, { minHeight: 44, maxHeight: 300 })).toBe(44)
    expect(clampResizableInputHeight(180, { minHeight: 44, maxHeight: 300 })).toBe(180)
    expect(clampResizableInputHeight(500, { minHeight: 44, maxHeight: 300 })).toBe(300)
  })

  it("uses half of the available panel height as the maximum", () => {
    expect(resolveResizableInputMaxHeight({ panelHeight: 900, viewportHeight: 1200 })).toBe(450)
    expect(resolveResizableInputMaxHeight({ panelHeight: 0, viewportHeight: 1000 })).toBe(500)
  })

  it("clamps to the default height when the viewport-derived max is smaller", () => {
    expect(resolveResizableInputMaxHeight({ panelHeight: 0, viewportHeight: 88 })).toBe(44)
    expect(resolveResizableInputMaxHeight({ panelHeight: 0, viewportHeight: 40 })).toBe(44)
  })

  it("returns the min height for non-finite values", () => {
    expect(clampResizableInputHeight(NaN, { minHeight: 44, maxHeight: 300 })).toBe(44)
    expect(clampResizableInputHeight(Infinity, { minHeight: 44, maxHeight: 300 })).toBe(44)
    expect(clampResizableInputHeight(-Infinity, { minHeight: 44, maxHeight: 300 })).toBe(44)
  })

  it("rounds fractional heights and handles degenerate bounds", () => {
    expect(clampResizableInputHeight(120.6, { minHeight: 44, maxHeight: 300 })).toBe(121)
    expect(clampResizableInputHeight(100.2, { minHeight: 44, maxHeight: 300 })).toBe(100)
    // minHeight < 1 → 抬到 1；maxHeight < minHeight → 取 minHeight
    expect(clampResizableInputHeight(50, { minHeight: -10, maxHeight: -5 })).toBe(1)
    // 小数 bounds 向下取整
    expect(clampResizableInputHeight(60, { minHeight: 44.9, maxHeight: 300.9 })).toBe(60)
  })
})
