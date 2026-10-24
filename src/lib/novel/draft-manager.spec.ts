/** C4 冒烟覆盖：src/lib/novel/draft-manager.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { acceptChapterDraft, formalChapterPathForDraft, listChapterDrafts, writeDraft, type DraftManagerDeps } from "./draft-manager"

function memoryDeps() {
  const files = new Map<string, string>()
  const dirs = new Set<string>(["C:/book/.qm-drafts"])
  const deps: DraftManagerDeps = {
    fileExists: async (path) => files.has(path) || dirs.has(path),
    createDirectory: async (path) => {
      dirs.add(path)
    },
    writeFile: async (path, contents) => {
      files.set(path, contents)
    },
    writeFileAtomic: async (path, contents) => {
      files.set(path, contents)
    },
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error("missing")
      return text
    },
    listDirectory: async (path) => {
      const prefix = `${path.replace(/\/$/, "")}/`
      const nodes: FileNode[] = []
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const name = key.slice(prefix.length)
        if (!name || name.includes("/")) continue
        nodes.push({ name, path: key, is_dir: false })
      }
      return nodes
    },
  }
  return { files, deps }
}

const STORED = `---
draft_id: draft_1
chapter_name: 第01章
status: draft
created_at: 10
---

# 第01章

正文。`

describe("draft-manager.ts smoke", () => {
  it("exports writeDraft", () => {
    expect(writeDraft).toBeDefined()
  })
})

describe("acceptChapterDraft", () => {
  it("未确认不写正式章", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    deps.writeFileAtomic = vi.fn(deps.writeFileAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: false,
    }, deps)).rejects.toThrow("必须先确认")
    expect(deps.writeFileAtomic).not.toHaveBeenCalled()
    expect(files.has("C:/book/正文/第01章.md")).toBe(false)
  })

  it("确认后把草稿正文写入正式章，并标成已采纳", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const listed = await listChapterDrafts("C:/book", deps)
    expect(listed[0]?.content).toBe("# 第01章\n\n正文。")
    expect(formalChapterPathForDraft("C:/book", "第01章", "C:/book/正文/第01章.md")).toBe("C:/book/正文/第01章.md")
    expect(formalChapterPathForDraft("C:/book", "第02章", "C:/book/正文/第01章.md")).toBe("C:/book/wiki/chapters/第02章.md")

    const result = await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: true,
    }, deps)
    expect(result.formalChapterPath).toBe("C:/book/正文/第01章.md")
    expect(files.get("C:/book/正文/第01章.md")).toBe("# 第01章\n\n正文。")
    expect(files.get("C:/book/.qm-drafts/draft_1.md")).toContain("status: saved")
  })

  it("拒绝写到这本书外面", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/other/第01章.md",
      confirmed: true,
    }, deps)).rejects.toThrow("必须写在这本书里")
    expect(files.has("C:/other/第01章.md")).toBe(false)
  })
})
