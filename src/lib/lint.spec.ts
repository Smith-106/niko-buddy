import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"

const fsState = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))
const streamChatMock = vi.hoisted(() => vi.fn())
const tMock = vi.hoisted(() =>
  vi.fn((k: string, opts?: { link?: string }) => (opts?.link ? `${k}:${opts.link}` : k)),
)
const buildLanguageDirectiveMock = vi.hoisted(() => vi.fn((s: string) => `[LANG:${s.length}]`))
const buildContextPackMock = vi.hoisted(() => vi.fn())
const contextPackToPromptMock = vi.hoisted(() => vi.fn((p: unknown) => `CP:${JSON.stringify(p)}`))

vi.mock("@/commands/fs", () => fsState)
vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))
vi.mock("@/i18n", () => ({ default: { t: tMock } }))
vi.mock("@/lib/output-language", () => ({ buildLanguageDirective: buildLanguageDirectiveMock }))
vi.mock("@/lib/novel/context-engine", () => ({
  buildContextPack: buildContextPackMock,
  contextPackToPrompt: contextPackToPromptMock,
}))

import { useActivityStore } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { runSemanticLint, runStructuralLint } from "./lint"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxContextSize: 128000,
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  reasoning: { mode: "off" },
}

function mdFile(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dir(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children }
}

const WIKI_TREE: FileNode[] = [
  mdFile("a.md", "/P/wiki/a.md"),
  mdFile("b.md", "/P/wiki/b.md"),
  dir("concepts", "/P/wiki/concepts", [mdFile("c.md", "/P/wiki/concepts/c.md")]),
  mdFile("d.md", "/P/wiki/d.md"),
  mdFile("e.txt", "/P/wiki/e.txt"),
  dir("empty-dir", "/P/wiki/empty-dir", []),
  mdFile("index.md", "/P/wiki/index.md"),
  mdFile("log.md", "/P/wiki/log.md"),
  mdFile("broken.md", "/P/wiki/broken.md"),
  dir("foo", "/P/wiki/foo", [mdFile("bar.md", "/P/wiki/foo/bar.md")]),
]

const PAGE_CONTENT: Record<string, string> = {
  "/P/wiki/a.md": "link [[b]] and [[concepts/c]] and [[missing]] and [[zzz/bar]]",
  "/P/wiki/b.md": "[[a]]",
  "/P/wiki/concepts/c.md": "no links",
  "/P/wiki/d.md": "",
  "/P/wiki/foo/bar.md": "[[zzz/qux]]",
  "/P/wiki/index.md": "[[a]]",
  "/P/wiki/log.md": "[[b]]",
}

beforeEach(() => {
  vi.clearAllMocks()
  fsState.listDirectory.mockReset().mockResolvedValue([])
  fsState.readFile.mockReset()
  streamChatMock.mockReset().mockImplementation(async () => {})
  tMock.mockClear()
  buildLanguageDirectiveMock.mockClear()
  buildContextPackMock.mockReset().mockResolvedValue({ chapters: [] })
  contextPackToPromptMock.mockClear()
  useActivityStore.setState({ items: [] })
  useWikiStore.setState({ novelMode: true })
})

afterEach(() => {
  useWikiStore.setState({ novelMode: true })
})

function contentFor(p: string): Promise<string> {
  if (p === "/P/wiki/broken.md") return Promise.reject(new Error("ENOENT"))
  return Promise.resolve(PAGE_CONTENT[p] ?? "")
}

describe("runStructuralLint", () => {
  it("reports orphans, no-outlinks and broken links across a nested wiki", async () => {
    fsState.listDirectory.mockResolvedValue(WIKI_TREE)
    fsState.readFile.mockImplementation(contentFor)
    const results = await runStructuralLint("/P")
    // a/b/concepts-c are each linked by another page; d and foo/bar have no inbound links
    expect(results.filter((r) => r.type === "orphan").map((r) => r.page).sort()).toEqual([
      "d.md",
      "foo/bar.md",
    ])
    expect(results.filter((r) => r.type === "no-outlinks").map((r) => r.page).sort()).toEqual([
      "concepts/c.md",
      "d.md",
    ])
    const broken = results.filter((r) => r.type === "broken-link")
    expect(broken.map((r) => r.page)).toEqual(["a.md", "foo/bar.md"])
    expect(broken.map((r) => r.severity)).toEqual(["warning", "warning"])
    expect(broken.map((r) => r.detail)).toEqual(["lint.details.brokenLink:missing", "lint.details.brokenLink:zzz/qux"])
    // index.md/log.md are excluded; e.txt/empty-dir never become pages
    expect(results.some((r) => r.page.includes("index"))).toBe(false)
    expect(results.some((r) => r.page.includes("log.md"))).toBe(false)
    expect(results.some((r) => r.page.includes("e.txt"))).toBe(false)
  })

  it("returns [] when the wiki directory cannot be listed", async () => {
    fsState.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await expect(runStructuralLint("/P")).resolves.toEqual([])
  })
})

