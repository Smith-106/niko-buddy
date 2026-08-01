/**
 * Cascade delete for wiki pages with full reference cleanup.
 *
 * When a wiki page is removed, this module ensures:
 * 1. File deleted from disk
 * 2. Vector embedding chunks dropped from LanceDB (prevents phantom search hits)
 * 3. Media directory cascade for source-summary pages
 * 4. Cross-references cleaned: index.md entries, wikilinks, related: frontmatter
 *
 * Without consolidated cleanup, orphaned references waste search slots and
 * create dangling links in the wiki graph.
 *
 * @license MIT © QMAI
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

/**
 * Detect whether a wiki page is a source-summary page (lives under `wiki/sources/`).
 * Source pages own their extracted images at `wiki/media/<slug>/`.
 * Other wiki paths don't own image directories.
 */
function isSourcePage(pagePath: string): boolean {
  const normalized = normalizePath(pagePath)
  return normalized.includes("/wiki/sources/")
}

/**
 * Delete a single wiki page from disk and drop its embedding chunks.
 * 
 * For source-summary pages (`wiki/sources/<slug>.md`), also removes
 * the corresponding `wiki/media/<slug>/` directory containing
 * extracted images — those are owned by the source.
 * 
 * Slug validation: must be non-empty and not start with `.` to prevent
 * accidental deletion of hidden directories or the media root.
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

  // Media cascade for source-summary pages
  if (isSourcePage(pagePath) && slug.length > 0 && !slug.startsWith(".")) {
    const pp = normalizePath(projectPath)
    const mediaDir = `${pp}/wiki/media/${slug}`
    try {
      await deleteFile(mediaDir)
    } catch {
      // Directory may not exist if no images were extracted
    }
  }
}

/** Flatten a file tree to extract only .md file nodes. */
function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  function walk(ns: readonly FileNode[]): void {
    for (const n of ns) {
      if (n.is_dir) {
        if (n.children) walk(n.children)
        continue
      }
      if (n.name.endsWith(".md")) out.push(n)
    }
  }
  walk(nodes)
  return out
}

export interface CascadeDeleteResult {
  /** Wiki-page paths actually removed from disk. */
  deletedPaths: string[]
  /** Count of surviving wiki files rewritten to drop stale refs. */
  rewrittenFiles: number
}

/**
 * Delete multiple wiki pages and clean all cross-references.
 * 
 * Cleanup scope:
 * - File delete + embedding drop + media dir cascade for source pages
 * - `wiki/index.md` entries pointing to deleted pages → entry line dropped
 * - Any wiki .md body containing `[[deleted]]` wikilinks → replaced with plain text
 * - Any wiki .md with `related:` frontmatter listing deleted slugs → entry filtered
 * 
 * Order of operations:
 * 1. Read each target's content to extract title (for index matching)
 * 2. Cascade-delete each target file
 * 3. Sweep all surviving wiki .md files and rewrite them
 * 
 * Best-effort: a single unreadable file doesn't abort the rest.
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pagePaths: readonly string[],
): Promise<CascadeDeleteResult> {
  const pp = normalizePath(projectPath)
  const result: CascadeDeleteResult = {
    deletedPaths: [],
    rewrittenFiles: 0,
  }

  // 1. Capture titles before deletion (needed for index matching)
  const infos: DeletedPageInfo[] = []
  for (const pagePath of pagePaths) {
    let title = ""
    try {
      const content = await readFile(pagePath)
      title = extractFrontmatterTitle(content)
    } catch {
      // File may have been deleted between selection and action
    }
    const slug = getFileStem(pagePath)
    if (slug.length > 0) infos.push({ slug, title })
  }

  // 2. Delete target files
  for (const pagePath of pagePaths) {
    try {
      await cascadeDeleteWikiPage(pp, pagePath)
      result.deletedPaths.push(pagePath)
    } catch (err) {
      console.warn(`[wiki-delete] failed to delete ${pagePath}:`, err)
    }
  }

  if (infos.length === 0) return result

  // 3. Sweep surviving wiki files and rewrite references
  const deletedKeys = buildDeletedKeys(infos)
  const wikiTree = await listDirectory(`${pp}/wiki`)
  const allMd = flattenMd(wikiTree)
  const indexAbs = `${pp}/wiki/index.md`

  for (const file of allMd) {
    if (result.deletedPaths.includes(file.path)) continue // Already deleted
    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    let updated = content
    if (file.path === indexAbs || file.name === "index.md") {
      updated = cleanIndexListing(updated, deletedKeys)
    }
    updated = stripDeletedWikilinks(updated, deletedKeys)

    // Clean `related:` frontmatter entries pointing to deleted pages
    const related = parseFrontmatterArray(updated, "related")
    if (related.length > 0) {
      const filtered = related.filter(
        (s) => !deletedKeys.has(normalizeWikiRefKey(s)),
      )
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
