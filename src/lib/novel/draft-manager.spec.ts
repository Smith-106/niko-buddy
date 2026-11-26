/** C4 冒烟覆盖：src/lib/novel/draft-manager.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { acceptDraftAndIngest } from "./accept-draft-with-ingest"
import { ingestChapter } from "./chapter-ingest"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { acceptChapterDraft, discardChapterDraft, draftNeedsGateReview, formalChapterPathForDraft, getDraftGateStatus, listChapterDrafts, recordDraftAdoptionGate, writeDraft, type DraftManagerDeps } from "./draft-manager"

vi.mock("./chapter-ingest", () => ({ ingestChapter: vi.fn() }))

const fsState = vi.hoisted(() => {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    writeFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, contents)
    }),
    writeFileAtomic: vi.fn(async (path: string, contents: string) => {
      files.set(path, contents)
    }),
  }
})

function asBase64(text: string) {
  return { base64: Buffer.from(text, "utf8").toString("base64"), mimeType: "text/markdown" }
}

// 默认命令和显式注入都仅操作内存，不调用 Tauri。
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: async (path: string) => fsState.files.has(path) || fsState.dirs.has(path),
    createDirectory: async (path: string) => {
      fsState.dirs.add(path)
    },
    writeFile: fsState.writeFile,
    writeFileAtomic: fsState.writeFileAtomic,
    readFile: async (path: string) => {
      const text = fsState.files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    readFileAsBase64: async (path: string) => {
      const text = fsState.files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return asBase64(text)
    },
    writeFilesAtomic: async (batch: Array<[string, string]>) => {
      for (const [path, contents] of batch) fsState.files.set(path, contents)
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
  const deps = {
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
    readFileAsBase64: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error("missing")
      return asBase64(text)
    },
    writeFilesAtomic: async (batch, expectedContents) => {
      if (expectedContents !== undefined) {
        for (const [index, [path]] of batch.entries()) {
          const current = files.has(path) ? files.get(path)! : null
          if (current !== expectedContents[index]) {
            throw new Error(`Batch target '${path}' changed before staging; left untouched`)
          }
        }
      }
      for (const [path, contents] of batch) files.set(path, contents)
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
  } satisfies DraftManagerDeps
  return { files, deps }
}

const DRAFT_PATH = "C:/book/.qm-drafts/draft_1.md"

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

  it("partial 草稿写入 frontmatter 并能读回", async () => {
    const written = await writeDraft("C:/book", "第02章", "截断正文", { partial: true })
    expect(written.partial).toBe(true)
    // 内存返回值与落盘 parse 后的 gate 一致：partial 草稿立即带 partial 门。
    expect(written.adoptionGate).toEqual({ status: "partial" })
    expect(fsState.files.get(`C:/book/.qm-drafts/${written.id}.md`)).toContain("partial: true")

    const listed = await listChapterDrafts("C:/book")
    const reread = listed.find((item) => item.id === written.id)
    expect(reread?.partial).toBe(true)
    expect(reread?.adoptionGate).toEqual({ status: "partial" })
  })

  it("完整草稿不写 partial 行，读回也没有该标记", async () => {
    const written = await writeDraft("C:/book", "第03章", "完整正文")
    const raw = fsState.files.get(`C:/book/.qm-drafts/${written.id}.md`) ?? ""
    expect(raw).not.toContain("partial:")

    const listed = await listChapterDrafts("C:/book")
    expect(listed.find((item) => item.id === written.id)?.partial).toBeUndefined()
  })
})

describe("acceptChapterDraft", () => {
  it("未确认不写正式章", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    deps.writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/正文/第01章.md",
      confirmed: false,
    }, deps)).rejects.toThrow("必须先确认")
    expect(deps.writeFilesAtomic).not.toHaveBeenCalled()
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
    expect(files.get("C:/book/正文/第01章.md")).toBe("---\ntype: chapter\nchapter_number: 1\nchapter_status: final\ntitle: \"第01章\"\n---\n\n# 第01章\n\n正文。")
    expect(files.get("C:/book/.qm-drafts/draft_1.md")).toContain("status: saved")
  })

  it("采纳到既有正式章时保留原 frontmatter，只换正文", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const chapterFm = "---\ntype: chapter\nchapter_number: '1'\nchapter_status: final\ntitle: \"第08章 旧题\"\n---\n\n"
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

  it("普通编号草稿落到号不匹配的既有正式章：拒绝且不写盘", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const otherChapter = "---\ntype: chapter\nchapter_number: '8'\nchapter_status: final\n---\n\n旧正文。"
    files.set("C:/book/wiki/chapters/第08章.md", otherChapter)

    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第08章.md",
      confirmed: true,
    }, deps)).rejects.toThrow()
    expect(files.get("C:/book/wiki/chapters/第08章.md")).toBe(otherChapter)
    expect(files.get("C:/book/.qm-drafts/draft_1.md")).toBe(STORED)
  })

  it("frontmatter 前带脏行时连前缀一起保留", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    const preface = "这是 LLM 多写的一行\n"
    const chapterFm = "---\ntype: chapter\nchapter_number: '1'\nchapter_status: final\n---\n\n"
    files.set("C:/book/wiki/chapters/第01章.md", `${preface}${chapterFm}旧正文。`)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe(`${preface}${chapterFm}# 第01章\n\n正文。`)
  })

  it("既有正式章没有 frontmatter 时自动补齐规范章节 frontmatter", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    files.set("C:/book/wiki/chapters/第01章.md", "旧正文。")

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe(
      "---\ntype: chapter\nchapter_number: 1\nchapter_status: final\ntitle: \"第01章\"\n---\n\n# 第01章\n\n正文。",
    )
  })

  it("既有正式章含 BOM 且无 frontmatter 时保留 BOM 并补齐规范 frontmatter；非章节路径保持裸正文", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)
    files.set("C:/book/wiki/chapters/第01章.md", "\uFEFF旧正文。")

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe(
      "\uFEFF---\ntype: chapter\nchapter_number: 1\nchapter_status: final\ntitle: \"第01章\"\n---\n\n# 第01章\n\n正文。",
    )

    // 非章节普通路径无 frontmatter 时保持原样写裸正文
    files.set("C:/book/.qm-drafts/draft_2.md", STORED.replace("draft_1", "draft_2"))
    files.set("C:/book/wiki/notes/第01章.md", "普通笔记旧正文。")
    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_2",
      formalChapterPath: "C:/book/wiki/notes/第01章.md",
      confirmed: true,
    }, deps)
    expect(files.get("C:/book/wiki/notes/第01章.md")).toBe("# 第01章\n\n正文。")
  })

  it("目标章不存在且章号可解析时注入 final 章节 frontmatter", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", STORED)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: "C:/book/wiki/chapters/第01章.md",
      confirmed: true,
    }, deps)

    expect(files.get("C:/book/wiki/chapters/第01章.md")).toBe("---\ntype: chapter\nchapter_number: 1\nchapter_status: final\ntitle: \"第01章\"\n---\n\n# 第01章\n\n正文。")
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

  it.each(["C:/book/wiki/../第01章.md", "C:/book/正文/第01章.txt", "C:/book/正文/.md"])("拒绝不可用的普通草稿落点 %s", async (target) => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1", formalChapterPath: target, confirmed: true,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow()
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(DRAFT_PATH)).toBe(STORED)
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
    expect(draft.chapterName).toBe("第02章")
    expect(stored).not.toContain("source_conversation_id")
    expect(stored).not.toContain("source_message_id")
  })

  it("writeDraft 走 writeFileAtomic 原子落盘，不调用非原子 writeFile", async () => {
    fsState.files.clear()
    fsState.dirs.clear()
    fsState.writeFile.mockClear()
    fsState.writeFileAtomic.mockClear()
    const draft = await writeDraft("C:/book", "第04章", "原子草稿正文。")
    const expectedPath = `C:/book/.qm-drafts/${draft.id}.md`
    expect(fsState.writeFile).not.toHaveBeenCalled()
    expect(fsState.writeFileAtomic).toHaveBeenCalledExactlyOnceWith(
      expectedPath,
      fsState.files.get(expectedPath),
    )
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
    files.set("C:/book/.qm-drafts/bad_1.md", BAD_STATUS)
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
    files.set("C:/book/.qm-drafts/ns_1.md", "---\ndraft_id: ns_1\nchapter_name: 素章\ncreated_at: 5\n---\n\n正文")
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

  it("只读 .qm-drafts 的直接文件项，文件名与 frontmatter ID 必须相符", async () => {
    const { files, deps } = memoryDeps()
    const mislabeled = "C:/book/.qm-drafts/mislabeled.md"
    files.set(DRAFT_PATH, STORED)
    files.set(mislabeled, STORED)
    const readFileAsBase64 = vi.fn(deps.readFileAsBase64)
    const listed = await listChapterDrafts("C:/book", {
      ...deps,
      readFileAsBase64,
      listDirectory: async () => [
        { name: "draft_1.md", path: DRAFT_PATH, is_dir: false },
        { name: "mislabeled.md", path: mislabeled, is_dir: false },
        { name: "foreign.md", path: "C:/other/foreign.md", is_dir: false },
        { name: "nested.md", path: "C:/book/.qm-drafts/nested/nested.md", is_dir: false },
        { name: "../outside.md", path: "", is_dir: false },
        { name: "folder.md", path: "C:/book/.qm-drafts/folder.md", is_dir: true },
      ],
    })
    expect(listed.map((draft) => draft.id)).toEqual(["draft_1"])
    expect(readFileAsBase64.mock.calls).toEqual([[DRAFT_PATH], [mislabeled]])
  })

  it("门控草稿路径只复用同章的 wiki 或 QM 直属章节", () => {
    for (const dir of ["wiki", "QM"]) {
      const selected = `C:/book/${dir}/chapters/chapter-001.md`
      expect(formalChapterPathForDraft("C:/book", "第01章", selected, true)).toBe(selected)
    }
    for (const selected of ["C:/book/正文/第01章.md", "C:/book/wiki/chapters/第02章.md", "C:/book/wiki/chapters/场景/第01章.md"]) {
      expect(formalChapterPathForDraft("C:/book", "第01章", selected, true))
        .toBe("C:/book/wiki/chapters/chapter-001.md")
    }
    expect(() => formalChapterPathForDraft("C:/book", "旧题", null, true)).toThrow("未绑定章号")
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
    expect(files.get("C:/book/正文/第01章.md")).toBe("---\ntype: chapter\nchapter_number: 1\nchapter_status: final\ntitle: \"第01章\"\n---\n\n# 第01章\n\n正文。")
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

  it("原生批次失败原样上抛，不报告采纳、不走单文件补写或 ingest", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED.replace("status: draft\n", "source_conversation_id: mcp:deep-chapter\nstatus: draft\n"))
    const [draft] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", draft, "passed", deps)
    const originalDraft = files.get(DRAFT_PATH)
    const target = "C:/book/wiki/chapters/第01章.md"
    files.set(target, "旧正文")
    const failure = new Error("native batch readback verification failed")
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic).mockRejectedValueOnce(failure)
    const tainted: DraftManagerDeps = {
      ...deps,
      writeFilesAtomic,
      writeFile: vi.fn(deps.writeFile),
      writeFileAtomic: vi.fn(deps.writeFileAtomic),
    }
    const { llmConfig, novelConfig } = useWikiStore.getState()
    await expect(acceptDraftAndIngest({
      projectPath: "C:/book",
      formalChapterPath: target,
      novelConfig: { ...novelConfig, autoIngestOnSave: true },
      llmConfig: { ...llmConfig, provider: "openai", apiKey: "mock", model: "mock" },
      accept: async (formalChapterPath) => {
        await acceptChapterDraft({ projectPath: "C:/book", draftId: "draft_1", formalChapterPath, confirmed: true }, tainted)
      },
    })).rejects.toBe(failure)
    expect(writeFilesAtomic.mock.calls[0][0].map(([path]) => path)).toEqual([target, DRAFT_PATH])
    expect(tainted.writeFile).not.toHaveBeenCalled()
    expect(tainted.writeFileAtomic).not.toHaveBeenCalled()
    expect(files.get(target)).toBe("旧正文")
    expect(files.get(DRAFT_PATH)).toBe(originalDraft)
    expect(ingestChapter).not.toHaveBeenCalled()
  })

  it("只在锁内读取请求 ID 的文件，不扫描草稿目录", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED)
    const listDirectory = vi.fn(deps.listDirectory).mockRejectedValueOnce(new Error("unrelated entry is unreadable"))
    const readFileAsBase64 = vi.fn(deps.readFileAsBase64)
    const target = "C:/book/正文/第01章.md"
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1", formalChapterPath: target, confirmed: true,
    }, { ...deps, listDirectory, readFileAsBase64 })).resolves.toEqual({ formalChapterPath: target })
    expect(listDirectory).not.toHaveBeenCalled()
    expect(readFileAsBase64.mock.calls).toEqual([[DRAFT_PATH]])
  })

  it("请求文件中的 ID 不同，不能写正式章或更新任一草稿", async () => {
    const { files, deps } = memoryDeps()
    const wrongId = STORED.replace("draft_1", "draft_2")
    files.set(DRAFT_PATH, wrongId)
    files.set("C:/book/.qm-drafts/draft_2.md", wrongId)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    const target = "C:/book/正文/第01章.md"
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1", formalChapterPath: target, confirmed: true,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow("找不到草稿")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(DRAFT_PATH)).toBe(wrongId)
    expect(files.has(target)).toBe(false)
  })

  it("已有目标不是 UTF-8 时不以有损解码内容覆盖它", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED)
    const target = "C:/book/正文/第01章.md"
    files.set(target, "占位以模拟目标存在")
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1", formalChapterPath: target,
      confirmed: true,
    }, {
      ...deps,
      writeFilesAtomic,
      readFileAsBase64: (path) => path === target
        ? Promise.resolve({ base64: Buffer.from([0xff]).toString("base64"), mimeType: "text/markdown" })
        : deps.readFileAsBase64(path),
    })).rejects.toThrow()
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(DRAFT_PATH)).toBe(STORED)
  })
})

describe("draft adoption gate (A01)", () => {
  const TARGET = "C:/book/wiki/chapters/第01章.md"
  const MCP_STORED = `---
draft_id: draft_1
chapter_name: 第01章
status: draft
created_at: 10
source_conversation_id: mcp:external-agent
---

# 第01章

正文。`

  it("既有非 final 正式章表头在普通采纳时自动升级为 final（保留 BOM/CRLF/引号/注释），非章节普通页原样保留", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED.replace("mcp:external-agent", "mcp:chapter.write"))
    const header = "\uFEFF---\r\ntype: chapter\r\nchapter_number: '1'\r\nchapter_status: 'draft' # 保留备注\r\n---\r\n\r\n"
    files.set(TARGET, `${header}旧正文。`)
    await acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: TARGET, confirmed: true,
    }, deps)
    expect(files.get(TARGET)).toBe(`${header.replace("'draft'", "'final'")}# 第01章\n\n正文。`)

    // 非章节普通页（无 type: chapter 且无 chapter_number）保持原 frontmatter 不升级
    const noteTarget = "C:/book/wiki/notes/随笔.md"
    const noteHeader = "---\ntype: note\ntitle: \"随笔\"\n---\n\n"
    files.set("C:/book/.qm-drafts/draft_note.md", "---\ndraft_id: draft_note\nchapter_name: 随笔\nstatus: draft\ncreated_at: 10\n---\n\n新随笔正文。")
    files.set(noteTarget, `${noteHeader}旧随笔。`)
    await acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_note",
      formalChapterPath: noteTarget, confirmed: true,
    }, deps)
    expect(files.get(noteTarget)).toBe(`${noteHeader}新随笔正文。`)
  })

  it("绑定草稿章号与既有目标正整数章号不一致时拒绝且目标不变", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED)
    const drafts = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", drafts[0], "passed", deps)
    const existing = "---\ntype: chapter\nchapter_number: '2'\nchapter_status: final\n---\n\n旧正文。"
    files.set(TARGET, existing)
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: TARGET, confirmed: true,
    }, deps)).rejects.toThrow()
    expect(files.get(TARGET)).toBe(existing)
  })

  it.each([
    ["分层目录之外", "C:/book/wiki/memory/chapter-001.md", 1, "direct chapter file"],
    ["非直属章节", "C:/book/wiki/chapters/nested/chapter-001.md", 1, "direct chapter file"],
    ["文件名与表头冲突", "C:/book/QM/chapters/chapter-002.md", 1, "草稿与目标章节号不一致"],
    ["无效规范文件名被表头掩盖", "C:/book/QM/chapters/chapter-9007199254740992.md", 1, "草稿与目标章节号不一致"],
    ["表头未绑定章号", "C:/book/QM/chapters/chapter-001.md", undefined, "草稿与目标章节号不一致"],
    ["文件名和表头都没有身份", "C:/book/wiki/chapters/旧题.md", undefined, "草稿与目标章节号不一致"],
  ] as const)("门控草稿拒绝 %s", async (_label, target, chapterNumber, error) => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", draft, "passed", deps)
    const originalDraft = files.get(DRAFT_PATH)
    const originalTarget = `---\ntype: chapter\n${chapterNumber ? `chapter_number: ${chapterNumber}\n` : ""}---\n\n旧文`
    files.set(target, originalTarget)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: draft.id, formalChapterPath: target, confirmed: true,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow(error)
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(target)).toBe(originalTarget)
    expect(files.get(DRAFT_PATH)).toBe(originalDraft)
  })

  it("mcp 草稿无回执时 confirmed 采纳在正式写入前被拒", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)

    const drafts = await listChapterDrafts("C:/book", deps)
    expect(drafts[0].adoptionGate).toEqual({ status: "unassessed" })
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: TARGET, confirmed: true,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow()
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(TARGET)).toBeUndefined()
  })

  it("旧版 CRLF 草稿复核原样后，仅显式确认才提交原文及既有计划章的 final 表头", async () => {
    const { files, deps } = memoryDeps()
    const body = "\r\n\r\n  第一行  \r\n第二行\r\n"
    const legacy = `\uFEFF${MCP_STORED.slice(0, MCP_STORED.indexOf("# 第01章")).replace(/\n/g, "\r\n")}${body}`
    const target = "C:/book/QM/chapters/chapter-001.md"
    const header = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 1\r\nchapter_status: 'planned' # 保留备注\r\ntitle: \"旧题\"\r\n---\r\n\r\n"
    const original = `${header}# 旧章骨架\r\n`
    files.set(DRAFT_PATH, legacy)
    files.set(target, original)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    const readFileAsBase64 = vi.fn(deps.readFileAsBase64)
    const verifiedDeps = { ...deps, writeFilesAtomic, readFileAsBase64 }
    const drafts = await listChapterDrafts("C:/book", deps)
    expect(drafts[0].content).toBe(body)
    expect(drafts[0].adoptionGate).toEqual({ status: "unassessed" })
    await recordDraftAdoptionGate("C:/book", drafts[0], "passed", deps)
    expect(files.get(DRAFT_PATH)).toContain("adoption_gate: passed")
    expect(files.get(DRAFT_PATH)).toContain("reviewed_body_sha256:")
    const reviewedDraft = files.get(DRAFT_PATH)

    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: target, confirmed: false,
    }, verifiedDeps)).rejects.toThrow("采纳草稿必须先确认")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(target)).toBe(original)

    const result = await acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: "C:\\book\\QM\\chapters\\chapter-001.md", confirmed: true,
      expectedDraftContent: drafts[0].content,
    }, verifiedDeps)
    expect(result.formalChapterPath).toBe(target)
    expect(readFileAsBase64.mock.calls).toEqual([[DRAFT_PATH], [target]])
    const nextFormal = `${header.replace("'planned'", "'final'")}${body}`
    expect(writeFilesAtomic).toHaveBeenCalledExactlyOnceWith([
      [target, nextFormal],
      [DRAFT_PATH, expect.stringContaining(`status: saved\n`)],
    ], [original, reviewedDraft])
    expect(files.get(target)).toBe(nextFormal)
    expect((await listChapterDrafts("C:/book", deps))[0]).toMatchObject({ content: body, status: "saved" })
  })

  it.each([
    ["正文", "正文。", "编辑后的正文。"],
    ["同一章号的标签", '"第01章"', '"第01章 修订标题"'],
  ])("回执后%s被改动 → passed 降级 unassessed，confirmed 仍被拒", async (_field, before, after) => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED)
    const drafts = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", drafts[0], "passed", deps)

    const modified = files.get(DRAFT_PATH)!.replace(before, after)
    files.set(DRAFT_PATH, modified)
    const reread = await listChapterDrafts("C:/book", deps)
    expect(reread[0].adoptionGate).toEqual({ status: "unassessed" })
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: TARGET, confirmed: true,
      expectedDraftContent: reread[0].content,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow()
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(TARGET)).toBeUndefined()
    expect(files.get(DRAFT_PATH)).toBe(modified)
  })

  it("内容变化后的陈旧复核无法持久化回执", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED)
    const listed = await listChapterDrafts("C:/book", deps)
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED.replace("正文。", "已改写的正文。"))
    await expect(recordDraftAdoptionGate("C:/book", listed[0], "passed", deps))
      .rejects.toThrow("Draft changed during review; run the checks again")
    expect(files.get("C:/book/.qm-drafts/draft_1.md")).toContain("已改写的正文。")
    expect(files.get("C:/book/.qm-drafts/draft_1.md")).not.toContain("adoption_gate: passed")
  })

  it.each(["partial: true", "adoption_gate: blocked"])("同一正文收到新元数据 %s 后拒绝旧复核", async (metadata) => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    const modified = MCP_STORED.replace("mcp:external-agent\n", `mcp:external-agent\n${metadata}\n`)
    files.set(DRAFT_PATH, modified)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", { ...deps, writeFilesAtomic }))
      .rejects.toThrow("Draft changed during review")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(DRAFT_PATH)).toBe(modified)
  })

  it("旧版未编号托管草稿的摘要即使匹配，也不能恢复或重新写入 passed", async () => {
    const { files, deps } = memoryDeps()
    const name = "续写当前故事"
    const body = "# 第01章\n\n正文。"
    const digest = await computeCheckpointDigest(JSON.stringify([name, body]))
    const unknown = MCP_STORED.replace("chapter_name: 第01章", `chapter_name: ${name}`)
      .replace("mcp:external-agent\n", `mcp:external-agent\nadoption_gate: passed\nreviewed_body_sha256: ${digest}\n`)
    files.set(DRAFT_PATH, unknown)
    const [draft] = await listChapterDrafts("C:/book", deps)
    expect(draft.adoptionGate).toEqual({ status: "unassessed" })
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", { ...deps, writeFilesAtomic }))
      .rejects.toThrow("未绑定章号")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    await expect(acceptChapterDraft({
      projectPath: "C:/book", draftId: draft.id, formalChapterPath: TARGET, confirmed: true,
    }, deps)).rejects.toThrow("未绑定章号")
    expect(files.get(DRAFT_PATH)).toBe(unknown)
    expect(files.has(TARGET)).toBe(false)
  })

  it("截断标记盖过 passed，不能为截断稿写通过回执", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [before] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", before, "passed", deps)
    const partial = files.get(DRAFT_PATH)!.replace("mcp:external-agent\n", "mcp:external-agent\npartial: true\n")
    files.set(DRAFT_PATH, partial)
    const [draft] = await listChapterDrafts("C:/book", deps)
    expect(draft.adoptionGate).toEqual({ status: "partial" })
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", { ...deps, writeFilesAtomic })).rejects.toThrow()
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(DRAFT_PATH)).toBe(partial)
  })

  it("单文件回执读回不一致时复核可见失败", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    const writeFilesAtomic = vi.fn(async () => undefined)
    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", { ...deps, writeFilesAtomic }))
      .rejects.toThrow("Could not verify the draft review receipt")
    expect(writeFilesAtomic).toHaveBeenCalledExactlyOnceWith(
      [[DRAFT_PATH, expect.stringContaining("adoption_gate: passed")]],
      [MCP_STORED],
    )
    expect(files.get(DRAFT_PATH)).toBe(MCP_STORED)
  })

  it("mcp:chapter.write 无回执绑定 — 普通草稿照旧可采纳", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_1.md", MCP_STORED.replace("mcp:external-agent", "mcp:chapter.write"))
    const drafts = await listChapterDrafts("C:/book", deps)
    expect(drafts[0].adoptionGate).toBeUndefined()
    const result = await acceptChapterDraft({
      projectPath: "C:/book", draftId: "draft_1",
      formalChapterPath: TARGET, confirmed: true,
    }, deps)
    expect(result.formalChapterPath).toBe(TARGET)
    expect(files.get(TARGET)).toContain("正文。")
  })
  it("passed 回执绑定章节名+正文原样（含前导空白），任一侧改动即降级", async () => {
    fsState.files.clear()
    fsState.dirs.clear()
    const body = "\r\n\r\n  Drizzle  \n\r\n"
    const draft = await writeDraft("C:/book", "第09章", body, {
      sourceConversationId: "mcp:deep-chapter",
      adoptionGate: "passed",
    })
    const stored = fsState.files.get(`C:/book/.qm-drafts/${draft.id}.md`)!
    expect(stored).toContain("adoption_gate: passed")
    const listed = await listChapterDrafts("C:/book")
    const found = listed.find((d) => d.id === draft.id)!
    expect(found.content).toBe(body)
    expect(found.adoptionGate?.status).toBe("passed")

    // 章节名改动 ⇒ 摘要不匹配 ⇒ 降级 unassessed
    fsState.files.set(`C:/book/.qm-drafts/${draft.id}.md`, stored.replace('"第09章"', '"第09章 "'))
    expect((await listChapterDrafts("C:/book")).find((d) => d.id === draft.id)!.adoptionGate?.status).toBe("unassessed")

    // 正文改动 ⇒ 同样降级
    fsState.files.set(`C:/book/.qm-drafts/${draft.id}.md`, stored.replace("Drizzle", "Drizzle!"))
    expect((await listChapterDrafts("C:/book")).find((d) => d.id === draft.id)!.adoptionGate?.status).toBe("unassessed")
  })

  it.each(["续写", "第0章", "第9007199254740992章"])("写入器不为非安全显式章号 %s 签发 passed", async (name) => {
    const draft = await writeDraft("C:/book", name, "完整正文", {
      sourceConversationId: "mcp:deep-chapter", adoptionGate: "passed",
    })
    expect(draft.adoptionGate).toEqual({ status: "unassessed" })
    expect(fsState.files.get(`C:/book/.qm-drafts/${draft.id}.md`)).not.toContain("reviewed_body_sha256:")
  })

  it.each([
    ["draft", "chapter_status: draft", "chapter_status: final"],
    ["revised", "chapter_status: \"revised\" # 审校备注", "chapter_status: \"final\" # 审校备注"],
    ["outline", "chapter_status:   'outline'", "chapter_status:   'final'"],
    ["archived", "chapter_status: archived", "chapter_status: final"],
  ] as const)("门控采纳将既有 %s 表头升级为 final 并保留 BOM/CRLF/引号/注释", async (_label, beforeLine, afterLine) => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", draft, "passed", deps)
    const target = "C:/book/wiki/chapters/chapter-001.md"
    const existingHeader = `\uFEFF---\r\ntype: chapter\r\nchapter_number: 1\r\n${beforeLine}\r\n---\r\n\r\n`
    files.set(target, `${existingHeader}旧正文。`)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: target,
      confirmed: true,
    }, deps)

    const expectedHeader = `\uFEFF---\r\ntype: chapter\r\nchapter_number: 1\r\n${afterLine}\r\n---\r\n\r\n`
    expect(files.get(target)).toBe(`${expectedHeader}# 第01章\n\n正文。`)
  })

  it("门控采纳遇缺少 chapter_status 的既有表头（BOM+CRLF）自动插入 final", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", draft, "passed", deps)
    const target = "C:/book/wiki/chapters/chapter-001.md"
    const existing = "\uFEFF---\r\ntype: chapter\r\nchapter_number: 1\r\ntitle: \"旧题\"\r\n---\r\n\r\n旧正文。"
    files.set(target, existing)

    await acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: target,
      confirmed: true,
    }, deps)

    expect(files.get(target)).toBe(
      "\uFEFF---\r\ntype: chapter\r\nchapter_number: 1\r\ntitle: \"旧题\"\r\nchapter_status: final\r\n---\r\n\r\n# 第01章\n\n正文。",
    )
  })

  it("门控采纳遇非法 chapter_status: custom 时 fail-loud 拒绝且不写盘", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    await recordDraftAdoptionGate("C:/book", draft, "passed", deps)
    const reviewedDraft = files.get(DRAFT_PATH)
    const target = "C:/book/wiki/chapters/chapter-001.md"
    const existing = "---\ntype: chapter\nchapter_number: 1\nchapter_status: custom\n---\n\n旧正文。"
    files.set(target, existing)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)

    await expect(acceptChapterDraft({
      projectPath: "C:/book",
      draftId: "draft_1",
      formalChapterPath: target,
      confirmed: true,
    }, { ...deps, writeFilesAtomic })).rejects.toThrow("Could not finalize the existing chapter header")

    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.get(target)).toBe(existing)
    expect(files.get(DRAFT_PATH)).toBe(reviewedDraft)
  })

  it("recordDraftAdoptionGate 缺少批量原子写入器时 fail-loud 拒绝", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    const { writeFilesAtomic: _omitted, ...withoutBatch } = deps

    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", withoutBatch))
      .rejects.toThrow("Draft review receipt requires a verified batch writer")
    expect(files.get(DRAFT_PATH)).toBe(MCP_STORED)
  })

  it("recordDraftAdoptionGate 遭遇并发改写时 CAS 拒写并保留外部竞写字节", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, MCP_STORED)
    const [draft] = await listChapterDrafts("C:/book", deps)
    const concurrentBytes = MCP_STORED.replace("正文。", "并发外部改写正文。")
    const baseRead = deps.readFileAsBase64
    let injected = false
    const racingDeps: DraftManagerDeps = {
      ...deps,
      readFileAsBase64: async (path) => {
        const res = await baseRead(path)
        if (!injected && path === DRAFT_PATH) {
          // 锁内读出原基线后、CAS 写入前被外部改写。
          injected = true
          files.set(DRAFT_PATH, concurrentBytes)
        }
        return res
      },
    }

    await expect(recordDraftAdoptionGate("C:/book", draft, "passed", racingDeps))
      .rejects.toThrow("changed before staging")
    expect(files.get(DRAFT_PATH)).toBe(concurrentBytes)
  })
})

describe("R2-W01 契约 1：getDraftGateStatus / discardChapterDraft / 字典序双锁", () => {
  it("getDraftGateStatus 真值表与 draftNeedsGateReview 委托完全一致", () => {
    expect(getDraftGateStatus({ partial: true, adoptionGate: { status: "passed" } })).toBe("partial")
    expect(getDraftGateStatus({ adoptionGate: { status: "partial" } })).toBe("partial")
    expect(getDraftGateStatus({ adoptionGate: undefined })).toBe("passed")
    expect(getDraftGateStatus({ adoptionGate: { status: "passed" } })).toBe("passed")
    expect(getDraftGateStatus({ adoptionGate: { status: "blocked" } })).toBe("blocked")
    expect(getDraftGateStatus({ adoptionGate: { status: "manual_review" } })).toBe("manual_review")
    expect(getDraftGateStatus({ adoptionGate: { status: "unassessed" } })).toBe("unassessed")
    expect(getDraftGateStatus({ adoptionGate: { status: "unknown_state" as never } })).toBe("unassessed")

    expect(draftNeedsGateReview({ adoptionGate: undefined })).toBe(false)
    expect(draftNeedsGateReview({ adoptionGate: { status: "passed" } })).toBe(false)
    expect(draftNeedsGateReview({ partial: true, adoptionGate: { status: "passed" } })).toBe(true)
    expect(draftNeedsGateReview({ adoptionGate: { status: "blocked" } })).toBe(true)
    expect(draftNeedsGateReview({ adoptionGate: { status: "unknown_state" as never } })).toBe(true)
  })

  it("discardChapterDraft 原子原位标废 status: failed，不删文件，拒绝非法 ID 与已采纳草稿", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED)
    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    const trackedDeps: DraftManagerDeps = { ...deps, writeFilesAtomic }

    await discardChapterDraft("C:/book", "draft_1", trackedDeps)
    expect(writeFilesAtomic).toHaveBeenCalledTimes(1)
    expect(writeFilesAtomic).toHaveBeenCalledWith(
      [[DRAFT_PATH, expect.stringContaining("status: failed")]],
      [STORED],
    )
    expect(files.has(DRAFT_PATH)).toBe(true)
    const [reread] = await listChapterDrafts("C:/book", trackedDeps)
    expect(reread?.status).toBe("failed")

    // 幂等：已 failed 再次丢弃不重复写盘
    await discardChapterDraft("C:/book", "draft_1", trackedDeps)
    expect(writeFilesAtomic).toHaveBeenCalledTimes(1)

    // 非法 draftId 与缺失草稿拒绝
    await expect(discardChapterDraft("C:/book", "../evil", trackedDeps)).rejects.toThrow("Invalid draft identifier")
    await expect(discardChapterDraft("C:/book", "missing_id", trackedDeps)).rejects.toThrow("找不到草稿")

    // 已采纳（status: saved）草稿禁止丢弃
    files.set("C:/book/.qm-drafts/saved_1.md", STORED.replace("draft_1", "saved_1").replace("status: draft", "status: saved"))
    await expect(discardChapterDraft("C:/book", "saved_1", trackedDeps)).rejects.toThrow()
  })

  it("acceptChapterDraft 并发采纳同一正式章按字典序双锁串行执行且无死锁", async () => {
    const { files, deps } = memoryDeps()
    files.set("C:/book/.qm-drafts/draft_a.md", STORED.replace("draft_1", "draft_a").replace("正文。", "正文A。"))
    files.set("C:/book/.qm-drafts/draft_b.md", STORED.replace("draft_1", "draft_b").replace("正文。", "正文B。"))
    const target = "C:/book/wiki/chapters/第01章.md"
    const order: string[] = []
    const serializedDeps: DraftManagerDeps = {
      ...deps,
      writeFilesAtomic: async (batch, expected) => {
        order.push(batch[0][1].includes("正文A") ? "A" : "B")
        await new Promise((resolve) => setTimeout(resolve, 10))
        await deps.writeFilesAtomic!(batch, expected)
      },
    }

    await Promise.all([
      acceptChapterDraft({ projectPath: "C:/book", draftId: "draft_a", formalChapterPath: target, confirmed: true }, serializedDeps),
      acceptChapterDraft({ projectPath: "C:/book", draftId: "draft_b", formalChapterPath: target, confirmed: true }, serializedDeps),
    ])

    expect(order).toEqual(["A", "B"])
    expect(files.get(target)).toContain("正文B。")
    expect(files.get("C:/book/.qm-drafts/draft_a.md")).toContain("status: saved")
    expect(files.get("C:/book/.qm-drafts/draft_b.md")).toContain("status: saved")
  })

  it("NON_BLOCKING-2：已 discardChapterDraft 标废（status: failed）的草稿禁止再采纳或写入门控回执", async () => {
    const { files, deps } = memoryDeps()
    files.set(DRAFT_PATH, STORED)
    await discardChapterDraft("C:/book", "draft_1", deps)

    const writeFilesAtomic = vi.fn(deps.writeFilesAtomic)
    const trackedDeps: DraftManagerDeps = { ...deps, writeFilesAtomic }
    const formalPath = "C:/book/wiki/chapters/第01章.md"

    // 1) 普通草稿标废后拒绝 acceptChapterDraft
    await expect(
      acceptChapterDraft(
        { projectPath: "C:/book", draftId: "draft_1", formalChapterPath: formalPath, confirmed: true },
        trackedDeps,
      ),
    ).rejects.toThrow("草稿已丢弃，不能采纳")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.has(formalPath)).toBe(false)

    // 2) 已通过门控（passed）的草稿标废后同样拒绝 acceptChapterDraft 与 recordDraftAdoptionGate
    const gatedPath = "C:/book/.qm-drafts/draft_gated.md"
    const gatedStored = [
      "---",
      "draft_id: draft_gated",
      "chapter_name: 第01章",
      "status: draft",
      "created_at: 10",
      "adoption_gate: unassessed",
      "---",
      "",
      "# 第01章",
      "",
      "门控正文。",
    ].join("\n")
    files.set(gatedPath, gatedStored)
    const [initialGated] = (await listChapterDrafts("C:/book", deps)).filter((d) => d.id === "draft_gated")
    await recordDraftAdoptionGate("C:/book", initialGated!, "passed", deps)
    const [passedGated] = (await listChapterDrafts("C:/book", deps)).filter((d) => d.id === "draft_gated")
    expect(passedGated?.adoptionGate?.status).toBe("passed")

    const gatedFormalPath = "C:/book/wiki/chapters/chapter-001.md"
    await discardChapterDraft("C:/book", "draft_gated", deps)

    await expect(
      acceptChapterDraft(
        { projectPath: "C:/book", draftId: "draft_gated", formalChapterPath: gatedFormalPath, confirmed: true },
        trackedDeps,
      ),
    ).rejects.toThrow("草稿已丢弃，不能采纳")
    await expect(
      recordDraftAdoptionGate("C:/book", passedGated!, "passed", trackedDeps),
    ).rejects.toThrow("Draft changed during review; run the checks again")
    const [rereadGated] = (await listChapterDrafts("C:/book", deps)).filter((d) => d.id === "draft_gated")
    expect(rereadGated?.status).toBe("failed")
    await expect(
      recordDraftAdoptionGate("C:/book", rereadGated!, "passed", trackedDeps),
    ).rejects.toThrow("Draft changed during review; run the checks again")
    expect(writeFilesAtomic).not.toHaveBeenCalled()
    expect(files.has(gatedFormalPath)).toBe(false)
    expect(files.get(gatedPath)).toContain("status: failed")
  })
})
