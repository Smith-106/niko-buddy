import { beforeEach, describe, it, expect, vi } from "vitest"
import { applyFileEdit } from "./agent-tools"
import type { FileEditAction } from "./agent-parser"

const draftMocks = vi.hoisted(() => ({
  writeDraft: vi.fn(),
  discardChapterDraft: vi.fn(),
}))

// Mock fs commands
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDirectory: vi.fn(),
  }
})

vi.mock("./draft-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./draft-manager")>()
  return {
    ...actual,
    writeDraft: draftMocks.writeDraft,
    discardChapterDraft: draftMocks.discardChapterDraft,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  let seq = 0
  draftMocks.writeDraft.mockImplementation(async (_pp: string, chapterName: string, content: string) => {
    seq += 1
    return {
      id: `draft_agent_${seq}`,
      chapterName,
      content,
      createdAt: 1,
      status: "draft",
    }
  })
  draftMocks.discardChapterDraft.mockResolvedValue(undefined)
})

describe("agent-tools applyFileEdit security", () => {
  it("should block path traversal with .. segments (ISS-20260731-001)", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "wiki/chapters/../../../../etc/passwd",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
    expect(result.error).toContain("..")
  })

  it("should block absolute paths", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "/etc/passwd",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should block Windows drive letters", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "C:\\Windows\\System32\\config\\SAM",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should block control characters", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "wiki/chapters/test\x00.md",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should route valid wiki/chapters/ paths through writeDraft with stripped frontmatter and zero writeFile calls", async () => {
    const validEdit: FileEditAction = {
      filePath: "wiki/chapters/chapter1.md",
      search: "old text",
      replace: "new text",
    }

    const { readFile, writeFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("---\ntype: chapter\nchapter_number: 1\n---\n\nThis is old text content")
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const result = await applyFileEdit("/project", validEdit)

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.routedToDraft).toBe(true)
    expect(result.draftId).toBe("draft_agent_1")
    expect(result.draftPath).toBe("/project/.qm-drafts/draft_agent_1.md")
    expect(writeFile).not.toHaveBeenCalled()
    expect(draftMocks.writeDraft).toHaveBeenCalledWith(
      "/project",
      "chapter1",
      "This is new text content",
      { sourceConversationId: "agent:file-edit" },
    )
  })

  it("should route valid QM/chapters/ paths through writeDraft and block traversal under QM/", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("旧段落")
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const okResult = await applyFileEdit("/project", {
      filePath: "QM/chapters/chapter-002.md",
      search: "旧段落",
      replace: "新段落",
    })
    expect(okResult.success).toBe(true)
    expect(okResult.routedToDraft).toBe(true)
    expect(okResult.draftId).toBe("draft_agent_1")
    expect(okResult.draftPath).toBe("/project/.qm-drafts/draft_agent_1.md")
    expect(writeFile).not.toHaveBeenCalled()
    expect(draftMocks.writeDraft).toHaveBeenCalledWith(
      "/project",
      "chapter-002",
      "新段落",
      { sourceConversationId: "agent:file-edit" },
    )

    const badResult = await applyFileEdit("/project", {
      filePath: "QM/chapters/../../etc/passwd",
      search: "a",
      replace: "b",
    })
    expect(badResult.success).toBe(false)
    expect(badResult.error).toContain("路径不安全")
  })

  it("should keep wiki/outlines/ on direct writeFile so outline chat continues working", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("# 大纲\n旧节点")
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const result = await applyFileEdit("/project", {
      filePath: "wiki/outlines/main.md",
      search: "旧节点",
      replace: "新节点",
    })
    expect(result.success).toBe(true)
    expect(result.routedToDraft).toBe(false)
    expect(result.draftId).toBeUndefined()
    expect(result.draftPath).toBeUndefined()
    expect(draftMocks.writeDraft).not.toHaveBeenCalled()
    expect(writeFile).toHaveBeenCalledWith("/project/wiki/outlines/main.md", "# 大纲\n新节点")
  })
})

