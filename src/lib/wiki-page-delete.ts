/**
 * @license MIT © QMAI
 *
 * Cascade delete for wiki pages — removes the page from disk, drops
 * its vector embeddings, cleans media directories for source pages,
 * and sweeps surviving wiki files to remove stale references
 * (wikilinks, index listings, and related frontmatter entries).
 */
import { deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { removePageEmbedding } from "@/lib/embedding"
import {
  buildDeletedKeys,
  cleanIndexListing,
  extractFrontmatterTitle,
  normalizeWikiRefKey,
  stripDeletedWikilinks,
  type DeletedPageInfo,
} from "@/lib/wiki-cleanup"
import {
  parseFrontmatterArray,
  writeFrontmatterArray,
} from "@/lib/sources-merge"
import type { FileNode } from "@/types/wiki"

/** Check whether a page lives under `wiki/sources/`. */
function isSourcePage(pagePath: string): boolean {
  return normalizePath(pagePath).includes("/wiki/sources/")
}

/**
 * Delete a single wiki page from disk, drop its embedding chunks,
 * and (for source-summary pages) remove the associated media directory.
 */
export async function cascadeDeleteWikiPage(
  projectPath: string,
  pagePath: string,
): Promise<void> {
  await deleteFile(pagePath)

  const slug = getFileStem(pagePath)
  if (slug.length > 0) {
    await removePageEmbedding(projectPath, slug)
  }

  // Source pages own an image directory at wiki/media/<slug>/
  if (isSourcePage(pagePath) && slug.length > 0 && !slug.startsWith(".")) {
    const pp = normalizePath(projectPath)
    try { await deleteFile(`${pp}/wiki/media/${slug}`) } catch { /* absent is fine */ }
  }
}

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  function walk(ns: readonly FileNode[]): void {
    for (const n of ns) {
      if (n.is_dir) { if (n.children) walk(n.children); continue }
      if (n.name.endsWith(".md")) out.push(n)
    }
  }
  walk(nodes)
  return out
}

export interface CascadeDeleteResult {
  deletedPaths: string[]
  rewrittenFiles: number
}

/**
 * Delete one or more wiki pages and clean every reference to them
 * across the wiki: file deletion, embedding removal, media cascade,
 * index-listing pruning, wikilink stripping, and related-array filtering.
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pagePaths: readonly string[],
): Promise<CascadeDeleteResult> {
  const pp = normalizePath(projectPath)
  const result: CascadeDeleteResult = { deletedPaths: [], rewrittenFiles: 0 }

  // 1. Capture titles before deletion for keyset building
  const infos: DeletedPageInfo[] = []
  for (const pagePath of pagePaths) {
    let title = ""
    try {
      const content = await readFile(pagePath)
      title = extractFrontmatterTitle(content)
    } catch { /* slug alone suffices */ }
    const slug = getFileStem(pagePath)
    if (slug.length > 0) infos.push({ slug, title })
  }

  // 2. Delete targets
  for (const pagePath of pagePaths) {
    try {
      await cascadeDeleteWikiPage(pp, pagePath)
      result.deletedPaths.push(pagePath)
    } catch (err) {
      console.warn(`[wiki-delete] failed to delete ${pagePath}:`, err)
    }
  }

  if (infos.length === 0) return result

  // 3. Sweep surviving wiki/*.md
  const deletedKeys = buildDeletedKeys(infos)
  const wikiTree = await listDirectory(`${pp}/wiki`)
  const allMd = flattenMd(wikiTree)
  const indexAbs = `${pp}/wiki/index.md`

  for (const file of allMd) {
    if (result.deletedPaths.includes(file.path)) continue
    let content: string
    try { content = await readFile(file.path) } catch { continue }

    let updated = content
    if (file.path === indexAbs || file.name === "index.md") {
      updated = cleanIndexListing(updated, deletedKeys)
    }
    updated = stripDeletedWikilinks(updated, deletedKeys)

    const related = parseFrontmatterArray(updated, "related")
    if (related.length > 0) {
      const filtered = related.filter((s) => !deletedKeys.has(normalizeWikiRefKey(s)))
      if (filtered.length !== related.length) {
        updated = writeFrontmatterArray(updated, "related", filtered)
      }
    }

    if (updated !== content) {
      try {
        await writeFile(file.path, updated)
        result.rewrittenFiles++
      } catch (err) {
        console.warn(`[wiki-delete] failed to rewrite ${file.path}:`, err)
      }
    }
  }

  return result
}
