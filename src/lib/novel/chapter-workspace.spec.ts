import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CHAPTER_WORKSPACE_MAX_SNAPSHOTS,
  commitSnapshot,
  createEmptyChapterWorkspaceStore,
  listSnapshots,
  loadChapterWorkspace,
  rollbackToSnapshot,
  saveChapterWorkspace,
  workspaceDiffSummary,
  type ChapterWorkspaceStore,
} from "./chapter-workspace"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

describe("chapter-workspace（吸收自 inkos 安全章节工作区·原子提交模式）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockImplementation(async () => {
      throw new Error("ENOENT")
    })
  })

  it("commitSnapshot 追加栈并记录字数/预览", () => {
    let store = createEmptyChapterWorkspaceStore()
    store = commitSnapshot(store, 3, "第一章正文内容，他推开门。")
    expect(store.snapshots).toHaveLength(1)
    expect(store.snapshots[0].chapter).toBe(3)
    expect(store.snapshots[0].wordCount).toBeGreaterThan(0)
    expect(store.snapshots[0].preview).toContain("第一章")
  })

  it("栈上限淘汰最旧快照", () => {
    let store = createEmptyChapterWorkspaceStore()
    for (let i = 0; i < CHAPTER_WORKSPACE_MAX_SNAPSHOTS + 5; i++) {
      store = commitSnapshot(store, 1, `版本 ${i}`, { maxSnapshots: 3 })
    }
    expect(store.snapshots).toHaveLength(3)
    expect(store.snapshots[0].content).toBe(`版本 ${CHAPTER_WORKSPACE_MAX_SNAPSHOTS + 2}`)
    expect(store.snapshots[2].content).toBe(`版本 ${CHAPTER_WORKSPACE_MAX_SNAPSHOTS + 4}`)
  })

  it("listSnapshots 只含摘要字段（不含全文）", () => {
    let store = createEmptyChapterWorkspaceStore()
    store = commitSnapshot(store, 2, "x".repeat(150) + "尾部机密标记")
    const listed = listSnapshots(store, 2)
    expect(listed).toHaveLength(1)
    // preview 仅前 120 字（全 x），全文尾部的机密标记不得出现在摘要中
    expect(JSON.stringify(listed)).not.toContain("尾部机密标记")
    expect(store.snapshots[0].content).toContain("尾部机密标记")
    expect(listed[0].preview).toBeDefined()
  })

  it("rollbackToSnapshot 取回历史全文；越界返回 null", () => {
    let store = createEmptyChapterWorkspaceStore()
    store = commitSnapshot(store, 2, "版本一")
    store = commitSnapshot(store, 2, "版本二")
    expect(rollbackToSnapshot(store, 2, 0)).toBe("版本一")
    expect(rollbackToSnapshot(store, 2, 1)).toBe("版本二")
    expect(rollbackToSnapshot(store, 2, 9)).toBeNull()
    expect(rollbackToSnapshot(store, 9, 0)).toBeNull()
  })

  it("workspaceDiffSummary 多重集合行差统计", () => {
    const before = "第一行\n共通行\n共通行\n删除行"
    const after = "第一行\n共通行\n共通行\n共通行\n新增行"
    const diff = workspaceDiffSummary(before, after)
    // before: 第一行, 共通行×2, 删除行（4 行）；after: 第一行, 共通行×3, 新增行（5 行）
    // unchanged: 第一行×1 + 共通行 min(2,3)=2 → 3
    expect(diff).toEqual({
      addedLines: 2, // 共通行第 3 次 + 新增行
      removedLines: 1, // 删除行
      unchangedLines: 3,
      wordDelta: diff.wordDelta, // 字数差不锁死具体值
    })
  })

  it("持久化往返：save 走 writeFileAtomic，load 还原快照栈", async () => {
    let captured: string | null = null
    fsMocks.writeFileAtomic.mockImplementation(
      async (_p: string, content: string) => {
        captured = content
      },
    )
    const store = commitSnapshot(
      createEmptyChapterWorkspaceStore(),
      5,
      "持久化正文",
    ) as ChapterWorkspaceStore
    await saveChapterWorkspace("/proj", store)
    expect(captured).not.toBeNull()
    fsMocks.readFile.mockImplementation(async () => captured as string)
    const loaded = await loadChapterWorkspace("/proj")
    expect(loaded.snapshots[0].content).toBe("持久化正文")
  })
})
