/**
 * 64 号实施（63 号共识 §6 缺口 8）：ChunkAnnotation — hit-rag 标注回注闭环.
 *
 * 吸收来源：reference/hit-rag（chunk 标注 → 版本化 → 召回消费闭环）模式；
 * 只借模式不借代码（license 核验同 55 号 W3-2 口径）。
 *
 * 定位：检索侧 chunk 级人工/反馈标注，标注随内容指纹版本化（内容变更 →
 * 指纹失配 → 标注自动失效），召回侧按标注极性加减分。全链路纯函数零 LLM；
 * 持久化 `.qmai/chunk-annotations.json`（writeFileAtomic 原子写，损坏 → 空库
 * 安全降级）。消费面（search-adapter）经 flag 门控缺省关闭，字节级回退现状。
 *
 * 与 reference-binding.ts 的关系：reference-binding 是「素材→章节用途绑定」
 * （材料维度）；本模块是「chunk→检索极性标注」（检索维度），两轴分列，
 * 不并入既有零接线模块（63 号 review-1 口径：两轴接线分列）。
 */

import { writeFileAtomic, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export type AnnotationPolarity = "positive" | "negative"

export interface ChunkAnnotation {
  /** chunk 身份 = chunkFingerprint(chunk.text)（继承 v1: 版本位语义）。 */
  chunkId: string
  polarity: AnnotationPolarity
  chapter: number
  /** 溯源 RetrievalTraceEntry id（feedback 源标注必填，人工标注可缺）。 */
  traceId?: string
  /** 标注权重（当前固定 ±1；未来可扩展分级）。 */
  weight: 1 | -1
  note?: string
  createdAt: string
}

export interface ChunkAnnotationStore {
  version: 1
  annotations: ChunkAnnotation[]
  lastUpdated: string
}

export function createEmptyChunkAnnotationStore(): ChunkAnnotationStore {
  return { version: 1, annotations: [], lastUpdated: new Date().toISOString() }
}

const ANNOTATION_FILE = ".qmai/chunk-annotations.json"

export function chunkAnnotationsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${ANNOTATION_FILE}`
}

/**
 * 追加标注（幂等：同 chunkId+polarity+chapter 全等跳过；正负各自累加不互删）。
 * 纯函数：输入 store 不变，返回新 store。
 */
export function annotateChunk(
  store: ChunkAnnotationStore,
  a: ChunkAnnotation,
): ChunkAnnotationStore {
  const dup = store.annotations.some(
    (x) =>
      x.chunkId === a.chunkId &&
      x.polarity === a.polarity &&
      x.chapter === a.chapter &&
      x.weight === a.weight,
  )
  if (dup) return store
  return {
    version: 1,
    annotations: [...store.annotations, a],
    lastUpdated: new Date().toISOString(),
  }
}

/** 某 chunk 的净极性分（Σ⁺ − Σ⁻，clamp 到 [-1, 1]）。无标注返回 0。 */
export function annotationBoost(
  chunkId: string,
  store: ChunkAnnotationStore,
): number {
  let score = 0
  for (const a of store.annotations) {
    if (a.chunkId === chunkId) score += a.weight
  }
  return Math.max(-1, Math.min(1, score))
}

/**
 * 清理失效标注：liveFingerprints 为当前在库指纹集；标注 chunkId 不在其中
 * （内容已变/已删）→ 剔除。纯函数。
 */
export function pruneStaleAnnotations(
  store: ChunkAnnotationStore,
  liveFingerprints: ReadonlySet<string>,
): ChunkAnnotationStore {
  const kept = store.annotations.filter((a) => liveFingerprints.has(a.chunkId))
  if (kept.length === store.annotations.length) return store
  return { version: 1, annotations: kept, lastUpdated: new Date().toISOString() }
}

export async function saveChunkAnnotations(
  projectPath: string,
  store: ChunkAnnotationStore,
): Promise<void> {
  await writeFileAtomic(chunkAnnotationsPath(projectPath), JSON.stringify(store, null, 2))
}

/** 损坏/缺失 → 空库安全降级（检索永不因标注挂死）。 */
export async function loadChunkAnnotations(
  projectPath: string,
): Promise<ChunkAnnotationStore> {
  try {
    const raw = await readFile(chunkAnnotationsPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<ChunkAnnotationStore>
    if (parsed && Array.isArray(parsed.annotations)) {
      return {
        version: parsed.version ?? 1,
        annotations: parsed.annotations.filter(isChunkAnnotation),
        lastUpdated: parsed.lastUpdated ?? new Date().toISOString(),
      }
    }
  } catch {
    // missing / unreadable / invalid JSON — empty store is the safe default
  }
  return createEmptyChunkAnnotationStore()
}

function isChunkAnnotation(value: unknown): value is ChunkAnnotation {
  const a = value as Partial<ChunkAnnotation>
  return Boolean(
    a &&
      typeof a.chunkId === "string" &&
      (a.polarity === "positive" || a.polarity === "negative") &&
      typeof a.chapter === "number" &&
      (a.weight === 1 || a.weight === -1),
  )
}
