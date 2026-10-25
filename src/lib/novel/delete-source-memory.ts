import { normalizePath } from "@/lib/path-utils"
import { snapshotSourceFileNameCandidates } from "./snapshot-paths"

// ISS-20260712-MAINT-4: 本地双态候选已收敛至 snapshot-paths 唯一真源（exact token
// 口径 + outline 双变体）。保留函数名作薄包装，防既有 import 面变化。
import { logger, toErrorMessage } from "@/lib/utils"
import { deleteFile, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { parseSources, writeSources } from "@/lib/sources-merge"
import type { FileNode } from "@/types/wiki"

export type NovelSourceKind = "chapter" | "outline"

export interface DeleteNovelSourceMemoryInput {
  kind: NovelSourceKind
  pagePath: string
  content?: string
}

export function getOutlineSnapshotNumberFromPath(outlinePath: string): number {
  const normalizedPath = normalizePath(outlinePath)
  /* v8 ignore next */
  const fileName = normalizedPath.split("/").pop() ?? "outline"
  const outlineName = fileName.replace(/\.\w+$/, "")
  let hash = 0
  for (let i = 0; i < outlineName.length; i += 1) {
    hash = ((hash << 5) - hash + outlineName.charCodeAt(i)) | 0
  }
  return -(Math.abs(hash % 999) + 1)
}

export function getChapterSnapshotNumberFromDeletedSource(input: DeleteNovelSourceMemoryInput): number | null {
  if (input.kind === "outline") {
    return getOutlineSnapshotNumberFromPath(input.pagePath)
  }

  const frontmatterNumber = input.content?.match(/^chapter_number:\s*(\d+)\s*$/m)?.[1]
  if (frontmatterNumber) {
    const parsed = Number.parseInt(frontmatterNumber, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  /* v8 ignore next */
  const fileName = normalizePath(input.pagePath).split("/").pop() ?? ""
  const pathNumber = fileName.match(/(\d+)/)?.[1]
  if (!pathNumber) return null
  const parsed = Number.parseInt(pathNumber, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function flattenEntityFiles(nodes: readonly FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenEntityFiles(node.children))
      continue
    }
    if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

async function cleanupDeletedSourceEntities(projectPath: string, snapshotNumber: number): Promise<void> {
  const pp = normalizePath(projectPath)
  // ISS-20260712-MAINT-4: 经 snapshot-paths 唯一真源取候选（exact token 口径）。
  const deletedSources = new Set(snapshotSourceFileNameCandidates(snapshotNumber))
  let entityFiles: FileNode[] = []

  try {
    entityFiles = flattenEntityFiles(await listDirectory(`${pp}/wiki/entities`))
  } catch (err) {
    // ISS-20260712-REL-1: 空 catch 收敛 — 记诊断，控制流不变（列目录失败即跳过清理）。
    logger.warn("Delete Source Memory", "list entities failed, skip cleanup (non-fatal)", { error: toErrorMessage(err) })
    return
  }

  for (const file of entityFiles) {
    try {
      const content = await readFile(file.path)
      const sources = parseSources(content)
      const remainingSources = sources.filter((source) => !deletedSources.has(source))
      if (remainingSources.length === sources.length) continue

      if (remainingSources.length === 0) {
        await deleteFile(file.path)
        continue
      }

      await writeFileAtomic(file.path, writeSources(content, remainingSources))
    } catch (error) {
      logger.error("Delete Source Memory", "failed to clean entity source", { path: file.path, error: toErrorMessage(error) })
    }
  }
}

export async function deleteNovelSourceMemory(
  projectPath: string,
  input: DeleteNovelSourceMemoryInput,
): Promise<void> {
  const snapshotNumber = getChapterSnapshotNumberFromDeletedSource(input)
  if (snapshotNumber === null) return
  const { deleteChapterSnapshots } = await import("@/lib/novel/chapter-ingest")
  await deleteChapterSnapshots(projectPath, snapshotNumber)
  await cleanupDeletedSourceEntities(projectPath, snapshotNumber)
}
