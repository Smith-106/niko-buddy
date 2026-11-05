import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { detectLocalEntityMiss, hasLocalEntityMention, listLocalEntityNames } from "./local-entity-names"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: (...args: unknown[]) => mocks.listDirectory(...args),
  }
})

const file = (name: string): FileNode => ({ name, path: `/proj/${name}`, is_dir: false })
const dir = (name: string, children?: FileNode[]): FileNode => ({
  name,
  path: `/proj/${name}`,
  is_dir: true,
  children,
})

function mockDirs(dirs: Record<string, FileNode[] | "throw">) {
  mocks.listDirectory.mockImplementation(async (path: unknown) => {
    const hit = Object.entries(dirs).find(([suffix]) => (path as string).endsWith(suffix))
    if (!hit) throw new Error(`unexpected path ${path}`)
    if (hit[1] === "throw") throw new Error("ENOENT")
    return hit[1]
  })
}

beforeEach(() => {
  mocks.listDirectory.mockReset()
})

describe("listLocalEntityNames", () => {
  it("递归收集三个实体目录的 .md 文件名（去扩展名，大小写不敏感），单字名与非 md 被过滤", async () => {
    mockDirs({
      "wiki/entities": [
        file("白曦.md"),
        file("readme.txt"),
        dir("支线", [file("配角.md"), file("NOTE.MD")]),
        dir("空目录"),
        file("a.md"),
      ],
      "wiki/characters": "throw",
      "wiki/concepts": [file("苏澈.md"), file("ab.md"), file("cd.MD")],
    })

    const names = await listLocalEntityNames("C:\\proj\\wiki-proj")

    // 中文按拼音排序、拉丁字母垫后；缺失目录被忽略
    expect(names).toEqual(["白曦", "配角", "苏澈", "ab", "cd", "NOTE"])
    expect(mocks.listDirectory).toHaveBeenCalledTimes(3)
  })

  it("三个目录都不存在 → 空表", async () => {
    mockDirs({
      "wiki/entities": "throw",
      "wiki/characters": "throw",
      "wiki/concepts": "throw",
    })

    await expect(listLocalEntityNames("/proj/x")).resolves.toEqual([])
  })

  it("同名文件跨目录去重", async () => {
    mockDirs({
      "wiki/entities": [file("白曦.md")],
      "wiki/characters": [file("白曦.md")],
      "wiki/concepts": [],
    })

    await expect(listLocalEntityNames("/proj/x")).resolves.toEqual(["白曦"])
  })
})

describe("hasLocalEntityMention", () => {
  it("命中任一实体名 → true", () => {
    expect(hasLocalEntityMention("白曦今晚去哪里了？", ["白曦", "苏澈"])).toBe(true)
  })

  it("未命中 → false", () => {
    expect(hasLocalEntityMention("今晚吃什么", ["白曦"])).toBe(false)
  })

  it("空消息或空表 → false", () => {
    expect(hasLocalEntityMention("   ", ["白曦"])).toBe(false)
    expect(hasLocalEntityMention("白曦", [])).toBe(false)
  })

  it("单字名不参与匹配（名称长度 ≥ 2 才算）", () => {
    expect(hasLocalEntityMention("a 出现了", ["a", "白曦"])).toBe(false)
  })
})

describe("detectLocalEntityMiss", () => {
  it("消息命中实体名 → 不 miss", async () => {
    mockDirs({
      "wiki/entities": [file("白曦.md")],
      "wiki/characters": [],
      "wiki/concepts": [],
    })

    await expect(detectLocalEntityMiss("/proj/x", "讲讲白曦的身世")).resolves.toBe(false)
  })

  it("消息未命中任何实体名 → miss", async () => {
    mockDirs({
      "wiki/entities": [file("白曦.md")],
      "wiki/characters": [],
      "wiki/concepts": [],
    })

    await expect(detectLocalEntityMiss("/proj/x", "讲讲龙傲天的身世")).resolves.toBe(true)
  })

  it("实体表为空 → miss", async () => {
    mockDirs({
      "wiki/entities": [],
      "wiki/characters": "throw",
      "wiki/concepts": [],
    })

    await expect(detectLocalEntityMiss("/proj/x", "白曦")).resolves.toBe(true)
  })
})
