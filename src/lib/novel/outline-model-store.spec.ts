import { describe, expect, it, vi } from "vitest"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  outlineChapterId,
  outlineModelContentKey,
  type OutlineModel,
} from "./outline-model"
import {
  OUTLINE_MODEL_FILENAME,
  OutlineModelStoreError,
  loadOutlineModel,
  outlineModelFilePath,
  saveOutlineModel,
  type OutlineModelStoreDeps,
} from "./outline-model-store"

/**
 * store 层单测纪律：全部走注入 deps，一次都不碰真实磁盘（D3）。
 */

/** 手写 v1 侧车（schemaVersion=1、章无 pov），用于证明迁移不丢字段。 */
const V1_FIXTURE = JSON.stringify({
  schemaVersion: 1,
  updatedAt: "2026-10-01",
  volumes: [
    {
      number: 1,
      title: "启程",
      arc: "少年出山",
      chapters: [
        {
          id: "v01c001",
          volume: 1,
          chapter: 1,
          title: "断桥",
          arc: "相遇",
          entities: ["李慕白", "苏七"],
          foreshadow: { plant: ["FS-001"], payoff: [] },
          constraints: ["苏七本章不出场"],
          prose: { goal: "第一次照面", scenes: ["雨中破桥对峙"], emotion: "紧张" },
          updatedAt: "2026-10-01",
        },
      ],
    },
  ],
})

function buildV2Model(): OutlineModel {
  return {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    updatedAt: "2026-11-01",
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
            pov: "李慕白",
            arc: "相遇",
            entities: ["李慕白", "苏七"],
            foreshadow: { plant: ["FS-001"], payoff: [] },
            constraints: ["苏七本章不出场"],
            prose: { goal: "第一次照面", scenes: ["雨中破桥对峙"], emotion: "紧张" },
            updatedAt: "2026-11-01",
          },
        ],
      },
    ],
  }
}

function readDeps(raw: unknown): OutlineModelStoreDeps {
  return { readText: async () => raw as string }
}

describe("outline-model-store 路径派生", () => {
  it("① 尾斜杠裁剪：/P/ 与 /P 都得到同一路径", () => {
    expect(outlineModelFilePath("/P/")).toBe("/P/.novel/outline-model.json")
    expect(outlineModelFilePath("/P")).toBe("/P/.novel/outline-model.json")
    expect(outlineModelFilePath("/P")).toBe(`/P/.novel/${OUTLINE_MODEL_FILENAME}`)
  })
})

