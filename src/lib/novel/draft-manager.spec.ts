/** C4 冒烟覆盖：src/lib/novel/draft-manager.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { acceptChapterDraft, formalChapterPathForDraft, listChapterDrafts, writeDraft, type DraftManagerDeps } from "./draft-manager"

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}))

// writeDraft/ensureDraftsDir 走真实 @/commands/fs（Tauri invoke），单元环境下
// 用内存实现替换六个命令；其余用例全部注入 memoryDeps，不受此 mock 影响。
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: async (path: string) => fsState.files.has(path) || fsState.dirs.has(path),
    createDirectory: async (path: string) => {
      fsState.dirs.add(path)
    },
    writeFile: async (path: string, contents: string) => {
      fsState.files.set(path, contents)
    },
    writeFileAtomic: async (path: string, contents: string) => {
      fsState.files.set(path, contents)
    },
    readFile: async (path: string) => {
      const text = fsState.files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    listDirectory: async (path: string) => {
      const prefix = `${path.replace(/\/$/, "")}/`
      const nodes: FileNode[] = []
      for (const key of fsState.files.keys()) {
        if (!key.startsWith(prefix)) continue
        const name = key.slice(prefix.length)
        if (!name || name.includes("/")) continue
        nodes.push({ name, path: key, is_dir: false })
      }
      return nodes
    },
  }
})

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

  it("采纳到既有正式章时保留原 frontmatter，只换正文", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const chapterFm = "---\ntype: chapter\nchapter_number: '8'\nchapter_status: final\ntitle: \"第08章 旧题\"\n---\n\n"
    files.set("C:/book/wiki/chapters/第01章.md", `${chapterFm}# 第01章\n\n旧正文。`)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    const written = files.get("C:/book/wiki/chapters/第01章.md") ?? ""
    expect(written.startsWith(chapterFm)).toBe(true)
    expect(written).toBe(`${chapterFm}# 第01章\n\n正文。`)
    expect(written).not.toContain("旧正文")
  })

  it("frontmatter 前带脏行时连前缀一起保留", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const preface = "这是 LLM 多写的一行\n"
    const chapterFm = "---\ntype: chapter\nchapter_number: '8'\nchapter_status: final\n---\n\n"
    files.set("C:/book/wiki/chapters/第01章.md", `${preface}${chapterFm}旧正文。`)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe(`${preface}${chapterFm}# 第01章\n\n正文。`)
  })

  it("既有正式章没有 frontmatter 时仍只写正文", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    files.set("C:/book/wiki/chapters/第01章.md", "旧正文。")

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe("# 第01章\n\n正文。")
  })

  it("目标章不存在时仍只写正文（既有行为不变）", async () => {    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe("# 第01章\n\n正文。")
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

describe("writeDraft（fs mock：目录创建两面 + 来源元数据两面）", () => {
  it("首次写入创建草稿目录并落盘来源元数据", async () => {
    fsState.files.clear()
    fsState.dirs.clear()
    const draft = await writeDraft("C:/book", "第01章", "正文。", {
      sourceConversationId: "c1",
      sourceMessageId: "m1",
    })
    expect(draft.id.startsWith("draft_")).toBe(true)
    expect(draft.chapterName).toBe("第01章")
    expect(draft.status).toBe("draft")
    expect(fsState.dirs.has("C:/book/.qm-drafts")).toBe(true)
    const stored = fsState.files.get(`C:/book/.qm-drafts/${draft.id}.md`) ?? ""
    expect(stored).toContain("source_conversation_id: c1")
    expect(stored).toContain("source_message_id: m1")
  })

  it("目录已存在时直接写入；无来源元数据则不写元数据行", async () => {
    fsState.files.clear()
    fsState.dirs.clear()
    fsState.dirs.add("C:/book/.qm-drafts")
    const draft = await writeDraft("C:/book", "第02章", "正文二。")
    expect(draft.sourceConversationId).toBeUndefined()
    const stored = fsState.files.get(`C:/book/.qm-drafts/${draft.id}.md`) ?? ""
    expect(stored).toContain("chapter_name: 第02章")
    expect(stored).not.toContain("source_conversation_id")
    expect(stored).not.toContain("source_message_id")
  })
})

describe("listChapterDrafts 解析容错（坏文件跳过 + 字段缺省）", () => {
  const BAD_STATUS = `---
draft_id: bad_1
chapter_name: 坏章
status: bogus
created_at: not-a-number
source_conversation_id: c1
source_message_id: m1
---

正文`

  function seedMixed() {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    files.set("C:/book/.qm-drafts/junk.md", "plain text without frontmatter")
    files.set("C:/book/.qm-drafts/nodraftid.md", "---\nchapter_name: 无名章\nstatus: draft\ncreated_at: 5\n---\n\n正文")
    files.set("C:/book/.qm-drafts/nochapter.md", "---\ndraft_id: no_ch\nstatus: draft\ncreated_at: 5\n---\n\n正文")
    files.set("C:/book/.qm-drafts/badstatus.md", BAD_STATUS)
    files.set("C:/book/.qm-drafts/notes.txt", "not a draft")
    return { files, deps }
  }

  it("坏文件被跳过：无 frontmatter/无章节名/非 md 均不进入列表", async () => {
    const { deps } = seedMixed()
    const listed = await listChapterDrafts("C:/book", deps)
    const ids = listed.map((d) => d.id).sort()
    // draft_1（有效）+ nodraftid（回退文件名）+ bad_1（字段容错）；junk/nochapter/notes.txt 出局
    expect(ids).toEqual(["bad_1", "draft_1", "nodraftid"])
  })

  it("缺字段回退：无 draft_id 用文件名；非法 status/created_at 回退默认值；来源 id 保留", async () => {
    const { deps } = seedMixed()
    const listed = await listChapterDrafts("C:/book", deps)
    const bad = listed.find((d) => d.id === "bad_1")!
    expect(bad.status).toBe("draft")
    expect(Number.isFinite(bad.createdAt)).toBe(true)
    expect(bad.sourceConversationId).toBe("c1")
    expect(bad.sourceMessageId).toBe("m1")
  })

  it("缺 status 行回退 draft（?? 右侧）", async () => {
    const { deps, files } = memoryDeps()
    files.set("C:/book/.qm-drafts/nostatus.md", "---\ndraft_id: ns_1\nchapter_name: 素章\ncreated_at: 5\n---\n\n正文")
    const listed = await listChapterDrafts("C:/book", deps)
    expect(listed.find((d) => d.id === "ns_1")?.status).toBe("draft")
  })

  it("selectedFile 为空回退默认正式章路径", () => {
    expect(formalChapterPathForDraft("C:/book", "第01章", null)).toBe(
      "C:/book/wiki/chapters/第01章.md",
    )
  })

  it("草稿目录不存在返回空数组", async () => {
    const { deps } = memoryDeps()
    await expect(listChapterDrafts("C:/empty", deps)).resolves.toEqual([])
  })

  it("节点 path 为空时回退 dir/name 拼接读取", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const pathless: DraftManagerDeps = {
      ...deps,
      listDirectory: async () => [{ name: "draft_1.md", path: "", is_dir: false }],
    }
    const listed = await listChapterDrafts("C:/book", pathless)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.content).toBe("# 第01章\n\n正文。")
  })
})

describe("acceptChapterDraft 守卫分支（confirmed 恒抛不断言之外）", () => {
  it("章节名洗空后抛错", () => {
    expect(() => formalChapterPathForDraft("C:/book", "///", null)).toThrow("草稿没有章节名")
  })

  it("项目根为空抛错", () => {
    expect(() => formalChapterPathForDraft("", "第01章", null)).toThrow("没有项目")
  })

  it("找不到草稿抛错", async () => {
    const { deps } = memoryDeps()
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "ghost",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: true,
    }, deps)).rejects.toThrow("找不到草稿")
  })

  it("草稿正文为空抛错", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/empty_1.md", "---\ndraft_id: empty_1\nchapter_name: 空章\nstatus: draft\ncreated_at: 1\n---\n\n   \n")
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "empty_1",
      formalChapterPath: "C:/book/正文/空章.md",
      confirmed: true,
    }, deps)).rejects.toThrow("草稿没有正文")
  })

  it("父目录已存在时直接写入（ensureParent 早退）", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    deps.fileExists = async (path) =>
      files.has(path) || path === "C:/book/.qm-drafts" || path === "C:/book/正文"
    const result = await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: true,
    }, deps)
    expect(result.formalChapterPath).toBe("C:/book/正文/第01章.md")
    expect(files.get("C:/book/正文/第01章.md")).toBe("# 第01章\n\n正文。")
  })

  it("祖父目录已存在时只建父目录", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const created: string[] = []
    const wrapped: DraftManagerDeps = {
      ...deps,
      fileExists: async (path) => files.has(path) || path === "C:/book/.qm-drafts" || path === "C:/book",
      createDirectory: async (path) => {
        created.push(path)
      },
    }
    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: true,
    }, wrapped)
    expect(created).toEqual(["C:/book/正文"])
  })

  it("写入后读回不一致抛错", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const target = "C:/book/正文/第01章.md"
    const tainted: DraftManagerDeps = {
      ...deps,
      readFile: async (path) => (path === target ? "被篡改的内容" : deps.readFile(path)),
    }
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: target,
      confirmed: true,
    }, tainted)).rejects.toThrow("读回不一致")
  })
})
