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
      // 门闩：未 release 前保持 in-flight，用于观测并发峰值与乱序完成。
      await new Promise<void>((resolve) => {
        const waiters = fsState.gateWaiters.get(key) ?? []
        waiters.push(resolve)
        fsState.gateWaiters.set(key, waiters)
      })
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

import { exportProject } from "./export"

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
})