describe("outline-model-store load 的失败面（D4：绝不降级为空模型）", () => {
  it("② 文件缺失 → model 为 null 且无 error", async () => {
    const result = await loadOutlineModel("/P", { readText: async () => null })
    expect(result).toEqual({ model: null, migratedFrom: null })
    expect(result.error).toBeUndefined()
  })

  it("③ readText 返回 undefined（模拟 conditional-routing 的 mockReset）→ 不抛错、model 为 null", async () => {
    const result = await loadOutlineModel("/P", readDeps(undefined))
    expect(result.model).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it("④ 空串 → model 为 null", async () => {
    const result = await loadOutlineModel("/P", readDeps(""))
    expect(result.model).toBeNull()
  })

  it("⑤ 损坏 JSON → model 为 null 且 error 含「JSON 解析失败」", async () => {
    const result = await loadOutlineModel("/P", readDeps("{not json"))
    expect(result.model).toBeNull()
    expect(result.error).toContain("JSON 解析失败")
  })

  it("⑧ schemaVersion 高于支持版本 → model 为 null 且 error 含「高于支持版本」", async () => {
    const raw = JSON.stringify({ ...JSON.parse(V1_FIXTURE), schemaVersion: 3 })
    const result = await loadOutlineModel("/P", readDeps(raw))
    expect(result.model).toBeNull()
    expect(result.error).toContain("高于支持版本")
  })

  it("⑨ 非法模型（卷内重复章号）→ model 为 null 且 error 含「章号重复」", async () => {
    const raw = JSON.stringify({
      schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
      updatedAt: "2026-11-01",
      volumes: [
        {
          number: 1,
          title: "启程",
          arc: "",
          chapters: [
            { id: "v01c001", volume: 1, chapter: 1, title: "甲", pov: "" },
            { id: "v01c001", volume: 1, chapter: 1, title: "乙", pov: "" },
          ],
        },
      ],
    })
    const result = await loadOutlineModel("/P", readDeps(raw))
    expect(result.model).toBeNull()
    expect(result.error).toContain("章号重复")
  })
})

describe("outline-model-store v1→v2 迁移（迁移在校验之前）", () => {
  it("⑥ v1 fixture 成功迁移且不丢字段", async () => {
    const result = await loadOutlineModel("/P", readDeps(V1_FIXTURE))
    expect(result.error).toBeUndefined()
    expect(result.migratedFrom).toBe(1)
    expect(result.model).not.toBeNull()
    const model = result.model!
    expect(model.schemaVersion).toBe(2)
    expect(model.updatedAt).toBe("2026-10-01")
    const chapter = model.volumes[0].chapters[0]
    expect(chapter.pov).toBe("")
    expect(chapter.title).toBe("断桥")
    expect(chapter.arc).toBe("相遇")
    expect(chapter.entities).toEqual(["李慕白", "苏七"])
    expect(chapter.foreshadow).toEqual({ plant: ["FS-001"], payoff: [] })
    expect(chapter.constraints).toEqual(["苏七本章不出场"])
    expect(chapter.prose).toEqual({
      goal: "第一次照面",
      scenes: ["雨中破桥对峙"],
      emotion: "紧张",
    })
    expect(model.volumes[0].arc).toBe("少年出山")
  })

  it("⑦ 已是 v2 → migratedFrom 为 null 且模型幂等", async () => {
    const model = buildV2Model()
    const result = await loadOutlineModel("/P", readDeps(JSON.stringify(model)))
    expect(result.migratedFrom).toBeNull()
    expect(result.model).toEqual(model)
  })
})

describe("outline-model-store save（D5：字节形态固定）", () => {
  it("⑩ save→load 往返 contentKey 等值", async () => {
    const model = buildV2Model()
    let stored = ""
    const deps: OutlineModelStoreDeps = {
      writeText: async (_path, text) => {
        stored = text
      },
      ensureDir: async () => {},
      readText: async () => stored,
    }
    const { path } = await saveOutlineModel("/P", model, deps)
    expect(path).toBe("/P/.novel/outline-model.json")
    const loaded = await loadOutlineModel("/P", deps)
    expect(loaded.model).not.toBeNull()
    expect(outlineModelContentKey(loaded.model!)).toBe(outlineModelContentKey(model))
  })

  it("⑪ 字节形态：=== JSON.stringify(model, null, 2) 且无尾随换行", async () => {
    const model = buildV2Model()
    const writeText = vi.fn(async (_path: string, _text: string) => {})
    await saveOutlineModel("/P", model, { writeText, ensureDir: async () => {} })

    expect(writeText).toHaveBeenCalledTimes(1)
    const written = writeText.mock.calls[0][1]
    expect(written).toBe(JSON.stringify(model, null, 2))
    expect(written.endsWith("\n")).toBe(false)
  })

  it("⑫ save 时 schemaVersion 不符 → 抛 OutlineModelStoreError 且不落盘", async () => {
    const model = { ...buildV2Model(), schemaVersion: 1 }
    const writeText = vi.fn(async (_path: string, _text: string) => {})
    await expect(
      saveOutlineModel("/P", model, { writeText, ensureDir: async () => {} }),
    ).rejects.toBeInstanceOf(OutlineModelStoreError)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("⑬ save 非法模型 → 抛错且不落盘", async () => {
    const model = buildV2Model()
    model.volumes[0].chapters[0].id = "v09c009"
    const writeText = vi.fn(async (_path: string, _text: string) => {})
    await expect(
      saveOutlineModel("/P", model, { writeText, ensureDir: async () => {} }),
    ).rejects.toBeInstanceOf(OutlineModelStoreError)
    expect(writeText).not.toHaveBeenCalled()
  })
})
