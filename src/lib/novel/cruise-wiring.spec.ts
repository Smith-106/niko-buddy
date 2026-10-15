// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * cruise-wiring.spec — H2-H3 接线层测试。
 * 覆盖：G4→内核步骤映射 + decidePausedChapter 三态。
 * ADR-19：纯函数断言，零 IO / 零模型调用。
 */
import { describe, expect, it } from "vitest"
import type {
  ArbitrationDirective,
  ArbitrationRequest,
} from "./cruise-arbitration"
import {
  ARBITRATION_TO_KERNEL_STEP,
  decidePausedChapter,
  mapSettlementStepToKernel,
} from "./cruise-wiring"

const request: ArbitrationRequest = {
  chapterNumber: 7,
  status: "blocked",
  taskBrief: "brief-7",
}

describe("ARBITRATION_TO_KERNEL_STEP / mapSettlementStepToKernel", () => {
  it("summary → arc_summary，expand → expand_arc", () => {
    expect(ARBITRATION_TO_KERNEL_STEP["summary"]).toBe("arc_summary")
    expect(ARBITRATION_TO_KERNEL_STEP["expand"]).toBe("expand_arc")
    expect(mapSettlementStepToKernel("summary")).toBe("arc_summary")
    expect(mapSettlementStepToKernel("expand")).toBe("expand_arc")
  })

  it("其余步骤直通", () => {
    expect(mapSettlementStepToKernel("arc_review")).toBe("arc_review")
    expect(mapSettlementStepToKernel("volume_summary")).toBe("volume_summary")
    expect(mapSettlementStepToKernel("new_volume")).toBe("new_volume")
  })
})

describe("decidePausedChapter", () => {
  it("directive 为 null → paused", () => {
    expect(decidePausedChapter(request, null)).toEqual({ disposition: "paused" })
  })

  it("retry-rebrief → retry 并带回 revisedBrief", () => {
    const directive: ArbitrationDirective = {
      action: "retry-rebrief",
      revisedBrief: "brief-7-revised",
      reason: "放宽门限重发",
    }
    expect(decidePausedChapter(request, directive)).toEqual({
      disposition: "retry",
      taskBrief: "brief-7-revised",
    })
  })

  it("retry-rebrief 缺 revisedBrief → 抛错", () => {
    const directive: ArbitrationDirective = {
      action: "retry-rebrief",
      reason: "no brief",
    }
    expect(() => decidePausedChapter(request, directive)).toThrow(/revisedBrief/)
  })

  it("skip-chapter → skip", () => {
    const directive: ArbitrationDirective = {
      action: "skip-chapter",
      reason: "跳过本章",
    }
    expect(decidePausedChapter(request, directive)).toEqual({ disposition: "skip" })
  })

  it("abort-campaign → paused", () => {
    const directive: ArbitrationDirective = {
      action: "abort-campaign",
      reason: "终止战役",
    }
    expect(decidePausedChapter(request, directive)).toEqual({ disposition: "paused" })
  })
})
