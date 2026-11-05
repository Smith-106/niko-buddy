import { describe, expect, it } from "vitest"
import {
  extractH1Headings,
  isBareChapterLabel,
  isRichChapterTitle,
  normalizeChapterDocument,
  parseChapterOrdinal,
  readFrontmatterTitle,
  resolveChapterTitle,
} from "./chapter-typography"

/**
 * chapter-typography.ts 分支补测（覆盖率战役第九批）。
 * b9（未知中文数字）为不可达：raw 字符集经正则限定，去除阿拉伯数字后只剩
 * CNY_DIGITS/百十千，不会命中 `value === undefined`。
 * b30 左支（resolved 为空但 frontmatter 有 title）不可达：resolve 为空蕴含
 * fmTitle 为空，见 resolveChapterTitle 优先级（有 fmTitle 必返回它）。
 */
describe("chapter-typography branch coverage", () => {
  it("parseChapterOrdinal 无章号文本返回 null（67 真支）", () => {
    expect(parseChapterOrdinal("引子")).toBeNull()
    expect(parseChapterOrdinal("")).toBeNull()
  })

  it("parseChapterOrdinal 百/十/千全形态（含零位省略与前置零位）", () => {
    expect(parseChapterOrdinal("第一百零三章")).toBe(103)
    expect(parseChapterOrdinal("第百章")).toBe(100)
    expect(parseChapterOrdinal("第一百章")).toBe(100)
    expect(parseChapterOrdinal("第十章")).toBe(10)
    expect(parseChapterOrdinal("第二十章")).toBe(20)
    expect(parseChapterOrdinal("第一千零一章")).toBe(1001)
    expect(parseChapterOrdinal("第千章")).toBe(1000)
    expect(parseChapterOrdinal("第十二章")).toBe(12)
  })

  it("parseChapterOrdinal 零章回 null（90 假支）", () => {
    expect(parseChapterOrdinal("第零章")).toBeNull()
    expect(parseChapterOrdinal("第〇章")).toBeNull()
  })

  it("readFrontmatterTitle 空 title 回 undefined（103 右支）", () => {
    expect(readFrontmatterTitle('---\ntitle: ""\n---\n\n正文')).toBeUndefined()
    expect(readFrontmatterTitle("---\ntitle:   \n---\n\n正文")).toBeUndefined()
  })

  it("extractH1Headings 跳过空标题行（112 假支）", () => {
    expect(extractH1Headings("#   \n# Real")).toEqual(["Real"])
  })

  it("resolveChapterTitle 非裸非富 H1 走 nonBare（148 真支）", () => {
    expect(resolveChapterTitle("# 引子\n\n正文")).toBe("引子")
  })

  it("resolveChapterTitle 仅裸 H1 走 firstHeading（150 真支）", () => {
    expect(resolveChapterTitle("# 第3章\n\n正文")).toBe("第3章")
  })

  it("resolveChapterTitle 无标题无 fallback 回空串（151 右支）", () => {
    expect(resolveChapterTitle("正文而已")).toBe("")
  })

  it("bare/rich 互斥边界", () => {
    expect(isBareChapterLabel("第3章")).toBe(true)
    expect(isRichChapterTitle("第3章")).toBe(false)
  })

  it("normalizeChapterDocument 空标题走兜底（192 假支/212 假支）", () => {
    const result = normalizeChapterDocument("正文而已", { normalizeBody: false })
    expect(result.title).toBe("")
    expect(result.changed).toBe(false)
    expect(result.changes).toEqual({ titleSynced: false, headingsDeduped: 0, bodyNormalized: false })
  })

  it("normalizeChapterDocument 无 title 行的 frontmatter 原位插入（202 假支）", () => {
    const content = ["---", "type: chapter", "---", "", "# 第1章 名", "", "正文", ""].join("\n")
    const result = normalizeChapterDocument(content, { normalizeBody: false })
    expect(result.changed).toBe(true)
    expect(readFrontmatterTitle(result.content)).toBe("第1章 名")
  })

  it("normalizeChapterDocument CRLF 换行走 \\r\\n 支（213 真支）", () => {
    const content = '---\r\ntitle: "第1章 名"\r\n---\r\n\r\n# 第1章 名\r\n\r\n正文\r\n'
    const result = normalizeChapterDocument(content, { normalizeBody: false })
    expect(result.title).toBe("第1章 名")
    expect(result.content).toContain("\r\n")
  })

  it("normalizeChapterDocument 无前导 H1 跳过去重（232 假支）", () => {
    const content = ["---", 'title: "第1章 名"', "---", "", "正文无标题", ""].join("\n")
    const result = normalizeChapterDocument(content, { normalizeBody: false })
    expect(result.title).toBe("第1章 名")
    expect(result.changes.headingsDeduped).toBe(0)
  })
})
