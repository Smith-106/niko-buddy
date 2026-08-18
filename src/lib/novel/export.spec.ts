/**
 * export.ts 并行化（TASK-403）收敛测试。
 *
 * 守 PAT-G2 mock mirror：vi.mock("@/commands/fs") factory 须 mirror 依赖链
 * 实际引用的 export（readFile/writeFile/writeFileAtomic/listDirectory/
 * createDirectory/fileExists/deleteFile/getFileModifiedTime/getFileSize）。
 * 漏 export → 依赖链模块（chapter-ingest / character-state / path-utils…）
 * import 缺 binding 时运行时 TypeError。
 *
 * 断言目标：
 *  1. 章节段 readFile 并发峰值 = 文件数 —— 证明 Promise.all 并行而非串行 for。
 *  2. 快照段 loadSnapshot（真实 chapter-ingest，经 mock fs readFile）并发峰值
 *     = 快照数 —— 证明 Promise.all 并行。
 *  3. 写出顺序确定：即使 readFile 以乱序完成，章节输出顺序仍与改动前一致
 *     （files 遍历序；parseFrontmatter 将标量字符串化 → chapter_number 为 string →
 *     sort by num 是稳定 no-op，故实际顺序 = 文件遍历序，与改动前完全相同）；
 *     快照文件名按 num padStart(3,"0") 依序写出，不随并行完成顺序改变。
 */

import { describe, expect, it, vi, afterEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

const fsState = vi.hoisted(() => {
  const files = new Map<string, string>()
  const directories = new Map<string, Array<{ name: string; path: string; is_dir: boolean }>>()
  const gateWaiters = new Map<string, Array<() => void>>()
  const writes: Array<{ path: string; content: string }> = []

  // 注意：inFlight/peak 必须为可变属性（mock 内 fsState.inFlight += 1），
  // 不能是只读 getter，否则严格模式下赋值抛 TypeError。
  const state = {
    files,
    directories,
    writes,
    gateWaiters,
    inFlight: 0,
    peak: 0,
    // 新测试（非并行断言）用 true 跳过门闩，直接返回文件内容；
    // 原有两条并行测试不触碰该字段，门闩行为保持不变。
    bypassGates: false,
    release(path: string): void {
      const key = String(path).replace(/\\/g, "/")
      const waiters = gateWaiters.get(key)
      gateWaiters.delete(key)
      waiters?.forEach((w) => w())
    },
    releaseAll(): void {
      for (const waiters of gateWaiters.values()) waiters.forEach((w) => w())
      gateWaiters.clear()
    },
    reset(): void {
      files.clear()
      directories.clear()
      writes.length = 0
      gateWaiters.clear()
      state.inFlight = 0
      state.peak = 0
      state.bypassGates = false
    },
  }
  return state
})

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string): Promise<string> => {
    fsState.inFlight += 1
    if (fsState.inFlight > fsState.peak) fsState.peak = fsState.inFlight
    const key = String(path).replace(/\\/g, "/")
    try {
      if (!fsState.bypassGates) {
        // 门闩：未 release 前保持 in-flight，用于观测并发峰值与乱序完成。
        await new Promise<void>((resolve) => {
          const waiters = fsState.gateWaiters.get(key) ?? []
          waiters.push(resolve)
          fsState.gateWaiters.set(key, waiters)
        })
      }
      const content = fsState.files.get(key)
      if (content === undefined) throw new Error(`ENOENT: ${key}`)
      return content
    } finally {
      fsState.inFlight -= 1
    }
  }),
  writeFile: vi.fn(async (path: string, content: string): Promise<void> => {
    fsState.writes.push({ path: String(path).replace(/\\/g, "/"), content })
  }),
  writeFileAtomic: vi.fn(async (): Promise<void> => {}),
  listDirectory: vi.fn(async (path: string) => {
    return fsState.directories.get(String(path).replace(/\\/g, "/")) ?? []
  }),
  createDirectory: vi.fn(async (): Promise<void> => {}),
  fileExists: vi.fn(async (): Promise<boolean> => true),
  deleteFile: vi.fn(async (): Promise<void> => {}),
  getFileModifiedTime: vi.fn(async (): Promise<number> => 0),
  getFileSize: vi.fn(async (): Promise<number> => 0),
}))

