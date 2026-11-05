/**
 * entity-subdir-resolver 行为 spec — 双态兼容（子目录化 + 迁移期扁平）路径解析。
 *
 * 覆盖：
 *   - entitySubdirOf：subtype → 子目录；未知/空 → null；event/record/system 统一入 events。
 *   - resolveEntityPath 写路径：subtype 优先、tags 回退、无分类信息回退扁平、.md 去重后缀。
 *   - resolveEntityPath 读路径：子目录优先命中、全未命中回退扁平、单次探测抛错不中断。
 *   - listEntityFiles：目录缺失容错空数组、递归聚合子目录 + 顶层散装、name 去 .md。
 *
 * fs 层全部 mock（无 Tauri 依赖）；路径语义按模块注释使用 wiki/ 逻辑名。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string) => false),
  listDirectory: vi.fn(async (_path: string): Promise<unknown[]> => []),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: fsMocks.fileExists,
    listDirectory: fsMocks.listDirectory,
  }
})

import {
  ENTITY_SUBDIRS,
  entitySubdirOf,
  resolveEntityPath,
  listEntityFiles,
} from "./entity-subdir-resolver"

const PROJECT = "C:/proj/demo/"

beforeEach(() => {
  fsMocks.fileExists.mockReset().mockResolvedValue(false)
  fsMocks.listDirectory.mockReset().mockResolvedValue([])
})

describe("entitySubdirOf：subtype → 子目录", () => {
  it("空/未定义 subtype → null（无分类信息）", () => {
    expect(entitySubdirOf()).toBeNull()
    expect(entitySubdirOf(null)).toBeNull()
    expect(entitySubdirOf("")).toBeNull()
  })

  it("五个实体分类各自落对应子目录（events 收拢 event/record/system）", () => {
    expect(entitySubdirOf("character")).toBe("characters")
    expect(entitySubdirOf("item")).toBe("items")
    expect(entitySubdirOf("location")).toBe("locations")
    expect(entitySubdirOf("organization")).toBe("organizations")
    expect(entitySubdirOf("event")).toBe("events")
    expect(entitySubdirOf("record")).toBe("events")
    expect(entitySubdirOf("system")).toBe("events")
  })

  it("未登记 subtype → null（不猜目录）", () => {
    expect(entitySubdirOf("chapter")).toBeNull()
    expect(entitySubdirOf("Characters")).toBeNull()
  })

  it("ENTITY_SUBDIRS 为物理目录单一事实源（顺序即读路径探测顺序）", () => {
    expect([...ENTITY_SUBDIRS]).toEqual([
      "characters",
      "items",
      "locations",
      "organizations",
      "events",
    ])
  })
})

describe("resolveEntityPath：写路径（forWrite）", () => {
  it("subtype 优先于 tags → 落子目录", async () => {
    await expect(
      resolveEntityPath(PROJECT, "林澈", { forWrite: true, subtype: "character", tags: ["item"] }),
    ).resolves.toBe("C:/proj/demo/wiki/entities/characters/林澈.md")
  })

  it("无 subtype 时按 tags 推导；未知 subtype 也回退 tags", async () => {
    await expect(
      resolveEntityPath(PROJECT, "青霜剑", { forWrite: true, tags: ["item"] }),
    ).resolves.toBe("C:/proj/demo/wiki/entities/items/青霜剑.md")
    await expect(
      resolveEntityPath(PROJECT, "青霜剑", { forWrite: true, subtype: "chapter", tags: ["item"] }),
    ).resolves.toBe("C:/proj/demo/wiki/entities/items/青霜剑.md")
  })

  it("无任何分类信息 → 扁平 wiki/entities/<name>.md", async () => {
    await expect(resolveEntityPath(PROJECT, "无名氏", { forWrite: true })).resolves.toBe(
      "C:/proj/demo/wiki/entities/无名氏.md",
    )
  })

  it("nameOrSlug 已带 .md 不产生双后缀（大小写不敏感）", async () => {
    await expect(
      resolveEntityPath(PROJECT, "林澈.MD", { forWrite: true, subtype: "character" }),
    ).resolves.toBe("C:/proj/demo/wiki/entities/characters/林澈.md")
  })

  it("写路径不探测存在性（子目录未建也直接返回目标路径）", async () => {
    await resolveEntityPath(PROJECT, "林澈", { forWrite: true, subtype: "character" })
    expect(fsMocks.fileExists).not.toHaveBeenCalled()
  })
})

describe("resolveEntityPath：读路径（子目录 → 扁平回退）", () => {
  it("子目录命中即返回（迁移后文件）", async () => {
    fsMocks.fileExists.mockImplementation(async (p: string) => p === "C:/proj/demo/wiki/entities/locations/旧城.md")
    await expect(resolveEntityPath(PROJECT, "旧城")).resolves.toBe(
      "C:/proj/demo/wiki/entities/locations/旧城.md",
    )
  })

  it("按 ENTITY_SUBDIRS 顺序探测，命中即短路", async () => {
    const probed: string[] = []
    fsMocks.fileExists.mockImplementation(async (p: string) => {
      probed.push(p)
      return p.includes("/characters/")
    })
    await resolveEntityPath(PROJECT, "林澈")
    expect(probed).toEqual(["C:/proj/demo/wiki/entities/characters/林澈.md"])
  })

  it("全部子目录未命中 → 扁平路径（迁移期散装文件）", async () => {
    const result = await resolveEntityPath(PROJECT, "散装角色")
    expect(result).toBe("C:/proj/demo/wiki/entities/散装角色.md")
    expect(fsMocks.fileExists).toHaveBeenCalledTimes(5)
  })

  it("单次探测抛错不中断，继续后续候选", async () => {
    fsMocks.fileExists.mockImplementation(async (p: string) => {
      if (p.includes("/characters/")) throw new Error("EACCES")
      return p.includes("/events/")
    })
    await expect(resolveEntityPath(PROJECT, "某事件")).resolves.toBe(
      "C:/proj/demo/wiki/entities/events/某事件.md",
    )
  })

  it("项目路径末尾斜杠被归一（不产生双斜杠）", async () => {
    await expect(resolveEntityPath("C:/proj/demo///", "x")).resolves.toBe(
      "C:/proj/demo/wiki/entities/x.md",
    )
  })
})

describe("listEntityFiles：聚合列举", () => {
  it("目录读取失败 → 空数组（容错）", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await expect(listEntityFiles(PROJECT)).resolves.toEqual([])
  })

  it("递归聚合子目录 + 顶层散装，name 去 .md", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "characters", path: "C:/proj/demo/wiki/entities/characters", is_dir: true, children: [
        { name: "林澈.md", path: "C:/proj/demo/wiki/entities/characters/林澈.md", is_dir: false },
      ] },
      { name: "items", path: "C:/proj/demo/wiki/entities/items", is_dir: true, children: [] },
      { name: "散装.md", path: "C:/proj/demo/wiki/entities/散装.md", is_dir: false },
      { name: "notes.txt", path: "C:/proj/demo/wiki/entities/notes.txt", is_dir: false },
    ])
    await expect(listEntityFiles(PROJECT)).resolves.toEqual([
      { name: "林澈", path: "C:/proj/demo/wiki/entities/characters/林澈.md" },
      { name: "散装", path: "C:/proj/demo/wiki/entities/散装.md" },
    ])
  })

  it("列举基准目录为归一后的 wiki/entities（不出现双斜杠）", async () => {
    await listEntityFiles("C:/proj/demo///")
    expect(fsMocks.listDirectory).toHaveBeenCalledWith("C:/proj/demo/wiki/entities")
  })
})
