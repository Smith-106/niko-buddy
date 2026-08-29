import { describe, expect, it } from "vitest"

import {
  hasMarkdownContentChanged,
  inspectStructuredMarkdown,
  isStructuredMarkdownMaterial,
  repairStructuredMarkdownLocally,
} from "./markdown-quality-pipeline"

describe("markdown quality pipeline", () => {
  it("仅把有多项 Markdown 结构证据的正文识别为结构化资料", () => {
    expect(isStructuredMarkdownMaterial("# 人物设定\n\n- 姓名：林川\n- 目标：复仇")).toBe(true)
    expect(isStructuredMarkdownMaterial("人物设定\n\n- 姓名：林川\n- 目标：复仇")).toBe(true)
    expect(isStructuredMarkdownMaterial("这个问题建议先确认人物动机，再决定后续情节。")).toBe(false)
  })

  it("检查一级标题、成对加粗和全文代码围栏", () => {
    const result = inspectStructuredMarkdown("```markdown\n人物设定\n\n**姓名：林川\n- 目标：复仇\n```")

    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "whole-document-code-fence",
      "missing-title",
      "unpaired-bold",
    ])
  })

  it("已有 Markdown 表格缺少分隔行时报告问题", () => {
    const result = inspectStructuredMarkdown("# 人物表\n\n| 人物 | 目标 |\n| 林川 | 复仇 |")

    expect(result.issues.map((issue) => issue.code)).toContain("missing-table-separator")
  })

  it("保留已有表格分隔行且不重复报告", () => {
    const result = inspectStructuredMarkdown("# 人物表\n\n| 人物 | 目标 |\n| :--- | ---: |\n| 林川 | 复仇 |")

    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("已有表格分隔行后的多条数据不会被误报", () => {
    const result = inspectStructuredMarkdown(
      "# 人物表\n\n| 人物 | 目标 |\n| --- | --- |\n| 林川 | 复仇 |\n| 苏晚 | 守城 |",
    )

    expect(result.valid).toBe(true)
  })

  it("缺失分隔行的多条数据只插入一行分隔符", () => {
    const repaired = repairStructuredMarkdownLocally(
      "# 人物表\n\n| 人物 | 目标 |\n| 林川 | 复仇 |\n| 苏晚 | 守城 |",
    )

    expect(repaired.match(/^\| --- \| --- \|$/gm)).toHaveLength(1)
    expect(inspectStructuredMarkdown(repaired).valid).toBe(true)
  })

  it("确定性本地修复只调整 Markdown 标记并保留正文", () => {
    const source = "```markdown\n人物设定\n\n**姓名：林川\n\n| 人物 | 目标 |\n| 林川 | 复仇 |\n```"

    expect(repairStructuredMarkdownLocally(source)).toBe(
      "# 人物设定\n\n姓名：林川\n\n| 人物 | 目标 |\n| --- | --- |\n| 林川 | 复仇 |",
    )
  })

  it("本地格式修复不被误判为内容丢失", () => {
    const source = "```markdown\n人物设定\n\n**姓名：林川\n\n| 人物 | 目标 |\n| 林川 | 复仇 |\n```"
    const repaired = "# 人物设定\n\n姓名：林川\n\n| 人物 | 目标 |\n| --- | --- |\n| 林川 | 复仇 |"

    expect(hasMarkdownContentChanged(source, repaired)).toBe(false)
  })

  it("候选版本明显删除原文段落时拒绝覆盖", () => {
    const source = "# 总纲\n\n## 第一幕\n林川失去家园并踏上复仇之路。\n\n## 第二幕\n林川发现仇人来自王都。\n\n## 第三幕\n林川在决战中揭开身世。"
    const truncated = "# 总纲\n\n## 第一幕\n林川失去家园并踏上复仇之路。"

    expect(hasMarkdownContentChanged(source, truncated)).toBe(true)
  })
  it("即使只删除一个短事实也判定内容已变化", () => {
    const source = "# 人物\n\n姓名：林川\n目标：复仇"
    const candidate = "# 人物\n\n姓名：林川"

    expect(hasMarkdownContentChanged(source, candidate)).toBe(true)
  })

  it("仅调整 Markdown 标记和表格分隔行时仍视为完整", () => {
    const source = "```markdown\n人物表\n\n| 人物 | 目标 |\n| 林川 | 复仇 |\n```"
    const candidate = "# 人物表\n\n| 人物 | 目标 |\n| --- | --- |\n| **林川** | 复仇 |"

    expect(hasMarkdownContentChanged(source, candidate)).toBe(false)
  })

  it("加粗检查忽略 fenced code 中的双星号", () => {
    const source = "# 文件规则\n\n```text\n**/*.md\n**not-bold\n```"

    expect(inspectStructuredMarkdown(source).valid).toBe(true)
    expect(repairStructuredMarkdownLocally(source)).toBe(source)
  })

  it("加粗检查忽略 inline code 且保留代码原文", () => {
    const source = "# 文件规则\n\n使用 `**/*.md` 匹配文件，**重点**保持成对。"

    expect(inspectStructuredMarkdown(source).valid).toBe(true)
    expect(repairStructuredMarkdownLocally(source)).toBe(source)
  })

  it("glob 双星号不是加粗标记且不得被修复", () => {
    const source = "# 文件规则\n\n匹配 **/*.md 文件。"

    expect(inspectStructuredMarkdown(source).valid).toBe(true)
    expect(repairStructuredMarkdownLocally(source)).toBe(source)
  })

  it("字面管道符变化必须判定内容变化", () => {
    expect(hasMarkdownContentChanged(
      "# 规则\n\n逻辑表达式 A|B 不可改。",
      "# 规则\n\n逻辑表达式 AB 不可改。",
    )).toBe(true)
  })

  it("非表格上下文的分隔样式行不得被归一化删除", () => {
    expect(hasMarkdownContentChanged(
      "# 规则\n\n字面内容：\n| --- |\n结束。",
      "# 规则\n\n字面内容：\n结束。",
    )).toBe(true)
  })

  it("代码中的字面标点变化必须判定内容变化", () => {
    expect(hasMarkdownContentChanged(
      "# 示例\n\n```text\nA|B\n---\n```",
      "# 示例\n\n```text\nAB\n```",
    )).toBe(true)
  })

  it("代码中的双星号变化必须判定内容变化", () => {
    expect(hasMarkdownContentChanged(
      "# 示例\n\n```text\n**value\n```",
      "# 示例\n\n```text\nvalue\n```",
    )).toBe(true)
  })

  it("glob 双星号变化必须判定内容变化", () => {
    expect(hasMarkdownContentChanged(
      "# 规则\n\n匹配 **/*.md 文件。",
      "# 规则\n\n匹配 /*.md 文件。",
    )).toBe(true)
  })

  it("全文非 markdown 代码围栏中的标点变化必须拒绝", () => {
    expect(hasMarkdownContentChanged(
      "```text\n**value\n```",
      "```text\nvalue\n```",
    )).toBe(true)
  })

  it("带尾随文本的反引号行不能关闭 fenced code", () => {
    const source = "# 示例\n\n```text\n代码\n```not-a-close\n**literal\n```"

    expect(inspectStructuredMarkdown(source).valid).toBe(true)
    expect(repairStructuredMarkdownLocally(source)).toBe(source)
  })

  it("较短反引号行不能关闭更长的 fenced code", () => {
    const source = "# 示例\n\n````text\n代码\n```\n**literal\n````"

    expect(inspectStructuredMarkdown(source).valid).toBe(true)
    expect(repairStructuredMarkdownLocally(source)).toBe(source)
  })

  it("表格解析忽略转义管道符和 inline code 管道符", () => {
    const source = "# 规则表\n\n| 模式 | 说明 |\n| `a|b` | 匹配 A\\|B |"

    expect(inspectStructuredMarkdown(source).issues.map((issue) => issue.code))
      .toContain("missing-table-separator")
  })

  it("含转义和 inline code 管道符的表格可确定性补分隔行", () => {
    const source = "# 规则表\n\n| 模式 | 说明 |\n| `a|b` | 匹配 A\\|B |"
    const expected = "# 规则表\n\n| 模式 | 说明 |\n| --- | --- |\n| `a|b` | 匹配 A\\|B |"

    expect(repairStructuredMarkdownLocally(source)).toBe(expected)
    expect(inspectStructuredMarkdown(expected).valid).toBe(true)
  })

  it("真实表格分隔行差异在复杂 cell 下仍保持内容完整", () => {
    const source = "# 规则表\n\n| 模式 | 说明 |\n| `a|b` | 匹配 A\\|B |"
    const candidate = "# 规则表\n\n| 模式 | 说明 |\n| --- | --- |\n| `a|b` | 匹配 A\\|B |"

    expect(hasMarkdownContentChanged(source, candidate)).toBe(false)
  })

})
