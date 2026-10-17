/**
 * @license MIT © Niko Buddy
 *
 * Cross-page chunk fingerprinting & dedup index.
 *
 * Problem: the same content ingested repeatedly (across re-ingests or
 * across different source pages) pollutes the vector store with duplicate
 * vectors, degrading retrieval quality. The chunker (`text-chunker.ts`)
 * is deliberately pure and has no notion of "have I seen this before",
 * so dedup must live one layer up, in the upsert path.
 *
 * This module provides:
 *  1. `chunkFingerprint(text)`         — a deterministic content digest
 *     (SHA-256 hex). Normalization is `trim()` + `NFKC` so cosmetic
 *     whitespace / unicode-composition differences collapse to the same
 *     fingerprint.
 *  2. `ChunkFingerprintIndex`          — a per-project persisted index of
 *     which fingerprint each page currently owns. It is the source of
 *     truth the embed pipeline consults before upserting a chunk and
 *     mutates as pages are (re)indexed or deleted.
 *
 * Persistence: `<project>/.niko-buddy/vector-fingerprints.json`, same `.niko-buddy/`
 * JSON-on-disk pattern as ingest-cache.json / image-caption-cache.json.
 * Atomic writes (writeFileAtomic) keep the index crash-safe; a corrupt or
 * missing file degrades to an empty index so ingestion never hard-fails.
 */
import { readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const FINGERPRINT_FILE = ".niko-buddy/vector-fingerprints.json"

/** Version stamp so a future on-disk format change can migrate cleanly. */
// 55 号设计 W2-7: v1: 前缀引入后 bump 2 — 旧 64-hex 键与新 v1: 键混存时版本化读者可区分
const STORE_VERSION = 2

interface IndexFile {
  version: number
  /** fingerprint → pageIds that currently own that fingerprint. */
  fingerprints: Record<string, string[]>
}

/** Path to the fingerprint index file for a project. */
export function fingerprintIndexPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${FINGERPRINT_FILE}`
}

/**
 * Normalize chunk content before fingerprinting. `trim()` drops leading /
 * trailing whitespace (so re-ingests with a stray trailing newline don't
 * look "new"), and `NFKC` folds unicode-composed/decomposed forms and
 * fullwidth ASCII into a canonical byte stream.
 */
export function normalizeChunkContent(content: string): string {
  return content.normalize("NFKC").trim()
}

/**
 * Compute the SHA-256 content fingerprint for a chunk (hex). Deterministic:
 * same content ⇒ same fingerprint. Callers that want the embed-wise
 * identity should pass the exact text that would otherwise be embedded.
 *
 * 55 号设计 W2-7 (B-04): 版本位前缀 `v1:` — chunker 算法变更 (如 CJK 断句层)
 * 会改变切分结果, 旧指纹与新 chunk 混存会污染去重索引; 版本位使算法变更
 * 自动失效旧指纹 (旧索引条目自然过期, 无需迁移)。
 */
// ── Pure-TS SHA-256 (browser-safe) ─────────────────────────────────────────
// `node:crypto` is aliased to a throwing shim in webview builds
// (vite.config.ts), so this module must never import it — the embed
// pipeline calls chunkFingerprint() for every page, and a throw here
// silently skips ALL pages (embedAllPages swallows per-file errors).
// This minimal SHA-256 operates on UTF-8 bytes and matches Node
// `createHash("sha256").update(str, "utf8").digest("hex")`.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256HexBytes(input: Uint8Array): string {
  const l = input.length
  const paddedLen = Math.ceil((l + 9) / 64) * 64
  const padded = new Uint8Array(paddedLen)
  padded.set(input, 0)
  padded[l] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLen - 8, Math.floor(l / 0x20000000), false)
  view.setUint32(paddedLen - 4, (l << 3) >>> 0, false)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)) | 0
      const s1 = (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)) | 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("")
}

export function chunkFingerprint(content: string): string {
  const bytes = new TextEncoder().encode(normalizeChunkContent(content))
  return `v1:${sha256HexBytes(bytes)}`
}

/**
 * Pure, dependency-free in-memory index (test-friendly). `load`/`save`
 * bridge to disk; `add`/`has`/`removeByPage` operate purely in memory.
 */
export class ChunkFingerprintIndex {
  private readonly fingerprints = new Map<string, Set<string>>()

  /** Number of distinct fingerprints tracked (for inspection/tests). */
  get size(): number {
    return this.fingerprints.size
  }

  /** Load the persisted index for a project. Missing/corrupt → empty. */
  static async load(projectPath: string): Promise<ChunkFingerprintIndex> {
    const index = new ChunkFingerprintIndex()
    try {
      const raw = await readFile(fingerprintIndexPath(projectPath))
      const parsed = JSON.parse(raw) as Partial<IndexFile>
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.fingerprints &&
        typeof parsed.fingerprints === "object"
      ) {
        for (const [fp, pages] of Object.entries(parsed.fingerprints)) {
          if (Array.isArray(pages)) index.fingerprints.set(fp, new Set(pages.filter((p) => typeof p === "string")))
        }
      }
    } catch {
      // missing / unreadable / invalid JSON — empty index is the safe default
    }
    return index
  }

  /**
   * Persist the index to disk. Atomic write, non-critical on failure
   * (a lost index merely re-embeds some chunks next time).
   */
  async save(projectPath: string): Promise<void> {
    const fingerprints: Record<string, string[]> = {}
    for (const [fp, pages] of this.fingerprints) {
      fingerprints[fp] = [...pages].sort()
    }
    const file: IndexFile = { version: STORE_VERSION, fingerprints }
    try {
      await writeFileAtomic(fingerprintIndexPath(projectPath), JSON.stringify(file, null, 2))
    } catch {
      // non-critical — dedup is best-effort
    }
  }

  /** True iff any registered page currently owns `fp`. */
  has(fp: string): boolean {
    const pages = this.fingerprints.get(fp)
    return pages !== undefined && pages.size > 0
  }

  /** Register `pageId` as an owner of `fp` (idempotent). */
  add(fp: string, pageId: string): void {
    let pages = this.fingerprints.get(fp)
    if (!pages) {
      pages = new Set()
      this.fingerprints.set(fp, pages)
    }
    pages.add(pageId)
  }

  /** Drop every fingerprint owned by `page`. Returns the count removed. */
  removeByPage(pageId: string): number {
    let removed = 0
    for (const [fp, pages] of this.fingerprints) {
      if (pages.delete(pageId)) removed++
      if (pages.size === 0) this.fingerprints.delete(fp)
    }
    return removed
  }
}