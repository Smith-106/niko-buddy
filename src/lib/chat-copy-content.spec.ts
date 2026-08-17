import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  parseAgentResponse: vi.fn(),
  cleanGeneratedChapterContentForSave: vi.fn((s: string) => s.trim()),
}))

vi.mock("@/lib/novel/agent-parser", () => ({
  parseAgentResponse: mocks.parseAgentResponse,
}))

vi.mock("@/lib/novel/chapter-content-cleanup", () => ({
  cleanGeneratedChapterContentForSave: mocks.cleanGeneratedChapterContentForSave,
}))

import { getCopyableAssistantContent } from "./chat-copy-content"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cleanGeneratedChapterContentForSave.mockImplementation((s: string) => s.trim())
})

describe("getCopyableAssistantContent", () => {
  it("joins cleaned chapter bodies when edits target wiki/chapters", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "说明文本",
      edits: [
        { filePath: "wiki/chapters/ch1.md", search: "a", replace: " 第一章正文 " },
        { filePath: "wiki/chapters/ch2.md", search: "b", replace: " 第二章正文 " },
      ],
      hasEdits: true,
    })
    expect(getCopyableAssistantContent("<file_edit>…</file_edit>")).toBe(
      "第一章正文\n\n第二章正文",
    )
    expect(mocks.cleanGeneratedChapterContentForSave).toHaveBeenCalledTimes(2)
  })

  it("filters out edits that are not chapter paths, lack .md, or have empty replace", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "fallback",
      edits: [
        { filePath: "wiki/chapters/ch1.md", search: "a", replace: "正文" },
        { filePath: "wiki/notes/n1.md", search: "b", replace: "不应出现" },
        { filePath: "wiki/chapters/ch2.txt", search: "c", replace: "不应出现" },
        { filePath: "wiki/chapters/ch3.md", search: "d", replace: "   " },
      ],
      hasEdits: true,
    })
    expect(getCopyableAssistantContent("x")).toBe("正文")
    expect(mocks.cleanGeneratedChapterContentForSave).toHaveBeenCalledTimes(1)
  })

  it("normalizes backslashes and leading slashes in chapter paths", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "t",
      edits: [
        { filePath: "\\wiki\\chapters\\CH1.MD", search: "a", replace: "大写正文" },
        { filePath: "wiki/chapters//ch2.md", search: "b", replace: "斜杠正文" },
      ],
      hasEdits: true,
    })
    expect(getCopyableAssistantContent("x")).toBe("大写正文\n\n斜杠正文")
  })

  it("strips paired think blocks, unclosed openings, and HTML comments", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "<!-- 隐藏 --><think>思考中</think>正文<thinking>未闭合",
      edits: [],
      hasEdits: false,
    })
    expect(getCopyableAssistantContent("raw")).toBe("正文")
  })

  it("strips an orphaned closing tag whose prefix has no opening tag", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "孤儿前缀</think>可见正文",
      edits: [],
      hasEdits: false,
    })
    expect(getCopyableAssistantContent("raw")).toBe("可见正文")
  })

  it("falls back to the raw content when textContent is empty", () => {
    mocks.parseAgentResponse.mockReturnValue({
      textContent: "",
      edits: [],
      hasEdits: false,
    })
    expect(getCopyableAssistantContent("纯文本")).toBe("纯文本")
  })
})
