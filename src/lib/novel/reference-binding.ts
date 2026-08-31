/**
 * R-inkos-10 (24→25 审计落地): ReferenceBinding — 素材引用用途绑定.
 *
 * 吸收来源：reference/inkos book-references（素材绑定 uses/note +
 * 按标题分节选择上下文 + canon 护栏）。25 号审计 ds value 7 / hy3 value 6
 * 双票 worth_absorbing：materials-library 平卡注入缺「为什么引用这块素材」
 * 的用途语义。
 *
 * 定位：给 MaterialCard 增加引用维度的绑定层（不改 materials-library 锚点
 * 文件）：一次绑定声明「某素材在某章因某用途被引用」，canonGuardrail 标记
 * 该引用受 canon 护栏（改写不得违背该素材事实）。纯函数 + 持久化。
 */

import { createAtomicJsonStore } from "./projection-store"

export interface ReferenceBinding {
  materialId: string
  chapter: number
  /** 用途清单（如 ["人物动机依据", "场景道具"]）。 */
  uses: string[]
  note?: string
  /** 该引用受 canon 护栏：正文改写不得违背素材 detail 中的事实。 */
  canonGuardrail: boolean
}

export interface ReferenceBindingStore {
  bindings: ReferenceBinding[]
  lastUpdated: string
}

export function createEmptyReferenceBindingStore(): ReferenceBindingStore {
  return { bindings: [], lastUpdated: new Date().toISOString() }
}

const bindingStore = createAtomicJsonStore<ReferenceBindingStore>(
  "reference-bindings.json",
  createEmptyReferenceBindingStore,
)

export async function saveReferenceBindings(
  projectPath: string,
  store: ReferenceBindingStore,
): Promise<void> {
  await bindingStore.save(projectPath, store)
}

export async function loadReferenceBindings(
  projectPath: string,
): Promise<ReferenceBindingStore> {
  return bindingStore.load(projectPath)
}

/** 追加绑定（同 materialId+chapter+uses 全等视为重复，幂等跳过）。纯函数。 */
export function bindReference(
  store: ReferenceBindingStore,
  binding: ReferenceBinding,
): ReferenceBindingStore {
  const dup = store.bindings.some(
    (b) =>
      b.materialId === binding.materialId &&
      b.chapter === binding.chapter &&
      b.uses.length === binding.uses.length &&
      b.uses.every((u, i) => u === binding.uses[i]),
  )
  if (dup) return store
  return {
    bindings: [...store.bindings, binding],
    lastUpdated: new Date().toISOString(),
  }
}

/** 查某素材的全部绑定（输入序）。 */
export function bindingsForMaterial(
  store: ReferenceBindingStore,
  materialId: string,
): ReferenceBinding[] {
  return store.bindings.filter((b) => b.materialId === materialId)
}

/** 查某章的全部绑定（输入序）。 */
export function bindingsForChapter(
  store: ReferenceBindingStore,
  chapter: number,
): ReferenceBinding[] {
  return store.bindings.filter((b) => b.chapter === chapter)
}

/**
 * 渲染某章绑定为上下文注入片段（canon 护栏项带前缀；空返回 ""）。
 * 注入序：canonGuardrail 优先（护栏先于普通用途）。
 */
export function bindingsToContextText(
  store: ReferenceBindingStore,
  chapter: number,
): string {
  const forChapter = bindingsForChapter(store, chapter)
  if (forChapter.length === 0) return ""
  const sorted = [...forChapter].sort(
    (a, b) => Number(b.canonGuardrail) - Number(a.canonGuardrail),
  )
  return sorted
    .map((b) => {
      const guard = b.canonGuardrail ? "[canon护栏] " : ""
      const note = b.note ? `（${b.note}）` : ""
      return `- ${guard}素材 ${b.materialId}：用途 ${b.uses.join("、")}${note}`
    })
    .join("\n")
}
