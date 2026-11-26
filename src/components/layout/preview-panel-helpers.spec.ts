import { describe, expect, it, vi } from "vitest"

import type { FileNode } from "@/types/wiki"
import {
  CHAPTER_WRITE_KINDS,
  ChapterAdoptionUnavailableError,
  collectRecentChapterFiles,
  createChapterWriteCoordinator,
} from "./preview-panel-helpers"

function node(overrides: Partial<FileNode> & { name: string; path: string }): FileNode {
  return { is_dir: false, ...overrides }
}

describe("collectRecentChapterFiles 过滤", () => {
  it("跳过非 .md 文件与非章节路径的 .md，递归目录，只收章节", () => {
    const nodes: FileNode[] = [
      node({ name: "cover.png", path: "/p/wiki/chapters/cover.png" }),
      // .md 但不是章节路径 → 命中 isChapterPath 守卫
      node({ name: "notes.md", path: "/p/wiki/notes.md" }),
      node({ name: "003.md", path: "/p/wiki/chapters/003.md" }),
      node({
        name: "sub",
        path: "/p/wiki/chapters/sub",
        is_dir: true,
        children: [node({ name: "004.md", path: "/p/wiki/chapters/004.md" })],
      }),
    ]

    const out = collectRecentChapterFiles(nodes)

    // 目录被递归展开，非章节与非 md 均被过滤；按章号降序
    expect(out.map((item) => item.path)).toEqual([
      "/p/wiki/chapters/004.md",
      "/p/wiki/chapters/003.md",
    ])
  })
})

