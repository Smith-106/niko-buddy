import { normalizePath } from "@/lib/path-utils"
import { flattenMdFiles, type MemoryCenterFilePreview } from "@/lib/novel"
import { fileExists, listDirectory, readFile } from "@/commands/fs"

export function inferModeFromPath(path: string): "knowledge" | "files" {
  const normalized = normalizePath(path)
  if (normalized.includes("/wiki/outlines/")) return "files"
  return "knowledge"
}

export interface PendingPageInfo {
  path: string
  title: string
  type: "chapter" | "outline"
  tags: string[]
  origin?: string
}

export type ImportMemoryDecision = "extract" | "import-only" | "cancel"

export interface ImportMemoryDecisionRequest {
  kind: "chapter" | "outline"
  count: number
}

export const MEMORY_LABEL_KEYS: Record<string, string> = {
  "dismantling-library": "拆文记忆库",
  snapshots: "novel.memoryCenter.snapshots.title",
  "character-states": "novel.memoryCenter.sections.characterStates",
  "character-cognition": "novel.memoryCenter.sections.cognition",
  "foreshadowing-tracker": "novel.memoryCenter.sections.foreshadowing",
  timeline: "novel.memoryCenter.sections.timeline",
  "canon-facts": "novel.memoryCenter.sections.canonFacts",
  conflicts: "novel.memoryCenter.sections.conflicts",
}

export function countMemoryFileEntries(file: MemoryCenterFilePreview | null | undefined): number {
  if (!file) return 0
  return file.sections.reduce(
    (sum, section) => sum + section.items.length + section.groups.length,
    0,
  )
}


export async function getExistingChapterTitles(projectPath: string): Promise<Set<string>> {
  const titles = new Set<string>()
  try {
    const tree = await listDirectory(`${projectPath}/wiki/chapters`)
    const files = flattenMdFiles(tree)
    for (const file of files) {
      try {
        const content = await readFile(file.path)
        const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
        if (titleMatch?.[1]) {
          titles.add(titleMatch[1].trim())
        } else {
          titles.add(file.name.replace(/\.md$/, "").replace(/-/g, " ").trim())
        }
      } catch {
        titles.add(file.name.replace(/\.md$/, "").replace(/-/g, " ").trim())
      }
    }
  } catch {
    // Ignore missing chapter directories.
  }
  return titles
}

export async function getUniqueWikiPagePath(dir: string, fileName: string): Promise<string> {
  const firstPath = `${dir}/${fileName}`
  if (!(await fileExists(firstPath))) return firstPath

  const extensionIndex = fileName.lastIndexOf(".")
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${dir}/${stem}-${index}${extension}`
    if (!(await fileExists(candidate))) return candidate
  }

  return `${dir}/${stem}-${Date.now()}${extension}`
}
