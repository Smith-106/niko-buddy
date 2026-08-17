import { describe, expect, it } from "vitest"
import { createDeepThinkingStreamRenderer, renderDeepThinkingStream } from "./deep-thinking-stream"

describe("deep thinking stream renderer", () => {
  it("updates the same stage in place instead of appending duplicate thinking blocks", () => {
    const stream = createDeepThinkingStreamRenderer()

    stream.updateThinking("## 阶段2：写作任务书\n第一段")
    const content = stream.updateThinking("## 阶段2：写作任务书\n第一段第二段")

    expect(content.match(/<think>/g)).toHaveLength(1)
    expect(content).toContain("第一段第二段")
    expect(content).not.toContain("第一段\n</think>\n\n<think>")
  })

  it("keeps different stages ordered and appends final content after thinking", () => {
    const stream = createDeepThinkingStreamRenderer()

    stream.updateThinking("## 阶段1：上下文分析\n已读取上下文")
    stream.updateThinking("## 阶段2：写作任务书\n任务书")
    const content = stream.appendFinal("正文内容")

    expect(content).toContain("<think>\n## 阶段1：上下文分析")
    expect(content).toContain("<think>\n## 阶段2：写作任务书")
    expect(content.endsWith("正文内容")).toBe(true)
  })

  it("derives the stage key from the first non-empty line when there is no heading", () => {
    const stream = createDeepThinkingStreamRenderer()

    stream.updateThinking("第一段思考\nmore detail")
    const content = stream.updateThinking("第一段思考\nupdated detail")

    expect(content.match(/<think>/g)).toHaveLength(1)
    expect(content).toContain("updated detail")
    expect(content).not.toContain("more detail")
  })

  it("falls back to the raw block when the first line is blank", () => {
    const stream = createDeepThinkingStreamRenderer()

    // The heading match fails (no `##`) and the first line is blank after
    // trim, so the stage key falls back to the whole raw block.
    stream.updateThinking("\nblank-led block")
    const content = stream.getContent()
    expect(content.match(/<think>/g)).toHaveLength(1)
    expect(content).toContain("blank-led block")
  })

  it("ignores empty or whitespace-only thinking updates", () => {
    const stream = createDeepThinkingStreamRenderer()
    stream.updateThinking("## 阶段：初始")

    const content = stream.updateThinking("   \n\t  ")
    expect(content.match(/<think>/g)).toHaveLength(1)
    expect(content).toContain("## 阶段：初始")
  })

  it("getContent returns the current combined output without mutating", () => {
    const stream = createDeepThinkingStreamRenderer()
    stream.updateThinking("## 阶段1：分析")
    stream.appendFinal("结果")

    const content = stream.getContent()
    expect(content).toContain("<think>\n## 阶段1：分析")
    expect(content.endsWith("结果")).toBe(true)

    // Repeated reads are stable.
    expect(stream.getContent()).toBe(content)
  })
})

describe("renderDeepThinkingStream", () => {
  it("returns the final content alone when there are no thinking blocks", () => {
    expect(renderDeepThinkingStream([], "only final")).toBe("only final")
  })

  it("filters out empty thinking blocks and returns the final content", () => {
    expect(renderDeepThinkingStream(["", "   ", "\n"], "final")).toBe("final")
    expect(renderDeepThinkingStream(["", "   "])).toBe("")
  })

  it("returns only the thinking blocks when there is no final content", () => {
    const out = renderDeepThinkingStream(["## 阶段：思考"], "")
    expect(out).toBe("<think>\n## 阶段：思考\n</think>")
  })

  it("joins multiple blocks with blank lines and appends the final body", () => {
    const out = renderDeepThinkingStream(["## 阶段1", "## 阶段2"], "正文")
    expect(out).toBe("<think>\n## 阶段1\n</think>\n\n<think>\n## 阶段2\n</think>\n\n正文")
  })
})
