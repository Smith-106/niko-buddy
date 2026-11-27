// @vitest-environment jsdom
/**
 * draft-actions 覆盖 spec（方案 `d23eb1df` P2）。
 *
 * 钉死两条：
 * 1. **报给调用方的路径必须与写入器同一个常量**。第一版手拼 `.novel/drafts/`，
 *    而 `writeDraft` 实际落 `.qm-drafts/`——真机验收当场抓到调用方拿到不存在的路径。
 * 2. 两个写动作都只产出草稿：章节走 `writeDraft`（既有 Draft-first 入口），记忆带
 *    `status: draft` 落在 `.novel/drafts/memory`，正式目录一律不碰。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const writeDraft = vi.hoisted(() => vi.fn())
const loadNovelSessionStatus = vi.hoisted(() => vi.fn(async () => null as Record<string, unknown> | null))
const syncExternalDraftToSessionStatus = vi.hoisted(() => vi.fn(async () => null))
const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  createDirectory: vi.fn(async () => undefined),
  fileExists: vi.fn(async () => true),
}))

vi.mock("@/lib/novel", () => ({
  writeDraft,
  loadNovelSessionStatus,
  syncExternalDraftToSessionStatus,
  HARD_FUSE_LIMIT: 5,
  // 故意给一个和 `.novel/drafts` 不同的值：如果实现里手拼路径，下面就会挂。
  DRAFTS_DIR: ".qm-drafts",
  // 这里只验"是否委托给了应用自己的正式章路径规则"，规则本身由
  // draft-manager 的 spec 负责。所以 mock 出一个能区分委托与否的实现即可。
  formalChapterPathForDraft: (pp: string, name: string) => `${pp}/wiki/chapters/${name}.md`,
  readDraftChapterNumber: (name: string) => {
    const cnMap: Record<string, number> = { 一: 1, 二: 2, 三: 3 }
    const cn = /第([一二三])章/.exec(name)?.[1]
    if (cn && cnMap[cn]) return cnMap[cn]
    const num = /第(\d+)章|^chapter[- ](\d+)/i.exec(name)
    const raw = num?.[1] ?? num?.[2]
    return raw ? Number(raw) : undefined
  },
  externalDraftTargetKey: (_pp: string, name: string) => {
    const cnMap: Record<string, number> = { 一: 1, 二: 2, 三: 3 }
    const cn = /第([一二三])章/.exec(name)?.[1]
    if (cn && cnMap[cn]) return `chapter:${cnMap[cn]}`
    const num = /第(\d+)章|^chapter[- ](\d+)/i.exec(name)
    const raw = num?.[1] ?? num?.[2]
    if (raw) return `chapter:${Number(raw)}`
    return `path:wiki/chapters/${name.replace(/[\\/]/g, "").trim().toLowerCase()}.md`
  },
  getExternalDraftRevisionCount: (
    status: { external_draft_revisions?: Record<string, number> } | null,
    key: string,
  ) => {
    const v = status?.external_draft_revisions?.[key]
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0
  },
}))

vi.mock("@/commands/fs", () => fsMocks)

import { resolveFormalPath, writeChapterDraft } from "./draft-actions"

beforeEach(() => {
  writeDraft.mockReset()
  loadNovelSessionStatus.mockReset().mockResolvedValue(null)
  syncExternalDraftToSessionStatus.mockReset().mockResolvedValue(null)
  fsMocks.writeFile.mockClear()
  fsMocks.createDirectory.mockClear()
  fsMocks.fileExists.mockClear()
})

describe("writeChapterDraft", () => {
  it("路径用写入器同一个 DRAFTS_DIR 常量，不是手拼的", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    const res = await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文" })
    expect(res.path).toBe("/proj/.qm-drafts/draft_1.md")
    expect(res.draftId).toBe("draft_1")
  })

  it("partial 透传进草稿写入器的 meta（RF-1）", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文", partial: true })
    expect(writeDraft.mock.calls[0][3]).toMatchObject({ partial: true })
  })

  it("普通采纳走既有策略：mcp:chapter.write 来源、无回执绑定", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    await writeChapterDraft("/proj", { chapterName: "第一章", content: "x" })
    expect(writeDraft.mock.calls[0][3]).toEqual({ sourceConversationId: "mcp:chapter.write" })
  })

  it("非布尔 partial 不当真（只认 true）", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文", partial: "yes" })
    expect(writeDraft.mock.calls[0][3]).not.toHaveProperty("partial")
  })

  it("明确告知未进入正式章节", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "第一章", content: "x" })
    const res = await writeChapterDraft("/proj", { chapterName: "第一章", content: "正文" })
    expect(res.note).toContain("草稿")
    expect(res.note).toContain("确认")
  })

  it("章节名里的路径分隔符被清洗（否则会写到草稿目录之外）", async () => {
    writeDraft.mockResolvedValue({ id: "draft_1", chapterName: "x", content: "x" })
    await writeChapterDraft("/proj", { chapterName: "../../etc/passwd", content: "正文" })
    const passedName = writeDraft.mock.calls[0][1] as string
    expect(passedName).not.toContain("/")
    expect(passedName).not.toContain("\\")
  })

  it("缺 chapterName 或 content 直接拒绝", async () => {
    await expect(writeChapterDraft("/proj", { content: "正文" })).rejects.toThrow(/chapterName/)
    await expect(writeChapterDraft("/proj", { chapterName: "第一章" })).rejects.toThrow(/content/)
    await expect(writeChapterDraft("/proj", { chapterName: "第一章", content: "   " })).rejects.toThrow(
      /content/,
    )
    expect(writeDraft).not.toHaveBeenCalled()
  })

  it("首次写入同步 .novel/status.json（targetKey 归一且 revisionRound=0）；同章重调 chapter.write 递增持久轮次", async () => {
    writeDraft.mockResolvedValue({
      id: "draft_ch1_v0",
      chapterName: "第一章",
      content: "初稿",
      sourceConversationId: "mcp:chapter.write",
    })
    await writeChapterDraft("/proj", { chapterName: "第一章", content: "初稿" })
    expect(syncExternalDraftToSessionStatus).toHaveBeenCalledWith({
      projectPath: "/proj",
      draftId: "draft_ch1_v0",
      draftPath: "/proj/.qm-drafts/draft_ch1_v0.md",
      chapterName: "第一章",
      chapterNumber: 1,
      targetKey: "chapter:1",
      revisionRound: 0,
      sourceConversationId: "mcp:chapter.write",
    })

    // 换标题写法重调 chapter.write（仍归到 chapter:1）→ 轮次 0 → 1
    loadNovelSessionStatus.mockResolvedValueOnce({
      external_draft_revisions: { "chapter:1": 0 },
    })
    writeDraft.mockResolvedValueOnce({
      id: "draft_ch1_v1",
      chapterName: "第1章-重写",
      content: "二稿",
      sourceConversationId: "mcp:chapter.write",
      revisionRound: 1,
    })
    await writeChapterDraft("/proj", { chapterName: "第1章-重写", content: "二稿" })
    expect(writeDraft).toHaveBeenLastCalledWith("/proj", "第1章-重写", "二稿", {
      sourceConversationId: "mcp:chapter.write",
      revisionRound: 1,
    })
    expect(syncExternalDraftToSessionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        draftId: "draft_ch1_v1",
        targetKey: "chapter:1",
        revisionRound: 1,
      }),
    )
  })

  it("达到章节级持久 HARD_FUSE_LIMIT=5 时拒绝 chapter.write（封堵重调重置熔断绕过）", async () => {
    loadNovelSessionStatus.mockResolvedValueOnce({
      external_draft_revisions: { "chapter:1": 5 },
    })
    await expect(
      writeChapterDraft("/proj", { chapterName: "第1章-换标题重来", content: "绕过正文" }),
    ).rejects.toThrow(/HARD_FUSE_LIMIT_EXCEEDED/)
    expect(writeDraft).not.toHaveBeenCalled()
    expect(syncExternalDraftToSessionStatus).not.toHaveBeenCalled()
  })
})

describe("resolveFormalPath", () => {
  it("章节走既有正式章路径规则，记忆落 wiki/memory", () => {
    expect(resolveFormalPath("/proj", { kind: "chapter", name: "第一章" })).toEqual({
      kind: "chapter",
      path: "/proj/wiki/chapters/第一章.md",
    })
    expect(resolveFormalPath("/proj", { kind: "memory", name: "设定" })).toEqual({
      kind: "memory",
      path: "/proj/wiki/memory/设定.md",
    })
  })

  it("未知 kind 直接拒绝，不猜成章节", () => {
    expect(() => resolveFormalPath("/proj", { kind: "outline", name: "x" })).toThrow(/kind/)
    expect(() => resolveFormalPath("/proj", { name: "x" })).toThrow(/kind/)
  })

  it("缺名字拒绝", () => {
    expect(() => resolveFormalPath("/proj", { kind: "chapter" })).toThrow(/name/)
  })

  it("名字里的路径分隔符被清洗，路径不逃出正式目录", () => {
    for (const name of ["../逃逸", "a/b", "..\\\\x"]) {
      const out = resolveFormalPath("/proj", { kind: "memory", name })
      expect(out.path.startsWith("/proj/wiki/memory/")).toBe(true)
      expect(out.path).not.toContain("/../")
    }
  })
})