describe("agent-tools listScopeFiles / readScopeFileContents", () => {
  it("lists only markdown files under the chapters scope", async () => {
    const { listDirectory } = await import("@/commands/fs")
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "a.md", path: "/p/wiki/chapters/a.md", is_dir: false },
      { name: "b.txt", path: "/p/wiki/chapters/b.txt", is_dir: false },
      { name: "sub", path: "/p/wiki/chapters/sub", is_dir: true },
    ])
    const { listScopeFiles } = await import("./agent-tools")
    const files = await listScopeFiles("/p", "chapters")
    expect(files).toEqual([{ name: "a.md", path: "/p/wiki/chapters/a.md" }])
  })

  it("lists outlines scope and returns [] when listing fails", async () => {
    const { listDirectory } = await import("@/commands/fs")
    vi.mocked(listDirectory).mockResolvedValue([{ name: "o1.md", path: "/p/wiki/outlines/o1.md", is_dir: false }])
    const { listScopeFiles } = await import("./agent-tools")
    expect(await listScopeFiles("/p", "outlines")).toEqual([{ name: "o1.md", path: "/p/wiki/outlines/o1.md" }])

    vi.mocked(listDirectory).mockRejectedValue(new Error("enoent"))
    expect(await listScopeFiles("/p", "chapters")).toEqual([])
  })

  it("readScopeFileContents reads within maxFiles and skips unreadable files", async () => {
    const { listDirectory, readFile } = await import("@/commands/fs")
    const files = Array.from({ length: 3 }, (_, i) => ({ name: `c${i}.md`, path: `/p/wiki/chapters/c${i}.md`, is_dir: false }))
    vi.mocked(listDirectory).mockResolvedValue(files)
    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (String(path).endsWith("c1.md")) throw new Error("locked")
      return `内容${String(path).match(/c(\d)\.md$/)?.[1]}`
    })
    const { readScopeFileContents } = await import("./agent-tools")
    const results = await readScopeFileContents("/p", "chapters", 2)
    expect(results).toEqual([
      { name: "c0.md", path: "/p/wiki/chapters/c0.md", content: "内容0" },
      // c1 读取失败被跳过
    ])
    // slice(0, 2)：c2 未被读取
    expect(results.length).toBe(1)
  })
})

