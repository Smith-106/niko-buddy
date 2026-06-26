import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { NovelDraftRecord } from "./draft-record"
import { parseNovelDraftRecord } from "./draft-record"
import { DraftStatus } from "./draft-state-machine"

function artifactDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/drafts`
}

function artifactPath(projectPath: string, draftId: string): string {
  return `${artifactDir(projectPath)}/${draftId}.json`
}

export async function saveDraftArtifact(projectPath: string, draft: NovelDraftRecord): Promise<void> {
  await createDirectory(artifactDir(projectPath)).catch(() => {})
  await writeFile(artifactPath(projectPath, draft.draft_id), JSON.stringify(draft, null, 2))
}

export async function readDraftArtifact(projectPath: string, draftId: string): Promise<NovelDraftRecord | null> {
  try {
    const content = await readFile(artifactPath(projectPath, draftId))
    return parseNovelDraftRecord(JSON.parse(content))
  } catch {
    return null
  }
}

export async function supersedeDraftArtifact(projectPath: string, draft: NovelDraftRecord): Promise<NovelDraftRecord> {
  const superseded: NovelDraftRecord = {
    ...draft,
    draft_status: DraftStatus.Superseded,
    superseded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await saveDraftArtifact(projectPath, superseded)
  return superseded
}
