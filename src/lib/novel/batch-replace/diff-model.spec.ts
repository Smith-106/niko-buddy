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

describe("diff-model 边界补强", () => {
  it("assertSingleMatchReplace 空 old 直接判定 not_found（空串会命中每个位置，不能当替换）", () => {
    const r = assertSingleMatchReplace("abc", "", "X")
    expect(r).toEqual({ code: "not_found", text: "abc", matches: 0 })
  })

  it("assertBatchReplace 全部命中时逐对应用，返回最终文本与 ok 结论", () => {
    const r = assertBatchReplace("甲说：走。乙说：停。", [
      { oldText: "走", newText: "跑" },
      { oldText: "停", newText: "等" },
    ])
    expect(r).toEqual({
      ok: true,
      text: "甲说：跑。乙说：等。",
      failedIndex: -1,
      code: "ok",
    })
  })

  it("assertBatchReplace 跳过稀疏数组空洞（脏输入不让整批失败）", () => {
    const pairs = new Array<{ oldText: string; newText: string }>(3)
    pairs[0] = { oldText: "a", newText: "A" }
    pairs[2] = { oldText: "b", newText: "B" }

    const r = assertBatchReplace("ab", pairs)

    expect(r).toEqual({ ok: true, text: "AB", failedIndex: -1, code: "ok" })
  })

  it("diffLines 后文件更短时缺失侧按空串对齐", () => {
    expect(diffLines("a\nb", "a")).toEqual([{ line: 2, before: "b", after: "" }])
  })

  it("joinCrlfSections 新区段已以空行结尾时不再追加多余空行", () => {
    expect(joinCrlfSections("H\r\n", "A\r\n\r\n", "T")).toBe("H\r\nA\r\n\r\nT")
  })
})
