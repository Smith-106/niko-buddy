// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest"
import { createDraftDialogGuard } from "./draft-dialog-guard"

describe("createDraftDialogGuard", () => {
  it("issues strictly monotonic tokens and supersedes previous in-flight requests", () => {
    const guard = createDraftDialogGuard()
    expect(guard.isCurrent(0)).toBe(false)

    const t1 = guard.begin()
    expect(t1).toBe(1)
    expect(guard.isCurrent(t1)).toBe(true)

    const t2 = guard.begin()
    expect(t2).toBe(2)
    expect(guard.isCurrent(t1)).toBe(false)
    expect(guard.isCurrent(t2)).toBe(true)
    expect(guard.currentToken()).toBe(2)
  })

  it("invalidates all active tokens when closed, cancelled, or switched", () => {
    const guard = createDraftDialogGuard()
    const t1 = guard.begin()
    expect(guard.isCurrent(t1)).toBe(true)

    guard.invalidate()
    expect(guard.isCurrent(t1)).toBe(false)

    const t2 = guard.begin()
    expect(t2).toBeGreaterThan(t1)
    expect(guard.isCurrent(t2)).toBe(true)
  })
})
