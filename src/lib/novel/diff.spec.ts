import { describe, it, expect } from "vitest"
import { computeLcsDiff, computeMyersDiff } from "./diff"
import type { DiffChange } from "./diff"

/** 把非 delete 块拼起来应等于 replacement */
function reconstructReplacement(changes: DiffChange[]): string {
  return changes.filter((c) => c.type !== "delete").map((c) => c.text).join("")
}

/** 把非 insert 块拼起来应等于 original */
function reconstructOriginal(changes: DiffChange[]): string {
  return changes.filter((c) => c.type !== "insert").map((c) => c.text).join("")
}

/** 行级重建: 把非 insert 块拼起来应等于 original ("\n" 连接) */
function reconstructOriginalLines(changes: DiffChange[]): string {
  return changes.filter((c) => c.type !== "insert").map((c) => c.text).join("\n")
}

/** 行级重建: 把非 delete 块拼起来应等于 replacement ("\n" 连接) */
function reconstructReplacementLines(changes: DiffChange[]): string {
  return changes.filter((c) => c.type !== "delete").map((c) => c.text).join("\n")
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

describe("computeMyersDiff (T21 章节级行 diff)", () => {
  it("空原始 → 全 insert", () => {
    const changes = computeMyersDiff("", "行1\n行2")
    expect(reconstructReplacementLines(changes)).toBe("行1\n行2")
    expect(reconstructOriginalLines(changes)).toBe("")
  })

  it("空替换 → 全 delete", () => {
    const changes = computeMyersDiff("行1\n行2", "")
    expect(reconstructReplacementLines(changes)).toBe("")
    expect(reconstructOriginalLines(changes)).toBe("行1\n行2")
  })

  it("相同文本 → 全 equal", () => {
    const changes = computeMyersDiff("行1\n行2\n行3", "行1\n行2\n行3")
    expect(changes.every((c) => c.type === "equal")).toBe(true)
    expect(reconstructOriginalLines(changes)).toBe("行1\n行2\n行3")
    expect(reconstructReplacementLines(changes)).toBe("行1\n行2\n行3")
  })

  it("行级插入: 在中间插入一行", () => {
    const original = "第一行\n第二行\n第四行"
    const replacement = "第一行\n第二行\n第三行\n第四行"
    const changes = computeMyersDiff(original, replacement)
    expect(reconstructOriginalLines(changes)).toBe(original)
    expect(reconstructReplacementLines(changes)).toBe(replacement)
  })

  it("行级删除: 删除中间一行", () => {
    const original = "第一行\n第二行\n第三行\n第四行"
    const replacement = "第一行\n第二行\n第四行"
    const changes = computeMyersDiff(original, replacement)
    expect(reconstructOriginalLines(changes)).toBe(original)
    expect(reconstructReplacementLines(changes)).toBe(replacement)
  })

  it("行级替换: 修改一行内容", () => {
    const original = "第一行\n第二行(旧)\n第三行"
    const replacement = "第一行\n第二行(新)\n第三行"
    const changes = computeMyersDiff(original, replacement)
    expect(reconstructOriginalLines(changes)).toBe(original)
    expect(reconstructReplacementLines(changes)).toBe(replacement)
  })

  it("章节级大文本: 性能可接受 (10 行 → 15 行)", () => {
    const original = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 段正文内容`).join("\n")
    const replacement = Array.from({ length: 15 }, (_, i) => `第 ${i + 1} 段正文内容 (修订版)`).join("\n")
    const t0 = performance.now()
    const changes = computeMyersDiff(original, replacement)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(100) // 10->15 行应在 100ms 内
    expect(changes.length).toBeGreaterThan(0)
    expect(reconstructOriginalLines(changes)).toBe(original)
    expect(reconstructReplacementLines(changes)).toBe(replacement)
  })
})