import { exportProject, exportNovelDocx } from "./export"
import { createDirectory, fileExists, listDirectory } from "@/commands/fs"

afterEach(() => {
  fsState.releaseAll()
})

const PROJECT = "E:/Novel"
const OUT = "E:/out"

function chapterFile(num: number, title: string, bodyText: string): string {
  return `---\nchapter_number: ${num}\ntitle: ${title}\nchapter_status: final\n---\n${bodyText}`
}

describe("exportProject 并行化（TASK-403）", () => {
  it("章节段 readFile 并发峰值 = 文件数；写出顺序与改动前 files 遍历序一致（不随并行完成顺序改变）", async () => {
    fsState.reset()
    fsState.files.set(`${PROJECT}/wiki/chapters/c3.md`, chapterFile(3, "第三章", "正文三"))
    fsState.files.set(`${PROJECT}/wiki/chapters/c1.md`, chapterFile(1, "第一章", "正文一"))
    fsState.files.set(`${PROJECT}/wiki/chapters/c2.md`, chapterFile(2, "第二章", "正文二"))
    // 文件树顺序 [c3, c1, c2]：改动前输出即此遍历序（parseFrontmatter 标量字符串化
    // → chapter_number 为 string → sort by num 稳定 no-op）。
    fsState.directories.set(`${PROJECT}/wiki/chapters`, [
      { name: "c3.md", path: `${PROJECT}/wiki/chapters/c3.md`, is_dir: false },
      { name: "c1.md", path: `${PROJECT}/wiki/chapters/c1.md`, is_dir: false },
      { name: "c2.md", path: `${PROJECT}/wiki/chapters/c2.md`, is_dir: false },
    ])

    const pending = exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeSnapshots: false,
      includeMeta: false,
    })

    // 3 个 readFile 同时 in-flight —— 串行 for 实现峰值恒为 1，此断言会超时失败。
    await vi.waitFor(() => expect(fsState.inFlight).toBe(3), { timeout: 2000, interval: 10 })
    expect(fsState.peak).toBe(3)

    // 乱序放行：c1 先完成、c2 其次、c3 最后 —— 与 files 遍历序 [c3, c1, c2] 不同。
    // 若按完成顺序写盘输出将是 一→二→三；按 i 还原则保持遍历序 三→一→二。
    fsState.release(`${PROJECT}/wiki/chapters/c1.md`)
    fsState.release(`${PROJECT}/wiki/chapters/c2.md`)
    fsState.release(`${PROJECT}/wiki/chapters/c3.md`)

    const result = await pending
    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(3)
    expect(fsState.writes).toHaveLength(1)
    expect(fsState.writes[0].path).toBe(`${OUT}/complete-novel.md`)
    // 输出顺序 = 改动前遍历序（c3 → c1 → c2），不随并行完成顺序改变。
    expect(fsState.writes[0].content).toBe(
      "# 第三章\n\n正文三\n\n---\n\n# 第一章\n\n正文一\n\n---\n\n# 第二章\n\n正文二",
    )
  })

  it("快照段 loadSnapshot 并发峰值 = 快照数；写出顺序按 num padStart(3,'0') 依序确定", async () => {
    fsState.reset()
    // listDirectory 返回乱序文件名；真实 listSnapshots 内部排序 → nums [1,2,3]。
    fsState.directories.set(`${PROJECT}/.novel/snapshots`, [
      { name: "003.snapshot.json", path: `${PROJECT}/.novel/snapshots/003.snapshot.json`, is_dir: false },
      { name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false },
      { name: "002.snapshot.json", path: `${PROJECT}/.novel/snapshots/002.snapshot.json`, is_dir: false },
    ])
    fsState.files.set(
      `${PROJECT}/.novel/snapshots/001.snapshot.json`,
      JSON.stringify({ chapterId: "chapter-1", chapterNumber: 1, summary: "snap-1" }),
    )
    fsState.files.set(
      `${PROJECT}/.novel/snapshots/002.snapshot.json`,
      JSON.stringify({ chapterId: "chapter-2", chapterNumber: 2, summary: "snap-2" }),
    )
    fsState.files.set(
      `${PROJECT}/.novel/snapshots/003.snapshot.json`,
      JSON.stringify({ chapterId: "chapter-3", chapterNumber: 3, summary: "snap-3" }),
    )

    const pending = exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeMeta: false,
    })

    // 3 个 loadSnapshot 底层 readFile 同时 in-flight —— 串行 for 实现峰值恒为 1。
    await vi.waitFor(() => expect(fsState.inFlight).toBe(3), { timeout: 2000, interval: 10 })
    expect(fsState.peak).toBe(3)

    // 乱序放行：003 先完成、002 其次、001 最后 —— 写盘顺序仍必须为 001→002→003。
    fsState.release(`${PROJECT}/.novel/snapshots/003.snapshot.json`)
    fsState.release(`${PROJECT}/.novel/snapshots/002.snapshot.json`)
    fsState.release(`${PROJECT}/.novel/snapshots/001.snapshot.json`)

    const result = await pending
    expect(result.success).toBe(true)
    expect(fsState.writes.map((w) => w.path)).toEqual([
      `${OUT}/snapshots/001.snapshot.json`,
      `${OUT}/snapshots/002.snapshot.json`,
      `${OUT}/snapshots/003.snapshot.json`,
    ])
    // 内容与对应 num 快照一致（解析后校验，避免依赖 normalize 全字段展开）。
    const contentByPath = new Map(fsState.writes.map((w) => [w.path, JSON.parse(w.content)]))
    expect(contentByPath.get(`${OUT}/snapshots/001.snapshot.json`)?.summary).toBe("snap-1")
    expect(contentByPath.get(`${OUT}/snapshots/003.snapshot.json`)?.summary).toBe("snap-3")
  })

  it("草稿章跳过、读失败章跳过、缺 title 回退文件名", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.directories.set(`${PROJECT}/wiki/chapters`, [
      { name: "draft.md", path: `${PROJECT}/wiki/chapters/draft.md`, is_dir: false },
      { name: "broken.md", path: `${PROJECT}/wiki/chapters/broken.md`, is_dir: false },
      { name: "notitle.md", path: `${PROJECT}/wiki/chapters/notitle.md`, is_dir: false },
      { name: "ok.md", path: `${PROJECT}/wiki/chapters/ok.md`, is_dir: false },
    ])
    fsState.files.set(
      `${PROJECT}/wiki/chapters/draft.md`,
      "---\nchapter_number: 9\ntitle: 草稿\nchapter_status: draft\n---\n草稿正文",
    )
    // broken.md 在目录列表中但无文件内容 → readFile ENOENT → 跳过
    fsState.files.set(
      `${PROJECT}/wiki/chapters/notitle.md`,
      "---\nchapter_number: 2\nchapter_status: final\n---\n无题正文",
    )
    fsState.files.set(
      `${PROJECT}/wiki/chapters/ok.md`,
      "---\nchapter_number: 1\ntitle: 一号\nchapter_status: final\n---\n一号正文",
    )

    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeSnapshots: false,
      includeMeta: false,
    })
    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(2)
    const out = fsState.writes[0].content
    expect(out).toContain("# 一号")
    expect(out).toContain("# notitle")
    expect(out).not.toContain("草稿")
    expect(out).not.toContain("broken")
  })

  it("listDirectory 抛错时章节段降级为空（仍写出空 complete-novel.md）", async () => {
    fsState.reset()
    fsState.bypassGates = true
    vi.mocked(listDirectory).mockRejectedValueOnce(new Error("boom"))
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeSnapshots: false,
      includeMeta: false,
    })
    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(0)
    expect(fsState.writes[0].content).toBe("")
  })

  it("chapter_number 非数字/缺失 → num 归 0 仍导出（ternary 反分支）", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.directories.set(`${PROJECT}/wiki/chapters`, [
      { name: "nosc.md", path: `${PROJECT}/wiki/chapters/nosc.md`, is_dir: false },
      { name: "strnum.md", path: `${PROJECT}/wiki/chapters/strnum.md`, is_dir: false },
    ])
    // 缺 chapter_number（只有 title/status）
    fsState.files.set(
      `${PROJECT}/wiki/chapters/nosc.md`,
      "---\ntitle: 无序号\nchapter_status: final\n---\n正文A",
    )
    // chapter_number 是字符串（parseFrontmatter 字符串化）
    fsState.files.set(
      `${PROJECT}/wiki/chapters/strnum.md`,
      "---\nchapter_number: 三\ntitle: 字符串序号\nchapter_status: final\n---\n正文B",
    )
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeSnapshots: false,
      includeMeta: false,
    })
    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(2)
    const out = fsState.writes[0].content
    expect(out).toContain("# 无序号")
    expect(out).toContain("# 字符串序号")
  })

  it("导出 meta 三件套（character-states / foreshadowing / cognition 存在时写盘，cognition 缺失时跳过）", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.files.set(
      `${PROJECT}/.novel/character-states.json`,
      JSON.stringify({ characters: [{ name: "林动", state: "ok" }] }),
    )
    fsState.files.set(
      `${PROJECT}/.novel/foreshadowing-tracker.json`,
      JSON.stringify({ items: [{ name: "匕首", status: "planted", plantedChapter: 1 }] }),
    )
    fsState.files.set(
      `${PROJECT}/.novel/cognition-state.json`,
      JSON.stringify({ characters: [], readerKnows: [], lastUpdatedChapter: 1 }),
    )

    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeSnapshots: false,
    })
    expect(result.success).toBe(true)
    const metaWrites = fsState.writes.filter((w) => w.path.startsWith(`${OUT}/meta/`))
    expect(metaWrites.map((w) => w.path).sort()).toEqual([
      `${OUT}/meta/character-states.json`,
      `${OUT}/meta/cognition-state.json`,
      `${OUT}/meta/foreshadowing-tracker.json`,
    ])
    expect(JSON.parse(metaWrites[0].content).characters[0].name).toBe("林动")
  })

  it("meta 段 loadCharacterStates 抛错时降级跳过", async () => {
    fsState.reset()
    fsState.bypassGates = true
    // character-states.json 内容为非法 JSON → loadCharacterStates throw
    fsState.files.set(`${PROJECT}/.novel/character-states.json`, "{bad json")
    fsState.files.set(
      `${PROJECT}/.novel/cognition-state.json`,
      JSON.stringify({ characters: [], readerKnows: [], lastUpdatedChapter: 1 }),
    )
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeSnapshots: false,
    })
    expect(result.success).toBe(true)
    const metaWrites = fsState.writes.filter((w) => w.path.startsWith(`${OUT}/meta/`))
    expect(metaWrites.map((w) => w.path)).not.toContain(`${OUT}/meta/character-states.json`)
    expect(metaWrites.map((w) => w.path)).toContain(`${OUT}/meta/cognition-state.json`)
  })

  it("cognition-state.json 缺失时 meta 段跳过 cognition 写盘", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.files.set(
      `${PROJECT}/.novel/character-states.json`,
      JSON.stringify({ characters: [] }),
    )
    fsState.files.set(
      `${PROJECT}/.novel/foreshadowing-tracker.json`,
      JSON.stringify({ items: [] }),
    )
    // 本 spec 的 fileExists mock 恒 true，这里按认知文件不存在放行一次
    vi.mocked(fileExists).mockResolvedValueOnce(false)
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeSnapshots: false,
    })
    expect(result.success).toBe(true)
    const metaWrites = fsState.writes.filter((w) => w.path.startsWith(`${OUT}/meta/`))
    expect(metaWrites.map((w) => w.path).sort()).toEqual([
      `${OUT}/meta/character-states.json`,
      `${OUT}/meta/foreshadowing-tracker.json`,
    ])
  })

  it("loadSnapshot 返回 null 的快照不写盘（其余照写）", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.directories.set(`${PROJECT}/.novel/snapshots`, [
      { name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false },
      { name: "002.snapshot.json", path: `${PROJECT}/.novel/snapshots/002.snapshot.json`, is_dir: false },
    ])
    fsState.files.set(
      `${PROJECT}/.novel/snapshots/001.snapshot.json`,
      JSON.stringify({ chapterId: "chapter-1", chapterNumber: 1, summary: "snap-1" }),
    )
    // 002 无内容 → loadSnapshot null → 跳过
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeMeta: false,
    })
    expect(result.success).toBe(true)
    expect(fsState.writes.map((w) => w.path)).toEqual([`${OUT}/snapshots/001.snapshot.json`])
  })

  it("顶层 createDirectory 失败返回 success:false（Error 实例）", async () => {
    fsState.reset()
    vi.mocked(createDirectory).mockRejectedValueOnce(new Error("no perms"))
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeSnapshots: false,
      includeMeta: false,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe("no perms")
    expect(result.chapterCount).toBe(0)
  })

  it("顶层非 Error 失败也用 String(error) 兜底", async () => {
    fsState.reset()
    vi.mocked(createDirectory).mockRejectedValueOnce("plain-failure")
    const result = await exportProject({
      projectPath: PROJECT,
      exportPath: OUT,
      includeChapters: false,
      includeSnapshots: false,
      includeMeta: false,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe("plain-failure")
  })
})

