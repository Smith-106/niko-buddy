import { describe, expect, it, vi, beforeEach } from "vitest"

const fsMocks = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async (_p: string, _content: string) => {}),
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      writeFileAtomic: fsMocks.writeFileAtomic,
      readFile: fsMocks.readFile,
    
  }
})

import {
  annotateChunk,
  annotationBoost,
  createEmptyChunkAnnotationStore,
  loadChunkAnnotations,
  pruneStaleAnnotations,
  saveChunkAnnotations,
  type ChunkAnnotation,
} from "./chunk-annotation"
import { chunkFingerprint } from "@/lib/chunk-fingerprint"

beforeEach(() => {
  fsMocks.writeFileAtomic.mockClear()
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
})

describe("chunk-annotation (64 号实施：hit-rag 标注回注闭环)", () => {
  const fp = (text: string) => chunkFingerprint(text)
  const ann = (chunkId: string, polarity: "positive" | "negative", chapter = 1, weight: 1 | -1 = polarity === "positive" ? 1 : -1): ChunkAnnotation => ({
    chunkId,
    polarity,
    chapter,
    weight,
    createdAt: "2026-09-06T00:00:00.000Z",
  })

  it("幂等：同 chunkId+polarity+chapter 全等跳过", () => {
    const store = createEmptyChunkAnnotationStore()
    const s1 = annotateChunk(store, ann(fp("A"), "positive"))
    const s2 = annotateChunk(s1, ann(fp("A"), "positive"))
    expect(s2.annotations).toHaveLength(1)
  })

  it("正负各自累加不互删：同一 chunk 正+负 → boost 0", () => {
    const id = fp("B")
    let store = createEmptyChunkAnnotationStore()
    store = annotateChunk(store, ann(id, "positive"))
    store = annotateChunk(store, ann(id, "negative"))
    expect(store.annotations).toHaveLength(2)
    expect(annotationBoost(id, store)).toBe(0)
  })

  it("boost 边界 clamp：多正标注封顶 1", () => {
    const id = fp("C")
    let store = createEmptyChunkAnnotationStore()
    for (let i = 0; i < 5; i++) {
      store = annotateChunk(store, ann(id, "positive", 1 + i))
    }
    expect(annotationBoost(id, store)).toBe(1)
  })

  it("pruneStaleAnnotations：指纹失配剔除，live 保留", () => {
    const liveId = fp("live")
    const staleId = fp("stale")
    let store = createEmptyChunkAnnotationStore()
    store = annotateChunk(store, ann(liveId, "positive"))
    store = annotateChunk(store, ann(staleId, "negative"))
    const pruned = pruneStaleAnnotations(store, new Set([liveId]))
    expect(pruned.annotations).toHaveLength(1)
    expect(pruned.annotations[0].chunkId).toBe(liveId)
  })

  it("prune 无失效时返回原 store（引用相等）", () => {
    const id = fp("D")
    const store = annotateChunk(createEmptyChunkAnnotationStore(), ann(id, "positive"))
    expect(pruneStaleAnnotations(store, new Set([id]))).toBe(store)
  })

  it("内容变更 → 指纹变 → 旧标注失效（版本化语义）", () => {
    const idOld = fp("原文本")
    const store = annotateChunk(createEmptyChunkAnnotationStore(), ann(idOld, "positive"))
    const idNew = fp("改后文本")
    expect(idOld).not.toBe(idNew)
    expect(annotationBoost(idNew, store)).toBe(0)
  })

  it("store 持久化 round-trip：save → load 一致", async () => {
    const store = annotateChunk(createEmptyChunkAnnotationStore(), ann(fp("E"), "positive"))
    let captured = ""
    fsMocks.writeFileAtomic.mockImplementation(async (_p: string, content: string) => {
      captured = content
    })
    await saveChunkAnnotations("/proj", store)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    fsMocks.readFile.mockImplementation(async () => captured)
    const loaded = await loadChunkAnnotations("/proj")
    expect(loaded.annotations).toHaveLength(1)
    expect(loaded.annotations[0].chunkId).toBe(store.annotations[0].chunkId)
  })

  it("损坏 JSON 降级为空库", async () => {
    fsMocks.readFile.mockImplementation(async () => "{ not json")
    const loaded = await loadChunkAnnotations("/proj")
    expect(loaded.annotations).toEqual([])
  })

  it("纯函数：annotateChunk 不改输入 store", () => {
    const store = createEmptyChunkAnnotationStore()
    const next = annotateChunk(store, ann(fp("F"), "positive"))
    expect(store.annotations).toHaveLength(0)
    expect(next.annotations).toHaveLength(1)
  })
})
