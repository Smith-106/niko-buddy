import { deleteFile, fileExists, writeFileAtomic } from "@/commands/fs"
import { toErrorMessage, logger } from "@/lib/utils"
import { acceptDeepChapterDraft } from "./novel-session-status"
import { updateEmotionLedgerFromChapter } from "./emotion-ledger"

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
    // A19 emotion-ledger 写入端 (B 方案, PLN-20260716-emotion-ledger-writehook):
    // accept 成功后扫正文提取情绪基调 + 共现匹配出场角色 + 写情绪账本。
    // Draft-first 守恒: 仅在 accept 成功后写账本 (正式层), draft 生成点不写。
    // DD-3 failure 降级: 账本写失败只 logger.warn, 不回滚正文, 不抛错 —
    // 正文是正式层已落盘, emotion-ledger 是派生观测层 (fold_rebuildable),
    // 回滚正文会违反 Draft-first accept 不可逆, 与 Circuit Breaker catch 降级一致。
    try {
      await updateEmotionLedgerFromChapter(
        input.projectPath,
        input.chapterNumber,
        input.finalChapterContent,
      )
    } catch (emotionError) {
      logger.warn(
        "emotion-ledger",
        `write failed (non-fatal, chapter ${input.chapterNumber}): ${toErrorMessage(emotionError)}`,
      )
    }
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
