/**
 * read-outline.ts 行为覆盖：直接读取 / 目录与模糊纠错 / 快照回落的分支边界。
 *
 * 关键回归（源码注释 PAT/ISS-20260709-024 同源）：
 *   - 只有「给我大纲 / outline(s)」这种宽泛请求才回落 `.novel/snapshots`；
 *     路径里只是含「大纲」二字（如 大纲/章纲）不得被当成快照请求。
 *   - 快照回落按 outline-<N>.snapshot.md 的编号升序拼接，最多 8 个；
 *     单个快照读取失败或内容为空不影响其它快照。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
    readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  }
})

import { createReadOutlineTool } from "./read-outline"

const OUTLINES_DIR = "/novel/wiki/outlines"
const SNAPSHOT_DIR = "/novel/.novel/snapshots"

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dir(name: string, path: string): FileNode {
  return { name, path, is_dir: true }
}

/** 读文件桩：只有列出的路径可读，其它一律 ENOENT（与真实 fs 行为一致）。 */
function reader(contents: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    const hit = contents[path]
    if (hit === undefined) throw new Error("ENOENT: no such file or directory")
    return hit
  }
}

beforeEach(() => {
  fsMocks.listDirectory.mockReset()
  fsMocks.readFile.mockReset()
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
})

describe("createReadOutlineTool — 直接读取", () => {
  it("用 name 命中大纲文件：返回正文，并把 params.path 回填为实际文件路径", async () => {
    const tool = createReadOutlineTool(
      OUTLINES_DIR,
      reader({ [`${OUTLINES_DIR}/第一卷.md`]: "# 第一卷大纲\n\n正文" }),
    )
    const params: Record<string, unknown> = { name: "第一卷" }

    await expect(tool.execute(params)).resolves.toBe("# 第一卷大纲\n\n正文")
    expect(params.path).toBe(`${OUTLINES_DIR}/第一卷.md`)
    expect(params.name).toBe("第一卷")
  })

  it("用 path 命中大纲文件：name 缺失时用文件名回填（不带 .md 后缀）", async () => {
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({ [`${OUTLINES_DIR}/章纲`]: "章纲正文" }))
    const params: Record<string, unknown> = { path: "章纲" }

    await expect(tool.execute(params)).resolves.toBe("章纲正文")
    expect(params.path).toBe(`${OUTLINES_DIR}/章纲`)
    expect(params.name).toBe("章纲")
  })

  it("name 命中目录时返回可读条目清单（不是快照回落）", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === OUTLINES_DIR) return [dir("章纲", `${OUTLINES_DIR}/章纲`), file("总纲.md", `${OUTLINES_DIR}/总纲.md`)]
      if (path === `${OUTLINES_DIR}/章纲`) {
        return [file("第一章.md", `${OUTLINES_DIR}/章纲/第一章.md`), file("第二章.md", `${OUTLINES_DIR}/章纲/第二章.md`)]
      }
      throw new Error("ENOENT")
    })
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({}))

    const result = await tool.execute({ name: "章纲" })

    expect(result).toBe("「章纲」是目录，不是单个大纲。可读取以下条目：\n1. 第一章\n2. 第二章")
    // 只有候选枚举读了 outlines 根目录，快照目录没被碰。
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(OUTLINES_DIR)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(SNAPSHOT_DIR)
  })
})

describe("createReadOutlineTool — 非宽泛请求不回落快照", () => {
  it("name 只是含「大纲」字样的目录名时保持错误结果，不去读快照", async () => {
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({}))

    const result = await tool.execute({ name: "大纲/章纲" })

    expect(result).toBe("错误：无法读取大纲「大纲/章纲」，请确认文件存在")
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(OUTLINES_DIR)
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(SNAPSHOT_DIR)
  })

  it("找不到文件且候选为空时给出「请确认文件存在」，不回落快照", async () => {
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({}))

    const result = await tool.execute({ name: "第三卷" })

    expect(result).toBe("错误：无法读取大纲「第三卷」，请确认文件存在")
    expect(fsMocks.listDirectory).not.toHaveBeenCalledWith(SNAPSHOT_DIR)
  })

  it("候选非空时列出可用候选（帮助模型自我纠错）", async () => {
    fsMocks.listDirectory.mockResolvedValue([file("第一卷.md", `${OUTLINES_DIR}/第一卷.md`)])
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({}))

    const result = await tool.execute({ name: "第三卷" })

    expect(result).toBe("错误：无法读取大纲「第三卷」。可用候选：\n1. 第一卷")
  })
})

