/**
 * @license MIT © QMAI
 *
 * I/O wrapper connecting the pure dedup algorithm (dedup.ts) to the
 * project filesystem and LLM.  The UI layer calls these functions;
 * the algorithm core stays testable without filesystem or LLM mocks.
 */
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
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
  const out: EntitySummary[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) {
      try {
        const content = await readFile(node.path)
        const rel = toRelative(pp, node.path)
        const summary = extractEntitySummary(rel, content)
        if (summary) out.push(summary)
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Read every .md under wiki/ as `{ path, content }`. */
export async function loadAllWikiPages(projectPath: string): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: { path: string; content: string }[] = []
  for (const node of walkMd(tree, "wiki")) {
    try {
      const content = await readFile(node.path)
      out.push({ path: toRelative(pp, node.path), content })
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
    const base = p.path.split("/").pop() ?? ""
    if (base.endsWith(".md")) pathBySlug.set(base.slice(0, -3), p.path)
  }

  const groupPages: { slug: string; path: string; content: string }[] = []
  for (const slug of group.slugs) {
    const relPath = pathBySlug.get(slug)
    if (!relPath) throw new Error(`Slug "${slug}" not found on disk — was the page deleted between detection and merge?`)
    const page = allPages.find((p) => p.path === relPath)
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

  // 2. Snapshot backup
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.qmai/page-history/dedup-${stamp}`
  for (const b of result.backup) {
    await writeFile(`${backupDir}/${b.path.replace(/[/\\]/g, "_")}`, b.content)
  }

  // 3. Write canonical
  await writeFile(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites
  for (const r of result.rewrites) await writeFile(`${pp}/${r.path}`, r.newContent)

  // 5. Delete merged-away pages
  for (const dead of result.pagesToDelete) {
    try { await deleteFile(`${pp}/${dead}`) } catch (err) { console.warn(`[dedup] failed to delete ${dead}: ${err}`) }
  }

  // 6. Rewrite index.md
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(group.slugs.filter((s) => s !== canonicalSlug))
    const rewritten = rewriteIndexMd(indexEntry.content, removed)
    if (rewritten !== indexEntry.content) await writeFile(indexPath, rewritten)
  }

  return result
}
