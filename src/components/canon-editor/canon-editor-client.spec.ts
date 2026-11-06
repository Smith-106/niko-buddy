/** C4 冒烟覆盖：src/components/canon-editor/canon-editor-client.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import {
  buildFilter,
  parseChapterInput,
  queryCanonBatch,
} from "./canon-editor-client"
describe("canon-editor-client.ts smoke", () => {
  it("exports queryCanonBatch", () => {
    expect(queryCanonBatch).toBeDefined()
  })
})

// revealed_at 输入框：空白 =「未登记」（null），数字 = 章号，非法整数 = NaN（调用方据此拦住）。
describe("parseChapterInput", () => {
  it("空白输入返回 null（未登记，而不是 0 章）", () => {
    expect(parseChapterInput("")).toBeNull()
    expect(parseChapterInput("   ")).toBeNull()
    expect(parseChapterInput("\t\n")).toBeNull()
  })

  it("数字文本解析为章号，非数字返回 NaN", () => {
    expect(parseChapterInput("12")).toBe(12)
    expect(parseChapterInput(" 7 ")).toBe(7)
    expect(parseChapterInput("第十二章")).toBeNaN()
  })
})

describe("buildFilter", () => {
  it("blank / 非法章号不进 filter，edgeKind=all 表示不过滤边类型", () => {
    const filter = buildFilter({ knownBy: "  ", validAtChapter: "abc", edgeKind: "all" })
    expect(filter.known_by).toBeNull()
    expect(filter.valid_at_chapter).toBeNull()
    expect(filter.edge_kinds).toBeNull()
  })

  it("已知项透传：章号转数字、edgeKind 收敛成单元素数组", () => {
    const filter = buildFilter({ knownBy: " 张三 ", validAtChapter: "9", edgeKind: "foreshadow" })
    expect(filter.known_by).toBe("张三")
    expect(filter.valid_at_chapter).toBe(9)
    expect(filter.edge_kinds).toEqual(["foreshadow"])
  })
})
