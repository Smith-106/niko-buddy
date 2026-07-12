import { deleteFile, fileExists, writeFileAtomic } from "@/commands/fs"
import { toErrorMessage } from "@/lib/utils"
import { acceptDeepChapterDraft } from "./novel-session-status"

export interface CommitAcceptedDeepChapterDraftInput {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber: number
  chapterPath: string
  finalChapterContent: string
  sessionId?: string
}

export async function commitAcceptedDeepChapterDraft(
  input: CommitAcceptedDeepChapterDraftInput,
): Promise<void> {
  if (await fileExists(input.chapterPath)) {
    throw new Error(`Formal chapter already exists: ${input.chapterPath}`)
  }

  await writeFileAtomic(input.chapterPath, input.finalChapterContent)

  try {
    await acceptDeepChapterDraft({
      projectPath: input.projectPath,
      conversationId: input.conversationId,
      userRequest: input.userRequest,
      chapterNumber: input.chapterNumber,
      sessionId: input.sessionId,
      formalChapterPath: input.chapterPath,
    })
  } catch (error) {
    try {
      await deleteFile(input.chapterPath)
    } catch (rollbackError) {
      throw new Error(
        `Failed to roll back formal chapter write after draft accept failure: ${toErrorMessage(rollbackError)}; original error: ${toErrorMessage(error)}`,
      )
    }
    throw error
  }
}
