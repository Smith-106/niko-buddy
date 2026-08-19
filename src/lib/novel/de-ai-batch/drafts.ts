/**
 * Wave 4 (v2.5.0): 批量去AI味 — 草稿工件 IO。
 *
 * 草稿内容落 .novel/de-ai-batch-drafts/{chapterNumber}.json（与既有
 * .novel/drafts/ 工件模式同构）；状态/指针在 status.json de_ai_batch 字段。
 * 草稿工件是内容工件而非会话状态文件，不违反 status.json 唯一真源。
 */

import { createDirectory, deleteFile, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { DE_AI_BATCH_SCHEMA, type DeAiBatchDraftArtifact } from "./types"

const DE_AI_BATCH_DRAFTS_DIR = "de-ai-batch-drafts"

export function deAiBatchDraftsDirPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${DE_AI_BATCH_DRAFTS_DIR}`
}

export function deAiBatchDraftPath(projectPath: string, chapterNumber: number): string {
  return `${deAiBatchDraftsDirPath(projectPath)}/${chapterNumber}.json`
}

export async function saveDeAiBatchDraft(
  projectPath: string,
  artifact: DeAiBatchDraftArtifact,
): Promise<string> {
  const path = deAiBatchDraftPath(projectPath, artifact.chapterNumber)
  await createDirectory(deAiBatchDraftsDirPath(projectPath))
  await writeFileAtomic(path, JSON.stringify(artifact, null, 2))
  return path
}

export async function loadDeAiBatchDraft(
  projectPath: string,
  chapterNumber: number,
): Promise<DeAiBatchDraftArtifact | null> {
  const path = deAiBatchDraftPath(projectPath, chapterNumber)
  try {
    const raw = await readFile(path)
    const parsed = JSON.parse(raw) as DeAiBatchDraftArtifact
    if (parsed?.schemaVersion !== DE_AI_BATCH_SCHEMA || parsed.chapterNumber !== chapterNumber) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function deleteDeAiBatchDraft(projectPath: string, chapterNumber: number): Promise<boolean> {
  const path = deAiBatchDraftPath(projectPath, chapterNumber)
  if (!(await fileExists(path))) return false
  await deleteFile(path)
  return true
}
