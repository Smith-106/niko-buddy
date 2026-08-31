import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindReference,
  bindingsForChapter,
  bindingsForMaterial,
  bindingsToContextText,
  createEmptyReferenceBindingStore,
  loadReferenceBindings,
  saveReferenceBindings,
} from "./reference-binding"

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

import type { ReferenceBinding } from "./reference-binding"

function binding(overrides: Partial<ReferenceBinding>): ReferenceBinding {
  return {
    materialId: "m1",
    chapter: 5,
    uses: ["人物动机依据"],
    canonGuardrail: false,
    ...overrides,
  }
}

describe("reference-binding（吸收自 inkos book-references 用途绑定模式）", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.readFile.mockImplementation(async () => {
      throw new Error("ENOENT")
    })
  })

  it("bindReference 追加绑定；同 materialId+chapter+uses 幂等跳过", () => {
    let store = createEmptyReferenceBindingStore()
    store = bindReference(store, binding({}))
    expect(store.bindings).toHaveLength(1)
    store = bindReference(store, binding({}))
    expect(store.bindings).toHaveLength(1)
    store = bindReference(store, binding({ uses: ["场景道具"] }))
    expect(store.bindings).toHaveLength(2)
  })

  it("bindingsForMaterial / bindingsForChapter 过滤", () => {
    let store = createEmptyReferenceBindingStore()
    store = bindReference(store, binding({ materialId: "m1", chapter: 5 }))
    store = bindReference(store, binding({ materialId: "m1", chapter: 9 }))
    store = bindReference(store, binding({ materialId: "m2", chapter: 5 }))
    expect(bindingsForMaterial(store, "m1")).toHaveLength(2)
    expect(bindingsForChapter(store, 5)).toHaveLength(2)
    expect(bindingsForChapter(store, 3)).toHaveLength(0)
  })

  it("bindingsToContextText：canon 护栏项优先；空章返回空串", () => {
    let store = createEmptyReferenceBindingStore()
    store = bindReference(store, binding({ materialId: "plain", chapter: 5 }))
    store = bindReference(
      store,
      binding({ materialId: "guarded", chapter: 5, canonGuardrail: true, note: "不可违背事实" }),
    )
    const text = bindingsToContextText(store, 5)
    const guardedIdx = text.indexOf("[canon护栏]")
    const plainIdx = text.indexOf("素材 plain")
    expect(guardedIdx).toBeGreaterThanOrEqual(0)
    expect(guardedIdx).toBeLessThan(plainIdx)
    expect(text).toContain("不可违背事实")
    expect(bindingsToContextText(store, 99)).toBe("")
  })

  it("持久化往返：save 走 writeFileAtomic，load 还原", async () => {
    let captured: string | null = null
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      captured = content
    })
    const store = bindReference(createEmptyReferenceBindingStore(), binding({}))
    await saveReferenceBindings("/proj", store)
    expect(captured).not.toBeNull()
    fsMocks.readFile.mockImplementation(async () => captured as string)
    const loaded = await loadReferenceBindings("/proj")
    expect(loaded.bindings[0].materialId).toBe("m1")
    expect(loaded.bindings[0].canonGuardrail).toBe(false)
  })
})
