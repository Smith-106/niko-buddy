// sidebar-helpers：章节标题汇总的逐项降级（解析异常 → 回退文件名）。
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    listDirectory: fsMocks.listDirectory,
    fileExists: fsMocks.fileExists,
  }
})

import { getExistingChapterTitles } from "./sidebar-helpers"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getExistingChapterTitles 逐项降级", () => {
  it("解析回归：title 命中取 title，缺 title 取文件名", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "ch-1.md", path: "/p/wiki/chapters/ch-1.md", is_dir: false },
      { name: "ch-2.md", path: "/p/wiki/chapters/ch-2.md", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("ch-1.md") ? "---\ntitle: 第一章\n---\n" : "正文无 frontmatter",
    )
    const titles = await getExistingChapterTitles("/p")
    expect([...titles].sort()).toEqual(["ch 2", "第一章"])
  })

  it("单章读回非字符串 → 解析抛错被 catch，回退文件名（不拖垮其余章）", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "bad-chapter.md", path: "/p/wiki/chapters/bad-chapter.md", is_dir: false },
      { name: "good-chapter.md", path: "/p/wiki/chapters/good-chapter.md", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("bad-chapter.md")
        ? (undefined as unknown as string)
        : "---\ntitle: 好章\n---\n",
    )
    const titles = await getExistingChapterTitles("/p")
    expect(titles.has("bad chapter")).toBe(true)
    expect(titles.has("好章")).toBe(true)
  })
})
