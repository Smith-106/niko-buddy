/**
 * @license MIT © QMAI
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
 * Persistence: `<project>/.qmai/vector-fingerprints.json`, same `.qmai/`
 * JSON-on-disk pattern as ingest-cache.json / image-caption-cache.json.
 * Atomic writes (writeFileAtomic) keep the index crash-safe; a corrupt or
 * missing file degrades to an empty index so ingestion never hard-fails.
 */
import { createHash } from "node:crypto"
import { readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const FINGERPRINT_FILE = ".qmai/vector-fingerprints.json"

/** Version stamp so a future on-disk format change can migrate cleanly. */
const STORE_VERSION = 1

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
 */
export function chunkFingerprint(content: string): string {
  return createHash("sha256").update(normalizeChunkContent(content), "utf8").digest("hex")
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