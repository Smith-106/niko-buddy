import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createEmptyMaterialsStore,
  filterMaterials,
  materialsToContextText,
  saveMaterialsLibrary,
  loadMaterialsLibrary,
  upsertMaterial,
  type MaterialCard,
  type MaterialsStore,
} from "./materials-library"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  writeFileAtomic: fsMocks.writeFileAtomic,
  readFile: fsMocks.readFile,
}))

function card(overrides: Partial<MaterialCard> & { id: string }): MaterialCard {
  return {
    kind: "character",
    title: overrides.id,
    tags: [],
    summary: "",
    detail: "",
    relatedChapters: [],
    status: "active",
    ...overrides,
  }
}

describe("materials-library（吸收自 inkos materials 结构化素材库模式）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockImplementation(async () => {
      throw new Error("ENOENT")
    })
  })

  it("空 store 上下文注入返回空串", () => {
    expect(materialsToContextText(createEmptyMaterialsStore())).toBe("")
  })

  it("upsert 新增后按 id 覆盖（不重复追加）", () => {
    let store: MaterialsStore = createEmptyMaterialsStore()
    store = upsertMaterial(store, card({ id: "m1", title: "林澈" }))
    store = upsertMaterial(store, card({ id: "m1", title: "林澈（改）" }))
    expect(store.items).toHaveLength(1)
    expect(store.items[0].title).toBe("林澈（改）")
  })

  it("filterMaterials 按 kind/status/tags 交集过滤", () => {
    const store: MaterialsStore = {
      items: [
        card({ id: "a", kind: "character", tags: ["反派", "第一卷"] }),
        card({ id: "b", kind: "character", tags: ["反派"] }),
        card({ id: "c", kind: "setting", tags: ["第一卷"], status: "draft" }),
        card({ id: "d", kind: "location", tags: ["第一卷"], status: "retired" }),
      ],
      lastUpdated: "2026-01-01T00:00:00.000Z",
    }
    expect(
      filterMaterials(store, { kinds: ["character"], allTags: ["反派", "第一卷"] }).map((m) => m.id),
    ).toEqual(["a"])
    expect(
      filterMaterials(store, { statuses: ["active"] }).map((m) => m.id).sort(),
    ).toEqual(["a", "b"])
    expect(filterMaterials(store).map((m) => m.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })

  it("contextText 注入 active/draft、排除 retired，detail 不进上下文", () => {
    const store: MaterialsStore = {
      items: [
        card({
          id: "a",
          kind: "character",
          title: "林澈",
          tags: ["主角"],
          summary: "前刑警，左腿旧伤",
          detail: "这段长文本不应出现在上下文注入中".repeat(5),
        }),
        card({ id: "d", kind: "item", title: "青铜镜", status: "retired" }),
      ],
      lastUpdated: "2026-01-01T00:00:00.000Z",
    }
    const text = materialsToContextText(store)
    expect(text).toContain("[角色] 林澈（主角）")
    expect(text).not.toContain("青铜镜")
    expect(text).not.toContain("不应出现在上下文注入")
  })

  it("持久化往返：save 走 writeFileAtomic，load 从 JSON 还原", async () => {
    let captured: string | null = null
    fsMocks.writeFileAtomic.mockImplementation(
      async (_p: string, content: string) => {
        captured = content
      },
    )
    const store = upsertMaterial(createEmptyMaterialsStore(), card({ id: "m1", title: "林澈" }))
    await saveMaterialsLibrary("/proj", store)
    expect(captured).not.toBeNull()
    fsMocks.readFile.mockImplementation(async () => captured as string)
    const loaded = await loadMaterialsLibrary("/proj")
    expect(loaded.items[0].id).toBe("m1")
    expect(loaded.items[0].title).toBe("林澈")
  })
})
