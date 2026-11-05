import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * outline-model-store 的**缺省 fs deps** 路径（不注入 readText/writeText/ensureDir）。
 *
 * 既有 outline-model-store.spec.ts 全程注入内存 deps（D3 纪律），因此
 * `createFsDeps()` 里三个缺省实现体（readText 的 catch → null、writeText →
 * writeFileAtomic、ensureDir → createDirectory）从未被执行。本文件把 `@/commands/fs`
 * 换成内存 mock（仍是同一 IPC 契约形状），只验证缺省 deps 的接线与失败降级：
 *   - 缺省 readText 读不到（FS 层 reject）→ 按「没有侧车」返回 null，不抛错；
 *   - 缺省 readText 读到内容 → 正常解析；
 *   - 缺省 ensureDir / writeText → 分别落到 createDirectory / writeFileAtomic，
 *     参数为 `.novel` 目录与侧车路径。
 */
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
  }
})

import { OUTLINE_MODEL_SCHEMA_VERSION, outlineChapterId, type OutlineModel } from "./outline-model"
import { loadOutlineModel, saveOutlineModel } from "./outline-model-store"

function buildModel(): OutlineModel {
  return {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    updatedAt: "2026-11-05",
    volumes: [
      {
        number: 1,
        title: "启程",
        arc: "少年出山",
        chapters: [
          {
            id: outlineChapterId(1, 1),
            volume: 1,
            chapter: 1,
            title: "断桥",
            pov: "",
            arc: "",
            entities: [],
            foreshadow: { plant: [], payoff: [] },
            constraints: [],
            prose: { goal: "", scenes: [], emotion: "" },
            updatedAt: "2026-11-05",
          },
        ],
      },
    ],
  }
}

describe("outline-model-store 缺省 fs deps（不注入 deps 时的接线与降级）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("缺省 readText：FS 层 reject（无侧车）→ resolves 且 model 为 null、无 error", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"))
    const result = await loadOutlineModel("C:/novel/")

    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/novel/.novel/outline-model.json")
    expect(result.model).toBeNull()
    expect(result.migratedFrom).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("缺省 readText：读到内容 → 正常解析出模型（与注入路径同结果）", async () => {
    const model = buildModel()
    fsMocks.readFile.mockResolvedValue(JSON.stringify(model, null, 2))

    const result = await loadOutlineModel("C:/novel")

    expect(result.error).toBeUndefined()
    expect(result.model?.volumes[0].chapters[0].title).toBe("断桥")
  })

  it("缺省 ensureDir + writeText：落到 createDirectory / writeFileAtomic（路径与字节形态固定）", async () => {
    const model = buildModel()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const { path } = await saveOutlineModel("C:/novel/", model)

    expect(path).toBe("C:/novel/.novel/outline-model.json")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("C:/novel/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "C:/novel/.novel/outline-model.json",
      JSON.stringify(model, null, 2),
    )
  })
})
