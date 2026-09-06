/**
 * 64 号实施（63 号共识 §6 缺口 12）：FtsIndex — 可重建持久 FTS 索引（TS 倒排形态）.
 *
 * 吸收来源：reference/inkos SQLite FTS5/BM25 持久索引形态（对标「FTS5 持久索引
 * 可重建」缺口）；Rust 侧 LanceDB FTS（canon_search.rs fts_query）受 T11 落地
 * 约束不扩展，wiki 池等价形态 = TS 侧持久倒排 + BM25（零新运行时，符合
 * 「IPC 直 invoke、不引入重型运行时」硬约束）。
 *
 * 定位：wiki/*.md 全量构建倒排索引（token 复用 tokenizeForBm25 中文 bigram），
 * 持久化 `.qmai/fts-index.json`（writeFileAtomic 原子写）；重建幂等
 * （同语料同输出）；消费方（search-adapter keyword 分支）索引缺失/损坏 →
 * 现全量扫描字节级回退，绝不让检索挂死。纯函数层零 IO。
 */

import { readFile, listDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { flattenMdFilesBase } from "./chapter-utils"
import { tokenizeForBm25 } from "./bm25-ranking"
import type { RebuildProgressCallback } from "./rebuild"

/** 索引格式版本位（chunk-fingerprint v2 同款纪律：格式变更 bump）。 */
export const FTS_INDEX_VERSION = 1

export interface FtsDocMeta {
  id: string
  title: string
  path: string
  /** 词元数（BM25 长度归一）。 */
  length: number
}

export interface FtsIndex {
  version: number
  docs: Record<string, FtsDocMeta>
  /** token → docId 序（倒排表；同一 doc 出现多次 = tf）。 */
  postings: Record<string, string[]>
  /** token → 含该词的文档数（IDF 计算）。 */
  docFreq: Record<string, number>
  builtAt: string
}

/**
 * 构建倒排索引（纯函数；now 显式注入保持纯性）。
 * 确定性：同语料同输出。postings 保留 token 在 doc 内的每次出现（tf 可数）。
 */
export function buildFtsIndex(
  docs: Array<{ id: string; title: string; text: string; path?: string }>,
  opts: { now?: string } = {},
): FtsIndex {
  const index: FtsIndex = {
    version: FTS_INDEX_VERSION,
    docs: {},
    postings: {},
    docFreq: {},
    builtAt: opts.now ?? "",
  }

  for (const doc of docs) {
    const tokens = tokenizeForBm25(`${doc.title} ${doc.text}`)
    const id = doc.id
    index.docs[id] = {
      id,
      title: doc.title,
      path: doc.path ?? id,
      length: tokens.length,
    }
    const seen = new Set<string>()
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t)
        index.docFreq[t] = (index.docFreq[t] ?? 0) + 1
      }
      if (!index.postings[t]) index.postings[t] = []
      index.postings[t].push(id)
    }
  }

  return index
}

export interface FtsQueryHit {
  id: string
  path: string
  title: string
  score: number
}

/**
 * BM25 索引查询（纯函数零 IO；tf 由 postings 中 doc 出现次数精确计数）。
 * 零命中 → []。
 */
export function searchFtsIndex(
  idx: FtsIndex,
  query: string,
  topK: number = 5,
): FtsQueryHit[] {
  const qTokens = tokenizeForBm25(query)
  if (qTokens.length === 0) return []

  // 候选文档：任一查询词命中倒排的并集
  const candidateIds = new Set<string>()
  for (const t of qTokens) {
    const list = idx.postings[t]
    if (list) for (const id of list) candidateIds.add(id)
  }
  if (candidateIds.size === 0) return []

  const N = Object.keys(idx.docs).length
  const k1 = 1.5
  const b = 0.75
  const avgLen = N > 0
    ? Object.values(idx.docs).reduce((s, d) => s + d.length, 0) / N
    : 0

  const idf = (t: string): number => {
    const n = idx.docFreq[t] ?? 0
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  const scored: FtsQueryHit[] = []
  for (const id of candidateIds) {
    const meta = idx.docs[id]
    if (!meta) continue
    // tf：postings 中该 doc 出现次数（每 token 独立计数）
    const tf = new Map<string, number>()
    for (const q of qTokens) {
      const list = idx.postings[q]
      if (list) {
        let cnt = 0
        for (const did of list) if (did === id) cnt++
        if (cnt > 0) tf.set(q, cnt)
      }
    }
    let score = 0
    for (const q of new Set(qTokens)) {
      const f = tf.get(q) ?? 0
      if (f === 0) continue
      const len = meta.length
      const denom = f + k1 * (1 - b + b * (len / Math.max(avgLen, 1)))
      score += idf(q) * ((f * (k1 + 1)) / denom)
    }
    scored.push({ id, path: meta.path, title: meta.title, score })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

const FTS_FILE = ".qmai/fts-index.json"

export function ftsIndexPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${FTS_FILE}`
}

export async function saveFtsIndex(projectPath: string, idx: FtsIndex): Promise<void> {
  await writeFileAtomic(ftsIndexPath(projectPath), JSON.stringify(idx))
}

/** 损坏/缺失 → null（调用方回退全量扫描）。 */
export async function loadFtsIndex(projectPath: string): Promise<FtsIndex | null> {
  try {
    const raw = await readFile(ftsIndexPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<FtsIndex>
    if (parsed && parsed.version === FTS_INDEX_VERSION && parsed.docs && parsed.postings) {
      return parsed as FtsIndex
    }
  } catch {
    // missing / unreadable / invalid — null is the safe default
  }
  return null
}

/**
 * 重建 wiki FTS 索引（IO 层；与 rebuildVectorIndex 并列，构成
 * 「向量 + FTS 双索引可重建」完整形态）。幂等：同语料同输出。
 */
export async function rebuildWikiFtsIndex(
  projectPath: string,
  onProgress?: RebuildProgressCallback,
): Promise<{ indexed: number; errors: string[] }> {
  const pp = normalizePath(projectPath)
  const wikiDir = `${pp}/wiki`
  let files: { name: string; path: string }[] = []
  try {
    const tree = await listDirectory(wikiDir)
    files = flattenMdFilesBase(tree)
  } catch {
    return { indexed: 0, errors: ["无法读取 wiki 目录"] }
  }

  const errors: string[] = []
  const docs: Array<{ id: string; title: string; text: string; path: string }> = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress?.({ total: files.length, completed: i, current: file.name, errors })
    try {
      const content = await readFile(file.path)
      const pageId = file.name.replace(/\.md$/, "")
      const titleMatch = content.match(/^#\s+(.+)/m)
      const title = titleMatch?.[1]?.trim() ?? pageId
      docs.push({ id: pageId, title, text: content, path: file.path })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${file.name}：${msg}`)
    }
  }

  const index = buildFtsIndex(docs, { now: new Date().toISOString() })
  await saveFtsIndex(pp, index)

  onProgress?.({ total: files.length, completed: files.length, current: "完成", errors })
  return { indexed: docs.length, errors }
}