describe("agent-tools applyFileEdit success/error paths", () => {
  it("rejects paths outside wiki/chapters or wiki/outlines", async () => {
    const edit: FileEditAction = { filePath: "wiki/other/notes.md", search: "a", replace: "b" }
    const { applyFileEdit } = await import("./agent-tools")
    const result = await applyFileEdit("/project", edit)
    expect(result.success).toBe(false)
    expect(result.error).toContain("只能修改")
  })

  it("returns not-found error with original content when search misses", async () => {
    const { readFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("no match here")
    const edit: FileEditAction = { filePath: "wiki/chapters/c.md", search: "ghost", replace: "x" }
    const { applyFileEdit } = await import("./agent-tools")
    const result = await applyFileEdit("/project", edit)
    expect(result.success).toBe(false)
    expect(result.error).toContain("未找到")
    expect(result.originalContent).toBe("no match here")
  })

  it("uses the filePath directly when it already starts with the project path (empty projectPath)", async () => {
    const edit: FileEditAction = { filePath: "wiki/chapters/c.md", search: "old", replace: "new" }
    const { applyFileEdit } = await import("./agent-tools")
    const result = await applyFileEdit("", edit)
    // startsWith("") 为 true，直接使用 edit.filePath，不再拼接 projectPath；
    // 但裸 "wiki/..." 路径不含 "/wiki/chapters/"（前导斜杠），故命中双重防御错误
    expect(result.success).toBe(false)
    expect(result.error).toContain("只能修改")
  })

  it("propagates read errors with Error or non-Error messages", async () => {
    const { readFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockRejectedValue(new Error("io fail"))
    const edit: FileEditAction = { filePath: "wiki/chapters/c.md", search: "a", replace: "b" }
    const { applyFileEdit } = await import("./agent-tools")
    const result = await applyFileEdit("/project", edit)
    expect(result.success).toBe(false)
    expect(result.error).toBe("io fail")

    vi.mocked(readFile).mockRejectedValue({ code: "EACCES" })
    const result2 = await applyFileEdit("/project", edit)
    expect(result2.success).toBe(false)
    expect(result2.error).toBe("[object Object]")
  })
})

describe("agent-tools applyFileEdits / undoFileEdit", () => {
  it("applies multiple edits sequentially", async () => {
    const { readFile, writeFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("old")
    vi.mocked(writeFile).mockResolvedValue(undefined)
    const edits: FileEditAction[] = [
      { filePath: "wiki/chapters/c.md", search: "old", replace: "new" },
      { filePath: "wiki/chapters/d.md", search: "old", replace: "new" },
      { filePath: "wiki/other/x.md", search: "old", replace: "new" },
    ]
    const { applyFileEdits } = await import("./agent-tools")
    const results = await applyFileEdits("/project", edits)
    expect(results).toHaveLength(3)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(true)
    expect(results[2].success).toBe(false)
  })

  it("undoFileEdit restores original content on non-draft success", async () => {
    const { writeFile } = await import("@/commands/fs")
    vi.mocked(writeFile).mockResolvedValue(undefined)
    const { undoFileEdit } = await import("./agent-tools")
    expect(await undoFileEdit({ filePath: "/p/wiki/outlines/x.md", success: true, originalContent: "原始", routedToDraft: false })).toBe(true)
    expect(writeFile).toHaveBeenCalledWith("/p/wiki/outlines/x.md", "原始")
  })

  it("undoFileEdit discards draft and NEVER overwrites formal chapters when routedToDraft is true", async () => {
    const { writeFile } = await import("@/commands/fs")
    vi.mocked(writeFile).mockResolvedValue(undefined)
    const { undoFileEdit } = await import("./agent-tools")

    // With projectPath + draftId: discards draft, zero writeFile calls
    const ok = await undoFileEdit(
      {
        filePath: "wiki/chapters/chapter-001.md",
        success: true,
        originalContent: "正式章原文",
        routedToDraft: true,
        draftId: "draft_agent_9",
        draftPath: "/project/.qm-drafts/draft_agent_9.md",
      },
      "/project",
    )
    expect(ok).toBe(true)
    expect(draftMocks.discardChapterDraft).toHaveBeenCalledWith("/project", "draft_agent_9")
    expect(writeFile).not.toHaveBeenCalled()

    // Without projectPath or draftId: refuses and returns false, zero writeFile calls
    expect(
      await undoFileEdit({
        filePath: "wiki/chapters/chapter-001.md",
        success: true,
        originalContent: "正式章原文",
        routedToDraft: true,
        draftId: "draft_agent_9",
      }),
    ).toBe(false)
    expect(
      await undoFileEdit(
        {
          filePath: "wiki/chapters/chapter-001.md",
          success: true,
          originalContent: "正式章原文",
          routedToDraft: true,
        },
        "/project",
      ),
    ).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()

    // If discard fails: returns false, zero writeFile calls
    draftMocks.discardChapterDraft.mockRejectedValueOnce(new Error("discard failed"))
    expect(
      await undoFileEdit(
        {
          filePath: "wiki/chapters/chapter-001.md",
          success: true,
          routedToDraft: true,
          draftId: "draft_agent_9",
        },
        "/project",
      ),
    ).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("undoFileEdit returns false when not successful or no original content", async () => {
    const { undoFileEdit } = await import("./agent-tools")
    expect(await undoFileEdit({ filePath: "/p/x.md", success: false, originalContent: "原始" })).toBe(false)
    expect(await undoFileEdit({ filePath: "/p/x.md", success: true })).toBe(false)
  })

  it("undoFileEdit returns false when the write fails", async () => {
    const { writeFile } = await import("@/commands/fs")
    vi.mocked(writeFile).mockRejectedValue(new Error("locked"))
    const { undoFileEdit } = await import("./agent-tools")
    expect(await undoFileEdit({ filePath: "/p/x.md", success: true, originalContent: "原始" })).toBe(false)
  })
})
