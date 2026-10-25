/**
 * @license MIT © Niko Buddy
 *
 * I/O wrapper connecting the pure dedup algorithm (dedup.ts) to the
 * project filesystem and LLM.  The UI layer calls these functions;
 * the algorithm core stays testable without filesystem or LLM mocks.
 */
import { listDirectory, readFile, writeFileAtomic, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import {
  detectDuplicateGroups,
  extractEntitySummary,
  mergeDuplicateGroup,
  rewriteIndexMd,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { loadNotDuplicates } from "./dedup-storage"

/**
 * Wrap `streamChat` into the `(system, user, signal) → string` shape
 * that the dedup algorithm module expects.
 */
export function buildDedupLlmCall(llmConfig: LlmConfig): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => { result += t },
          onDone: () => resolve(),
          onError: (err) => { streamError = err; resolve() },
        },
        signal,
        { temperature: 0.1 },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/** Walk a FileNode tree, yielding .md files whose path contains a given prefix. */
function* walkMd(nodes: FileNode[], prefix: string): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) { if (node.children) yield* walkMd(node.children, prefix); continue }
    if (node.name.endsWith(".md") && node.path.includes(`${prefix}/`)) yield node
  }
}

/** Convert absolute path to wiki-relative form. */
function toRelative(pp: string, abs: string): string {
  const n = normalizePath(abs)
  return n.startsWith(`${pp}/`) ? n.slice(pp.length + 1) : n
}

/**
 * Load entity summaries from wiki/entities/ and wiki/concepts/.
 * Pages that fail to parse are silently skipped.
 */
export async function loadAllEntitySummaries(projectPath: string): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  // PAT-IM1: 独立项并行 IPC —— 展平内外两层循环，并发 readFile（Promise.all 保序回填），再按原序串行解析/push。
  const entityNodes: { path: string }[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) entityNodes.push(node)
  }
  const entityContents = await Promise.all(
    entityNodes.map((node) => readFile(node.path).then(
      (content) => ({ ok: true as const, content }),
      () => ({ ok: false as const, content: "" }),
    )),
  )
  const out: EntitySummary[] = []
  for (let entityIndex = 0; entityIndex < entityNodes.length; entityIndex += 1) {
    const node = entityNodes[entityIndex]
    const read = entityContents[entityIndex]
    if (!read.ok) continue
    try {
      const rel = toRelative(pp, node.path)
      const summary = extractEntitySummary(rel, read.content)
      if (summary) out.push(summary)
    } catch { /* best-effort */ }
  }
  return out
}

/** Read every .md under wiki/ as `{ path, content }`. */
export async function loadAllWikiPages(projectPath: string): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  // PAT-IM1: 独立项并行 IPC —— 并发 readFile（Promise.all 保序回填），再按原序串行 push。
  const wikiNodes = [...walkMd(tree, "wiki")]
  const wikiContents = await Promise.all(
    wikiNodes.map((node) => readFile(node.path).then(
      (content) => ({ ok: true as const, content }),
      () => ({ ok: false as const, content: "" }),
    )),
  )
  const out: { path: string; content: string }[] = []
  for (let wikiIndex = 0; wikiIndex < wikiNodes.length; wikiIndex += 1) {
    const read = wikiContents[wikiIndex]
    if (!read.ok) continue
    try {
      out.push({ path: toRelative(pp, wikiNodes[wikiIndex].path), content: read.content })
    } catch { /* ignore */ }
  }
  return out
}

/**
 * Run duplicate detection (stages 1 + 2), respecting the
 * not-duplicates whitelist so confirmed false positives are excluded.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DuplicateGroup[]> {
  const summaries = await loadAllEntitySummaries(projectPath)
  if (summaries.length < 2) return []
  const notDup = await loadNotDuplicates(projectPath)
  const llm = buildDedupLlmCall(llmConfig)
  return detectDuplicateGroups(summaries, llm, { signal: options.signal, notDuplicates: notDup })
}

/**
 * Execute a user-confirmed merge (stage 3 + persistence):
 * 1. Load group pages and other wiki pages
 * 2. Run the algorithm merge
 * 3. Snapshot pre-merge state
 * 4. Write canonical + rewrites
 * 5. Delete merged-away pages
 * 6. Rewrite index.md
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)

  // 1. Resolve slugs to paths
  const allPages = await loadAllWikiPages(pp)
  const pathBySlug = new Map<string, string>()
  for (const p of allPages) {
    /* v8 ignore next */
    const base = p.path.split("/").pop() ?? ""
    /* v8 ignore next */
    if (base.endsWith(".md")) pathBySlug.set(base.slice(0, -3), p.path)
  }

  const groupPages: { slug: string; path: string; content: string }[] = []
  for (const slug of group.slugs) {
    const relPath = pathBySlug.get(slug)
    if (!relPath) throw new Error(`Slug "${slug}" not found on disk — was the page deleted between detection and merge?`)
    const page = allPages.find((p) => p.path === relPath)
    /* v8 ignore next */
    if (!page) throw new Error(`Internal: page lookup miss for ${relPath}`)
    groupPages.push({ slug, path: relPath, content: page.content })
  }

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((p) => !groupPaths.has(p.path))

  const llm = buildDedupLlmCall(llmConfig)
  const result = await mergeDuplicateGroup(
    { group: groupPages, canonicalSlug, otherWikiPages: otherPages },
    llm,
    { signal: options.signal },
  )

  // 2. Snapshot backup — PAT-IM: 独立路径并行写（路径经 replace 互异），Promise.all 保序，语义不变。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.niko-buddy/page-history/dedup-${stamp}`
  await Promise.all(
    result.backup.map((b) => writeFileAtomic(`${backupDir}/${b.path.replace(/[/\\]/g, "_")}`, b.content)),
  )

  // 3. Write canonical
  await writeFileAtomic(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites — PAT-IM: 独立路径并行写，Promise.all，顺序无关（不同 path 无共享状态）。
  await Promise.all(
    result.rewrites.map((r) => writeFileAtomic(`${pp}/${r.path}`, r.newContent)),
  )

  // 5. Delete merged-away pages — PAT-IM: 独立路径并行删，Promise.allSettled 保序收集，单项失败 warn 继续语义不变。
  const deleteResults = await Promise.allSettled(
    result.pagesToDelete.map((dead) => deleteFile(`${pp}/${dead}`)),
  )
  deleteResults.forEach((res, deleteIndex) => {
    if (res.status === "rejected") {
      console.warn(`[dedup] failed to delete ${result.pagesToDelete[deleteIndex]}: ${res.reason}`)
    }
  })

  // 6. Rewrite index.md
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(group.slugs.filter((s) => s !== canonicalSlug))
    const rewritten = rewriteIndexMd(indexEntry.content, removed)
    if (rewritten !== indexEntry.content) await writeFileAtomic(indexPath, rewritten)
  }

  return result
}
