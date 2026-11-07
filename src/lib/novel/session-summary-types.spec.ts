// SPDX-License-Identifier: MIT
// session-summary-types：本地最小类型面 + 落地标记常量。
import { describe, expect, it } from "vitest"

import { SESSION_SUMMARY_TYPE_LOCAL } from "./session-summary-types"
import type { SessionContextSummary } from "./session-summary-types"

describe("session-summary-types", () => {
  it("标记常量可取用（本地类型面已落地，不依赖 context-hub）", () => {
    expect(SESSION_SUMMARY_TYPE_LOCAL).toBe(true)
  })

  it("SessionContextSummary 最小字段面可构造", () => {
    const summary: SessionContextSummary = { text: "摘要", updatedAt: 1, dependencyFingerprint: "fp" }
    expect(summary.text).toBe("摘要")
  })
})
