import { describe, expect, it } from "vitest"
import { parseAgentResponse, detectEditIntent, buildAgentSystemSuffix } from "./agent-parser"

describe("agent-parser parseAgentResponse", () => {
  it("parses a single file_edit block and strips tags from text", () => {
    const content = `我来帮你修改。

<file_edit path="wiki/chapters/chapter-001.md">
<search>
旧内容
</search>
<replace>
新内容
</replace>
</file_edit>

完成。`
    const parsed = parseAgentResponse(content)
    expect(parsed.textContent).toBe("我来帮你修改。\n\n\n\n完成。")
    expect(parsed.edits).toEqual([
      { filePath: "wiki/chapters/chapter-001.md", search: "旧内容", replace: "新内容" },
    ])
    expect(parsed.hasEdits).toBe(true)
  })

  it("parses multiple file_edit blocks", () => {
    const content = [
      '<file_edit path="a.md"><search>s1</search><replace>r1</replace></file_edit>',
      '<file_edit path="b.md"><search>s2</search><replace>r2</replace></file_edit>',
    ].join("\n")
    const parsed = parseAgentResponse(content)
    expect(parsed.edits).toHaveLength(2)
    expect(parsed.edits[1].filePath).toBe("b.md")
    expect(parsed.hasEdits).toBe(true)
  })

  it("trims whitespace around search/replace content", () => {
    const content =
      '<file_edit path="x.md"><search>\n  padded  \n</search><replace>\n  out  \n</replace></file_edit>'
    const parsed = parseAgentResponse(content)
    expect(parsed.edits[0].search).toBe("padded")
    expect(parsed.edits[0].replace).toBe("out")
  })

  it("returns no edits and full text when no tags present", () => {
    const parsed = parseAgentResponse("  只是普通对话  ")
    expect(parsed.edits).toEqual([])
    expect(parsed.hasEdits).toBe(false)
    expect(parsed.textContent).toBe("只是普通对话")
  })

  it("keeps text outside tags including text between blocks", () => {
    const content = '前文 <file_edit path="a.md"><search>s</search><replace>r</replace></file_edit> 后文'
    const parsed = parseAgentResponse(content)
    expect(parsed.textContent).toBe("前文  后文")
  })

  it("handles block missing search/replace content (no edit match)", () => {
    const content = '<file_edit path="a.md"><search>s</search></file_edit>正文'
    const parsed = parseAgentResponse(content)
    expect(parsed.edits).toEqual([])
    expect(parsed.textContent).toBe("正文")
  })
})

describe("agent-parser detectEditIntent", () => {
  it("detects Chinese edit keywords", () => {
    for (const text of ["帮我修改一下", "请替换这段", "删除这个段落", "添加一段描写", "把这段改成那样", "更新设定", "重新改写结局", "去掉多余部分", "插入一段对话", "变更人物关系", "调整节奏"]) {
      expect(detectEditIntent(text), text).toBe(true)
    }
  })

  it("detects English edit keywords case-insensitively", () => {
    expect(detectEditIntent("Please EDIT this")).toBe(true)
    expect(detectEditIntent("replace the word")).toBe(true)
    expect(detectEditIntent("Modify it")).toBe(true)
    expect(detectEditIntent("DELETE line")).toBe(true)
  })

  it("returns false for plain chat", () => {
    expect(detectEditIntent("今天天气不错")).toBe(false)
    expect(detectEditIntent("这个故事很好看")).toBe(false)
  })
})

describe("agent-parser buildAgentSystemSuffix", () => {
  it("builds chapters scope suffix", () => {
    const suffix = buildAgentSystemSuffix("chapters")
    expect(suffix).toContain("章节文件（wiki/chapters/）")
    expect(suffix).toContain("<file_edit")
    expect(suffix).toContain("只能修改章节文件（wiki/chapters/）下的文件")
  })

  it("builds outlines scope suffix", () => {
    const suffix = buildAgentSystemSuffix("outlines")
    expect(suffix).toContain("大纲文件（wiki/outlines/）")
    expect(suffix).toContain("只能修改大纲文件（wiki/outlines/）下的文件")
  })
})
