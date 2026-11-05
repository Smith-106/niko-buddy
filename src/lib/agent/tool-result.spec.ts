import { describe, expect, it } from "vitest"
import {
  DEFAULT_TOOL_RESULT_CONTEXT_LIMIT,
  formatToolResultForModel,
  isToolErrorResult,
  keepsFullToolResultForModel,
} from "./tool-result"

describe("isToolErrorResult", () => {
  it("错误前缀（全角冒号）判为错误", () => {
    expect(isToolErrorResult("错误：写入记忆失败")).toBe(true)
  })

  it("错误前缀（半角冒号）判为错误", () => {
    expect(isToolErrorResult("错误: 未知工具")).toBe(true)
  })

  it("前导空白后仍识别错误前缀", () => {
    expect(isToolErrorResult("  错误：超时")).toBe(true)
  })

  it("普通成功文本不判为错误", () => {
    expect(isToolErrorResult("已写入记忆「a」，读回验证通过。")).toBe(false)
  })

  it("缺冒号的裸「错误」二字不判为错误", () => {
    expect(isToolErrorResult("错误")).toBe(false)
  })

  it("空串不判为错误", () => {
    expect(isToolErrorResult("")).toBe(false)
  })
})

describe("keepsFullToolResultForModel", () => {
  it("章节终稿工具全量保留", () => {
    expect(keepsFullToolResultForModel("run_chapter_workflow")).toBe(true)
  })

  it("普通工具不全量保留", () => {
    expect(keepsFullToolResultForModel("read_chapter")).toBe(false)
    expect(keepsFullToolResultForModel("write_memory")).toBe(false)
  })
})

describe("formatToolResultForModel", () => {
  it("默认上限为 10000", () => {
    expect(DEFAULT_TOOL_RESULT_CONTEXT_LIMIT).toBe(10000)
  })

  it("章节终稿超长也原样返回", () => {
    const long = `正文${"啊".repeat(20000)}结尾`
    expect(formatToolResultForModel("run_chapter_workflow", long)).toBe(long)
  })

  it("短文本原样返回", () => {
    expect(formatToolResultForModel("read_chapter", "第一章正文")).toBe("第一章正文")
  })

  it("恰等于上限时不截断", () => {
    const exact = "x".repeat(100)
    expect(formatToolResultForModel("read_chapter", exact, 100)).toBe(exact)
  })

  it("超长截断为头尾片段并标注原始长度", () => {
    const body = `${"头".repeat(300)}中${"尾".repeat(300)}`
    const out = formatToolResultForModel("read_chapter", body, 400)
    expect(out.length).toBeLessThan(body.length)
    expect(out).toContain(`工具 read_chapter 返回内容较长，已压缩给模型使用。原始长度：${body.length} 字。`)
    expect(out).toContain("## 开头片段")
    expect(out).toContain("## 结尾片段")
    // 头尾各保留原文首尾（trim 后），中段被丢弃
    expect(out).toContain("头".repeat(10))
    expect(out).toContain("尾".repeat(10))
    expect(out).not.toContain("中".repeat(50))
  })

  it("极小上限按 200 安全下限兜底仍产出头尾结构", () => {
    const body = `前${"a".repeat(500)}后`
    const out = formatToolResultForModel("read_chapter", body, 10)
    expect(out).toContain("## 开头片段")
    expect(out).toContain("## 结尾片段")
    expect(out).toContain(`原始长度：${body.length} 字。`)
  })
})
