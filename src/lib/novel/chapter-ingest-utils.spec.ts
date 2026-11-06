/** C4 冒烟覆盖：src/lib/novel/chapter-ingest-utils.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { parseFactsSubject, isCanonDualWriteEligible, extractFrontmatterString, extractFrontmatterNumber } from "./chapter-ingest-utils"
describe("chapter-ingest-utils.ts smoke", () => {
  it("exports parseFactsSubject", () => {
    expect(parseFactsSubject).toBeDefined()
  })
  it("exports isCanonDualWriteEligible", () => {
    expect(isCanonDualWriteEligible).toBeDefined()
  })
  it("exports extractFrontmatterString", () => {
    expect(extractFrontmatterString).toBeDefined()
  })
  it("exports extractFrontmatterNumber", () => {
    expect(extractFrontmatterNumber).toBeDefined()
  })
})

// canonical parseFrontmatter（JSON_SCHEMA）会把 `chapter_number: 12` 解析成 number、
// `flag: true` 解析成 boolean —— 非字符串值必须经 String() 收敛，而不是直接漏成 null。
const FM_DOC = [
  "---",
  "title: 雾都",
  "chapter_number: 12",
  "score: 3.5",
  "quoted_number: \"7\"",
  "word: abc",
  "flag: true",
  "tags: [武侠, 悬疑]",
  "empty_value:",
  "---",
  "正文",
].join("\n")

describe("extractFrontmatterString（非字符串值按 String() 收敛）", () => {
  it("number / boolean 值转字符串，而不是当成「没登记」", () => {
    expect(extractFrontmatterString(FM_DOC, "chapter_number")).toBe("12")
    expect(extractFrontmatterString(FM_DOC, "flag")).toBe("true")
    expect(extractFrontmatterString(FM_DOC, "score")).toBe("3.5")
  })

  it("字符串值 trim 后返回；空 YAML 值 / 缺字段 → null", () => {
    expect(extractFrontmatterString(FM_DOC, "title")).toBe("雾都")
    expect(extractFrontmatterString(FM_DOC, "empty_value")).toBeNull()
    expect(extractFrontmatterString(FM_DOC, "not_there")).toBeNull()
  })

  it("列表值（tags: [a, b]）不静默漏成 null，而是 String() 后可见", () => {
    // parseFrontmatter 的列表值是 string[]（非字符串标量），必须走 String(v) 分支——
    // 直接当「没登记」会把已有 tags 报成缺失。
    expect(extractFrontmatterString(FM_DOC, "tags")).toBe("武侠,悬疑")
  })
})

describe("extractFrontmatterNumber（数值直取 / 可转字符串 / 非法 null）", () => {
  it("number 原样返回，number 形态的字符串也接受", () => {
    expect(extractFrontmatterNumber(FM_DOC, "chapter_number")).toBe(12)
    expect(extractFrontmatterNumber(FM_DOC, "score")).toBe(3.5)
    expect(extractFrontmatterNumber(FM_DOC, "quoted_number")).toBe(7)
  })

  it("非数字字符串与缺字段 → null（不把 NaN 当章号）", () => {
    expect(extractFrontmatterNumber(FM_DOC, "word")).toBeNull()
    expect(extractFrontmatterNumber(FM_DOC, "not_there")).toBeNull()
  })
})