describe("createReadOutlineTool — 宽泛请求回落大纲快照", () => {
  function seedSnapshots(nodes: FileNode[], contents: Record<string, string>): (path: string) => Promise<string> {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === OUTLINES_DIR) return []
      if (path === SNAPSHOT_DIR) return nodes
      throw new Error("ENOENT")
    })
    return reader(contents)
  }

  it("name=「大纲」时按编号升序拼接快照，忽略目录与非快照文件", async () => {
    const tool = createReadOutlineTool(
      OUTLINES_DIR,
      seedSnapshots(
        [
          file("outline-10.snapshot.md", `${SNAPSHOT_DIR}/outline-10.snapshot.md`),
          file("outline-2.snapshot.md", `${SNAPSHOT_DIR}/outline-2.snapshot.md`),
          file("outline-1.snapshot.md", `${SNAPSHOT_DIR}/outline-1.snapshot.md`),
          file("notes.md", `${SNAPSHOT_DIR}/notes.md`),
          dir("outline-99.snapshot.md", `${SNAPSHOT_DIR}/outline-99.snapshot.md`),
        ],
        {
          [`${SNAPSHOT_DIR}/outline-1.snapshot.md`]: "第一章线",
          [`${SNAPSHOT_DIR}/outline-2.snapshot.md`]: "第二章线",
          [`${SNAPSHOT_DIR}/outline-10.snapshot.md`]: "第十章线",
        },
      ),
    )

    const result = await tool.execute({ name: "大纲" })

    expect(result).toBe(
      [
        "未找到 wiki/outlines 下的独立大纲文件，已读取大纲快照：",
        "",
        "## outline-1.snapshot.md",
        "",
        "第一章线",
        "## outline-2.snapshot.md",
        "",
        "第二章线",
        "## outline-10.snapshot.md",
        "",
        "第十章线",
      ].join("\n"),
    )
    expect(fsMocks.listDirectory).toHaveBeenCalledWith(SNAPSHOT_DIR)
  })

  it("单个快照读取失败或内容为空时跳过，其余照常拼接", async () => {
    const tool = createReadOutlineTool(
      OUTLINES_DIR,
      seedSnapshots(
        [
          file("outline-1.snapshot.md", `${SNAPSHOT_DIR}/outline-1.snapshot.md`),
          file("outline-2.snapshot.md", `${SNAPSHOT_DIR}/outline-2.snapshot.md`),
          file("outline-3.snapshot.md", `${SNAPSHOT_DIR}/outline-3.snapshot.md`),
        ],
        {
          [`${SNAPSHOT_DIR}/outline-1.snapshot.md`]: "可读快照",
          [`${SNAPSHOT_DIR}/outline-2.snapshot.md`]: "   \n ",
          // outline-3 读取抛错
        },
      ),
    )

    const result = await tool.execute({ name: "outlines" })

    expect(result).toContain("## outline-1.snapshot.md")
    expect(result).toContain("可读快照")
    expect(result).not.toContain("outline-2.snapshot.md")
    expect(result).not.toContain("outline-3.snapshot.md")
  })

  it("快照超过 8 个时只取编号最小的 8 个", async () => {
    const nodes = Array.from({ length: 10 }, (_, index) =>
      file(`outline-${index + 1}.snapshot.md`, `${SNAPSHOT_DIR}/outline-${index + 1}.snapshot.md`),
    )
    const contents: Record<string, string> = {}
    for (const node of nodes) contents[node.path] = `内容${node.name}`
    const tool = createReadOutlineTool(OUTLINES_DIR, seedSnapshots(nodes, contents))

    const result = await tool.execute({ path: "大纲" })

    expect(result.match(/^## outline-/gm)).toHaveLength(8)
    expect(result).toContain("## outline-8.snapshot.md")
    expect(result).not.toContain("## outline-9.snapshot.md")
  })

  it("Windows 反斜杠 + 结尾斜杠的大纲目录也能推导出快照目录", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "E:/Novel/wiki/outlines") return []
      if (path === "E:/Novel/.novel/snapshots") {
        return [file("outline-1.snapshot.md", "E:/Novel/.novel/snapshots/outline-1.snapshot.md")]
      }
      throw new Error("ENOENT")
    })
    const tool = createReadOutlineTool("E:\\Novel\\wiki\\outlines\\", reader({
      "E:/Novel/.novel/snapshots/outline-1.snapshot.md": "首章线",
    }))

    const result = await tool.execute({ name: "大纲" })

    expect(result).toContain("## outline-1.snapshot.md")
    expect(result).toContain("首章线")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("E:/Novel/.novel/snapshots")
  })

  it("快照目录列举失败时回退到原始错误结果（不抛错）", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === OUTLINES_DIR) return []
      throw new Error("EACCES: permission denied")
    })
    const tool = createReadOutlineTool(OUTLINES_DIR, reader({}))

    await expect(tool.execute({ name: "大纲" })).resolves.toBe("错误：无法读取大纲「大纲」，请确认文件存在")
  })

  it("目录里没有符合命名的快照文件时回退到原始错误结果", async () => {
    const tool = createReadOutlineTool(
      OUTLINES_DIR,
      seedSnapshots([file("notes.md", `${SNAPSHOT_DIR}/notes.md`), dir("cache", `${SNAPSHOT_DIR}/cache`)], {}),
    )

    await expect(tool.execute({ name: "大纲" })).resolves.toBe("错误：无法读取大纲「大纲」，请确认文件存在")
  })

  it("所有快照都读不出来时回退到原始错误结果", async () => {
    const tool = createReadOutlineTool(
      OUTLINES_DIR,
      seedSnapshots([file("outline-1.snapshot.md", `${SNAPSHOT_DIR}/outline-1.snapshot.md`)], {}),
    )

    await expect(tool.execute({ name: "大纲" })).resolves.toBe("错误：无法读取大纲「大纲」，请确认文件存在")
  })

  it("大纲目录不在 wiki|QM/outlines 下时无法推导项目路径，直接回退原始错误", async () => {
    const tool = createReadOutlineTool("/novel/outlines", reader({}))

    await expect(tool.execute({ name: "大纲" })).resolves.toBe("错误：无法读取大纲「大纲」，请确认文件存在")
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("/novel/outlines")
  })
})
