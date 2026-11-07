// SPDX-License-Identifier: MIT
// deep-chapter-runtime-support：章节契约写后核对的「零 finding」快路径。
import { describe, expect, it } from "vitest"
import { CHAPTER_CONTRACT_HEADER } from "./deep-chapter-task-brief"
import { applyChapterContractCheck } from "./deep-chapter-runtime-support"

describe("applyChapterContractCheck", () => {
  it("任务书无契约段 → 原样返回（不伪造 findings）", () => {
    const input = [{ severity: "error" as const, type: "consistency", message: "x", evidence: "", relatedMemory: "", suggestion: "" }]
    expect(applyChapterContractCheck("没有任何契约段的任务书", "正文", input)).toBe(input)
  })

  it("契约段为空（无任何约束条目）→ 零 finding 与零取舍，原样返回", () => {
    const input: never[] = []
    const out = applyChapterContractCheck(`${CHAPTER_CONTRACT_HEADER}\n`, "本章正文。", input)
    expect(out).toEqual([])
  })
})
