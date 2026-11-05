/**
 * exportDraft 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：完整导出结构/premise 省略/文件名来源与清洗截断/目录创建。
 * 文件写入一律 mock，不触碰真实文件系统。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import type { StoryDraft, StoryFramework } from "./types"
import { exportDraft } from "./draft-export"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
}))

const mockedMkdir = vi.mocked(createDirectory)
const mockedWrite = vi.mocked(writeFileAtomic)

function framework(overrides: Partial<StoryFramework> = {}): StoryFramework {
  return {
    id: "fw-1",
    title: "完整标题：勇者传说",
    shortTitle: "勇者",
    premise: "一个关于勇气的故事",
    targetWords: 10000,
    simulationMode: "hybrid",
    sourceChapters: 2,
    nodes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function draft(): StoryDraft {
  return {
    branchId: "b-1",
    frameworkId: "fw-1",
    chapters: [
      { title: "第一章 启程", content: "正文一", correspondingNode: 0 },
      { title: "第二章 决战", content: "正文二", correspondingNode: 1 },
    ],
    totalWords: 5200,
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

function written(): { path: string; content: string } {
  expect(mockedWrite).toHaveBeenCalledTimes(1)
  return {
    path: String(mockedWrite.mock.calls[0]?.[0] ?? ""),
    content: String(mockedWrite.mock.calls[0]?.[1] ?? ""),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("exportDraft 完整导出", () => {
  it("渲染标题/元信息/前提/章节并返回路径", async () => {
    const filePath = await exportDraft("/proj", framework(), draft())

    expect(mockedMkdir).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/exports",
    )
    expect(filePath).toContain("/proj/.niko-buddy/simulations/exports/")
    expect(filePath).toContain("故事草稿_勇者_")
    expect(filePath.endsWith(".md")).toBe(true)
    // shortTitle 优先于完整标题
    expect(filePath).not.toContain("完整标题")
    // 时间戳中的 : . 已被替换
    expect(filePath).not.toMatch(/:\d\d\./)
    expect(written().path).toBe(filePath)

    const content = written().content
    expect(content).toContain("# 完整标题：勇者传说")
    expect(content).toContain("> 生成时间：")
    expect(content).toContain("> 目标字数：10000")
    expect(content).toContain("> 实际字数：5200")
    expect(content).toContain(">")
    expect(content).toContain("> 一个关于勇气的故事")
    expect(content).toContain("## 第一章 启程")
    expect(content).toContain("正文一")
    expect(content).toContain("## 第二章 决战")
    expect(content).toContain("正文二")
    // 章节顺序保持草稿顺序
    expect(content.indexOf("## 第一章")).toBeLessThan(content.indexOf("## 第二章"))
  })

  it("无 premise 时省略前提行", async () => {
    await exportDraft("/proj", framework({ premise: "" }), draft())
    const content = written().content
    expect(content).toContain("> 实际字数：5200")
    expect(content).not.toContain("> 一个关于勇气的故事")
    // 空 premise 不输出孤立的引用行
    expect(content).not.toMatch(/^>$/m)
  })
})

describe("exportDraft 文件命名", () => {
  it("无 shortTitle 时用完整标题并清洗非法字符", async () => {
    const filePath = await exportDraft(
      "/proj",
      framework({ shortTitle: undefined, title: 'a/b:c*d?e"f<g>h|i' }),
      draft(),
    )
    expect(filePath).toMatch(/故事草稿_a_b_c_d_e_f_g_h_i_/)
  })

  it("超长标题截断到 30 字", async () => {
    const filePath = await exportDraft(
      "/proj",
      framework({ shortTitle: undefined, title: "超".repeat(40) }),
      draft(),
    )
    const fileName = filePath.split("/").pop() ?? ""
    const titlePart = fileName.replace("故事草稿_", "").split(/_\d{4}-/)[0] ?? ""
    expect(titlePart.length).toBeLessThanOrEqual(30)
  })
})
