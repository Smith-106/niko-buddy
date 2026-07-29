import { describe, it, expect } from "vitest"
import { computeLcsDiff } from "./diff"

/** 把非 delete 块拼起来应等于 replacement */
function reconstructReplacement(changes: ReturnType<typeof computeLcsDiff>): string {
  return changes.filter((c) => c.type !== "delete").map((c) => c.text).join("")
}

/** 把非 insert 块拼起来应等于 original */
function reconstructOriginal(changes: ReturnType<typeof computeLcsDiff>): string {
  return changes.filter((c) => c.type !== "insert").map((c) => c.text).join("")
}

describe("computeLcsDiff", () => {
  it("空原始串 → 全 insert", () => {
    const changes = computeLcsDiff("", "hello")
    expect(changes).toEqual([{ type: "insert", text: "hello" }])
    expect(reconstructReplacement(changes)).toBe("hello")
    expect(reconstructOriginal(changes)).toBe("")
  })

  it("空替换串 → 全 delete", () => {
    const changes = computeLcsDiff("hello", "")
    expect(changes).toEqual([{ type: "delete", text: "hello" }])
    expect(reconstructReplacement(changes)).toBe("")
    expect(reconstructOriginal(changes)).toBe("hello")
  })

  it("相同串 → 全 equal", () => {
    const changes = computeLcsDiff("abc", "abc")
    expect(changes).toEqual([{ type: "equal", text: "abc" }])
    expect(reconstructReplacement(changes)).toBe("abc")
    expect(reconstructOriginal(changes)).toBe("abc")
  })

  it("纯插入 (abc vs aXbc)", () => {
    const changes = computeLcsDiff("abc", "aXbc")
    expect(reconstructReplacement(changes)).toBe("aXbc")
    expect(reconstructOriginal(changes)).toBe("abc")
    const inserts = changes.filter((c) => c.type === "insert")
    expect(inserts).toEqual([{ type: "insert", text: "X" }])
  })

  it("纯删除 (aXbc vs abc)", () => {
    const changes = computeLcsDiff("aXbc", "abc")
    expect(reconstructReplacement(changes)).toBe("abc")
    expect(reconstructOriginal(changes)).toBe("aXbc")
    const deletes = changes.filter((c) => c.type === "delete")
    expect(deletes).toEqual([{ type: "delete", text: "X" }])
  })

  it("中英文混合 (他走了 vs 他跑走了)", () => {
    const changes = computeLcsDiff("他走了", "他跑走了")
    expect(reconstructReplacement(changes)).toBe("他跑走了")
    expect(reconstructOriginal(changes)).toBe("他走了")
    const inserts = changes.filter((c) => c.type === "insert")
    expect(inserts).toEqual([{ type: "insert", text: "跑" }])
  })
})