describe("exportNovelDocx（Phase 1 统一导出）", () => {
  it("final 章节按 num 排序传给 Rust 命令，返回结果透传", async () => {
    fsState.reset()
    fsState.bypassGates = true
    fsState.files.set(`${PROJECT}/wiki/chapters/001.md`, [
      "---",
      "chapter_number: 1",
      "title: 第一章 开端",
      "chapter_status: final",
      "---",
      "雨停了。",
      "",
      "他推开门。",
    ].join("\n"))
    fsState.files.set(`${PROJECT}/wiki/chapters/002.md`, [
      "---",
      "chapter_number: 2",
      "title: 第二章 远行",
      "chapter_status: final",
      "---",
      "风很大。",
    ].join("\n"))
    fsState.files.set(`${PROJECT}/wiki/chapters/003.md`, [
      "---",
      "chapter_number: 3",
      "title: 第三章 草稿",
      "chapter_status: draft",
      "---",
      "未完成。",
    ].join("\n"))
    fsState.directories.set(`${PROJECT}/wiki/chapters`, [
      { name: "001.md", path: `${PROJECT}/wiki/chapters/001.md`, is_dir: false },
      { name: "002.md", path: `${PROJECT}/wiki/chapters/002.md`, is_dir: false },
      { name: "003.md", path: `${PROJECT}/wiki/chapters/003.md`, is_dir: false },
    ])

    const invokeMock = vi.mocked(invoke)
    invokeMock.mockResolvedValueOnce({
      success: true,
      exportedPath: `${PROJECT}/complete-novel.docx`,
      chapterCount: 2,
      message: "exported 2 chapters",
    })

    const result = await exportNovelDocx({
      projectPath: PROJECT,
      exportPath: `${PROJECT}/complete-novel.docx`,
    })

    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(2)
    // draft 章被过滤，final 章按 num 排序（1 在 2 前）
    expect(invokeMock).toHaveBeenCalledWith("export_novel_docx", {
      chapters: [
        { title: "第一章 开端", body: "雨停了。\n\n他推开门。" },
        { title: "第二章 远行", body: "风很大。" },
      ],
      exportPath: `${PROJECT}/complete-novel.docx`,
    })
  })

  it("invoke 抛错时返回 success:false 并透传消息", async () => {
    fsState.reset()
    vi.mocked(invoke).mockRejectedValueOnce(new Error("pack failed"))
    const result = await exportNovelDocx({
      projectPath: PROJECT,
      exportPath: `${PROJECT}/complete-novel.docx`,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe("pack failed")
  })

  it("无章节目录时降级为空列表仍调用命令", async () => {
    fsState.reset()
    vi.mocked(invoke).mockResolvedValueOnce({
      success: true,
      exportedPath: `${PROJECT}/complete-novel.docx`,
      chapterCount: 0,
      message: "exported 0 chapters",
    })
    const result = await exportNovelDocx({
      projectPath: PROJECT,
      exportPath: `${PROJECT}/complete-novel.docx`,
    })
    expect(result.success).toBe(true)
    expect(result.chapterCount).toBe(0)
  })
})
