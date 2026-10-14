/** C4 冒烟覆盖：src/lib/novel/batch-replace/diff-model.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { MAX_FILES_PER_BATCH, diffLines, summarize, assessSafety, changedFilesOnly, assertSingleMatchReplace, assertBatchReplace, joinCrlfSections } from "./diff-model"
describe("diff-model.ts smoke", () => {
  it("exports MAX_FILES_PER_BATCH", () => {
    expect(MAX_FILES_PER_BATCH).toBeDefined()
  })
  it("exports diffLines", () => {
    expect(diffLines).toBeDefined()
  })
  it("exports summarize", () => {
    expect(summarize).toBeDefined()
  })
  it("exports assessSafety", () => {
    expect(assessSafety).toBeDefined()
  })
  it("exports changedFilesOnly", () => {
    expect(changedFilesOnly).toBeDefined()
  })
})

describe("assertSingleMatchReplace（RCP-20261014-count）", () => {
  it("恰命中1次才替换", () => {
    const r = assertSingleMatchReplace("“冲！”向前。", "“冲！”", "“顶住！”")
    expect(r.code).toBe("ok")
    expect(r.text).toBe("“顶住！”向前。")
  })
  it("0次命中返回not_found且原文不动", () => {
    const r = assertSingleMatchReplace("abc", "zzz", "q")
    expect(r.code).toBe("not_found")
    expect(r.text).toBe("abc")
  })
  it("多次命中返回ambiguous且原文不动", () => {
    const r = assertSingleMatchReplace("子时见。子时见。", "子时见", "X")
    expect(r.code).toBe("ambiguous")
    expect(r.text).toBe("子时见。子时见。")
  })
  it("assertBatchReplace任一失败整体回退原文", () => {
    const r = assertBatchReplace("ab", [{ oldText: "a", newText: "A" }, { oldText: "zzz", newText: "Z" }])
    expect(r.ok).toBe(false)
    expect(r.failedIndex).toBe(1)
    expect(r.text).toBe("ab")
  })
  it("joinCrlfSections行尾零漂移", () => {
    expect(joinCrlfSections("H\r\n", "A\nB", "T\r\n")).toBe("H\r\nA\r\nB\r\nT\r\n")
    expect(joinCrlfSections("H\r\n", "A\nB\n", "T\r\n")).toBe("H\r\nA\r\nB\r\n\r\nT\r\n")
  })
})