describe("ChapterWriteCoordinator — U4-02 重定位协调与 observedSeq 守卫", () => {
  it("CHAPTER_WRITE_KINDS 包含 tree-rename / tree-move / chat-edit / tree-reorder / tree-delete", () => {
    expect(CHAPTER_WRITE_KINDS).toContain("tree-rename")
    expect(CHAPTER_WRITE_KINDS).toContain("tree-move")
    expect(CHAPTER_WRITE_KINDS).toContain("chat-edit")
    expect(CHAPTER_WRITE_KINDS).toContain("tree-reorder")
    expect(CHAPTER_WRITE_KINDS).toContain("tree-delete")
  })

  it("currentSequence / wasRelocatedSince / noteRelocation 事件广播与恢复迁移", () => {
    const coordinator = createChapterWriteCoordinator()
    const oldPath = "/p/wiki/chapters/ch1.md"
    const newPath = "/p/wiki/chapters/vol1/ch1.md"
    const events: string[] = []
    const unsub = coordinator.subscribe(oldPath, (ev) => events.push(ev))

    const loadedSeq = coordinator.currentSequence()
    expect(coordinator.wasRelocatedSince(oldPath, loadedSeq)).toBe(false)
    expect(coordinator.wasRelocatedSince(oldPath)).toBe(false)

    coordinator.retainRecovery({
      path: oldPath,
      buffer: "未存正文",
      titleDraft: "第一章",
      titleEditing: true,
    })
    const moveIntent = coordinator.captureIntent("tree-move", oldPath)
    coordinator.noteRelocation(moveIntent, oldPath, newPath)

    const afterSeq = coordinator.currentSequence()
    expect(afterSeq).toBeGreaterThan(loadedSeq)
    expect(coordinator.wasRelocatedSince(oldPath, loadedSeq)).toBe(true)
    expect(coordinator.wasRelocatedSince(oldPath)).toBe(true)
    expect(coordinator.wasRelocatedSince(oldPath, afterSeq)).toBe(false)
    expect(events).toContain("relocation")
    expect(coordinator.peekRecovery(oldPath)).toBeNull()
    expect(coordinator.peekRecovery(newPath)).toEqual(expect.objectContaining({
      path: newPath,
      originalPath: oldPath,
      buffer: "未存正文",
    }))

    // 同路径 noteRelocation 为空操作
    const seqBeforeSame = coordinator.currentSequence()
    coordinator.noteRelocation(moveIntent, newPath, newPath)
    expect(coordinator.currentSequence()).toBe(seqBeforeSame)
    unsub()
  })

  it("observedSeq 早于重定位序号时，即便意图捕获更晚也会被 admitMutation 以 relocated 拒绝", async () => {
    const coordinator = createChapterWriteCoordinator()
    const oldPath = "/p/wiki/chapters/ch1.md"
    const newPath = "/p/wiki/chapters/第1章-新名.md"

    const observedSeq = coordinator.currentSequence()
    const renameIntent = coordinator.captureIntent("tree-rename", oldPath)
    const renameAdmission = coordinator.admitMutation(renameIntent, [oldPath, newPath], async () => {
      coordinator.noteRelocation(renameIntent, oldPath, newPath)
    })
    expect(renameAdmission.kind).toBe("admitted")
    if (renameAdmission.kind === "admitted") await renameAdmission.result

    // 编辑区在重定位之后才发起 leave-flush（intent.id > relocationSeq），但携带旧 observedSeq
    const lateFlushIntent = coordinator.captureIntent("leave-flush", oldPath, observedSeq)
    expect(lateFlushIntent.id).toBeGreaterThan(observedSeq)
    const run = vi.fn(async () => "should-not-run")
    const flushAdmission = coordinator.admitMutation(lateFlushIntent, [oldPath], run)
    expect(flushAdmission.kind).toBe("admitted")
    if (flushAdmission.kind === "admitted") {
      await expect(flushAdmission.result).rejects.toBeInstanceOf(ChapterAdoptionUnavailableError)
      await expect(flushAdmission.result).rejects.toMatchObject({ reason: "relocated" })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it("并发前驱重定位后，排在其后的同源意图被拒绝；后续新意图迁回原路径则允许通过", async () => {
    const coordinator = createChapterWriteCoordinator()
    const oldPath = "/p/wiki/chapters/ch1.md"
    const newPath = "/p/wiki/chapters/vol1/ch1.md"

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstIntent = coordinator.captureIntent("title", oldPath)
    const secondIntent = coordinator.captureIntent("tree-move", oldPath)

    const firstAdm = coordinator.admitMutation(firstIntent, [oldPath, newPath], async () => {
      await firstGate
      coordinator.noteRelocation(firstIntent, oldPath, newPath)
    })
    const secondRun = vi.fn(async () => "stale-move")
    const secondAdm = coordinator.admitMutation(secondIntent, [oldPath, "/p/wiki/chapters/vol2/ch1.md"], secondRun)
    expect(firstAdm.kind).toBe("admitted")
    expect(secondAdm.kind).toBe("admitted")

    releaseFirst()
    if (firstAdm.kind === "admitted") await firstAdm.result
    if (secondAdm.kind === "admitted") {
      await expect(secondAdm.result).rejects.toMatchObject({ reason: "relocated" })
    }
    expect(secondRun).not.toHaveBeenCalled()

    // 之后以新意图将 newPath 迁回 oldPath：intent.id > oldPath.relocationSeq → 允许
    const moveBackIntent = coordinator.captureIntent("tree-move", newPath)
    const moveBackRun = vi.fn(async () => "moved-back")
    const moveBackAdm = coordinator.admitMutation(moveBackIntent, [newPath, oldPath], moveBackRun)
    expect(moveBackAdm.kind).toBe("admitted")
    if (moveBackAdm.kind === "admitted") {
      await expect(moveBackAdm.result).resolves.toBe("moved-back")
    }
    expect(moveBackRun).toHaveBeenCalledTimes(1)
  })

  it("BLK-01：observedSeq 仅作用于源路径；章节 B 携带旧 observedSeq=0 迁入已腾空的 pathA 必须放行，源 pathA 过期写入仍拦截", async () => {
    const coordinator = createChapterWriteCoordinator()
    const pathA = "/p/wiki/chapters/第1章.md"
    const pathA2 = "/p/wiki/chapters/第1章-已迁出.md"
    const pathB = "/p/wiki/chapters/第2章.md"

    // 章节 B 与章节 A 都在 seq=0 时打开
    const observedSeqAtOpen = coordinator.currentSequence()
    expect(observedSeqAtOpen).toBe(0)

    // 章节 A 从 pathA 迁出至 pathA2（pathA.relocationSeq > 0）
    const moveAIntent = coordinator.captureIntent("tree-rename", pathA)
    const moveAAdm = coordinator.admitMutation(moveAIntent, [pathA, pathA2], async () => {
      coordinator.noteRelocation(moveAIntent, pathA, pathA2)
    })
    expect(moveAAdm.kind).toBe("admitted")
    if (moveAAdm.kind === "admitted") await moveAAdm.result
    expect(coordinator.wasRelocatedSince(pathA, observedSeqAtOpen)).toBe(true)

    // 章节 B 仍持有旧 observedSeq=0，将自身改名/迁入腾空的 pathA（affectedPaths=[pathB, pathA]）：必须放行
    const moveBIntoAIntent = coordinator.captureIntent("title", pathB, observedSeqAtOpen)
    const moveBRun = vi.fn(async () => "moved-B-into-A")
    const moveBAdm = coordinator.admitMutation(moveBIntoAIntent, [pathB, pathA], moveBRun)
    expect(moveBAdm.kind).toBe("admitted")
    if (moveBAdm.kind === "admitted") {
      await expect(moveBAdm.result).resolves.toBe("moved-B-into-A")
    }
    expect(moveBRun).toHaveBeenCalledTimes(1)

    // 源路径 pathA 携带过期 observedSeq=0 的迟到写入：仍必须被 relocated 拦截
    const staleAWriteIntent = coordinator.captureIntent("debounce-save", pathA, observedSeqAtOpen)
    const staleARun = vi.fn(async () => "stale-A-should-not-run")
    const staleAAdm = coordinator.admitMutation(staleAWriteIntent, [pathA], staleARun)
    expect(staleAAdm.kind).toBe("admitted")
    if (staleAAdm.kind === "admitted") {
      await expect(staleAAdm.result).rejects.toBeInstanceOf(ChapterAdoptionUnavailableError)
      await expect(staleAAdm.result).rejects.toMatchObject({ reason: "relocated" })
    }
    expect(staleARun).not.toHaveBeenCalled()
  })
})