describe("runSemanticLint", () => {
  function lastActivity() {
    const items = useActivityStore.getState().items
    return items[0]
  }

  it("returns [] and flags an error when the wiki listing fails", async () => {
    fsState.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await expect(runSemanticLint("/P", llmConfig)).resolves.toEqual([])
    expect(lastActivity().status).toBe("error")
    expect(lastActivity().detail).toBe("读取资料目录失败。")
  })

  it("returns [] when there are no readable pages", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("log.md", "/P/wiki/log.md")])
    await expect(runSemanticLint("/P", llmConfig)).resolves.toEqual([])
    expect(lastActivity().status).toBe("done")
    expect(lastActivity().detail).toBe("没有可检查的资料页。")
  })

  it("runs in wiki mode when novelMode is off", async () => {
    useWikiStore.setState({ novelMode: false })
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("some wiki content")
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      const prompt = msgs[0].content
      expect(prompt).toContain("wiki quality analyst")
      callbacks.onToken("no blocks here")
      callbacks.onDone()
    })
    const results = await runSemanticLint("/P", llmConfig)
    expect(results).toEqual([])
    expect(lastActivity().detail).toBe("发现 0 个语义问题。")
  })

  it("parses LINT blocks into semantic results (warning + PAGES / info without)", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken(
        "---LINT: contradiction | warning | 设定冲突---\n描述文字。\nPAGES: wiki/a.md, wiki/b.md\n---END LINT---\n",
      )
      callbacks.onToken("---LINT: stale | info | Old info---\nSome description.\n---END LINT---")
      callbacks.onDone()
    })
    const results = await runSemanticLint("/P", llmConfig)
    expect(results).toEqual([
      {
        type: "semantic",
        severity: "warning",
        page: "设定冲突",
        detail: "[contradiction] 描述文字。",
        affectedPages: ["wiki/a.md", "wiki/b.md"],
      },
      {
        type: "semantic",
        severity: "info",
        page: "Old info",
        detail: "[stale] Some description.",
        affectedPages: undefined,
      },
    ])
    expect(lastActivity().status).toBe("done")
    expect(lastActivity().detail).toBe("发现 2 个语义问题。")
    expect(streamChatMock).toHaveBeenCalledWith(
      llmConfig,
      [{ role: "user", content: expect.stringContaining("wiki quality analyst") }],
      expect.objectContaining({
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })

  it("builds a novel-mode prompt with chapter number and chapter content", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      expect(msgs[0].content).toContain("你是一个小说连贯性检查编辑")
      expect(msgs[0].content).toContain("CP:")
      expect(msgs[0].content).toContain("章节正文")
      callbacks.onDone()
    })
    await runSemanticLint("/P", llmConfig, { chapterContent: "  第三章正文  ", chapterNumber: 3 })
    expect(buildContextPackMock).toHaveBeenCalledWith("/P", "检查第3章", 3)
    expect(contextPackToPromptMock).toHaveBeenCalled()
  })

  it("uses a question-mark chapter placeholder when no chapter number is given", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onDone()
    })
    await runSemanticLint("/P", llmConfig, { chapterContent: "正文" })
    expect(buildContextPackMock).toHaveBeenCalledWith("/P", "检查第?章", undefined)
  })

  it("falls back to wiki mode in novel mode when chapter content is whitespace", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      expect(msgs[0].content).toContain("wiki quality analyst")
      callbacks.onDone()
    })
    await runSemanticLint("/P", llmConfig, { chapterContent: "   " })
    expect(buildContextPackMock).not.toHaveBeenCalled()
  })

  it("skips pages that fail to read and keeps the rest", async () => {
    fsState.listDirectory.mockResolvedValue([
      mdFile("broken.md", "/P/wiki/broken.md"),
      mdFile("ok.md", "/P/wiki/ok.md"),
    ])
    fsState.readFile.mockImplementation((p: string) =>
      p.endsWith("broken.md") ? Promise.reject(new Error("ENOENT")) : Promise.resolve("fine"),
    )
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      expect(msgs[0].content).toContain("### ok.md")
      expect(msgs[0].content).not.toContain("broken.md")
      callbacks.onDone()
    })
    await runSemanticLint("/P", llmConfig)
  })

  it("truncates long page previews to 500 chars with an ellipsis", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("long.md", "/P/wiki/long.md")])
    const longContent = "字".repeat(600)
    fsState.readFile.mockResolvedValue(longContent)
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      const prompt = msgs[0].content as string
      expect(prompt).toContain("### long.md")
      expect(prompt).toContain("字".repeat(500) + "...")
      expect(prompt).not.toContain("字".repeat(600))
      callbacks.onDone()
    })
    await runSemanticLint("/P", llmConfig)
  })

  it("redacts URLs and auth headers from LLM error messages", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("failed at https://api.openai.com/v1 with Bearer sk-secret"))
    })
    await expect(runSemanticLint("/P", llmConfig)).resolves.toEqual([])
    expect(lastActivity().status).toBe("error")
    expect(lastActivity().detail).toContain("[url]")
    expect(lastActivity().detail).toContain("[redacted]")
    expect(lastActivity().detail).not.toContain("sk-secret")
    errorSpy.mockRestore()
  })

  it("surfaces non-Error stream errors as strings", async () => {
    fsState.listDirectory.mockResolvedValue([mdFile("a.md", "/P/wiki/a.md")])
    fsState.readFile.mockResolvedValue("content")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError("plain failure")
    })
    await expect(runSemanticLint("/P", llmConfig)).resolves.toEqual([])
    expect(lastActivity().detail).toBe("LLM error: plain failure")
    errorSpy.mockRestore()
  })
})
