import { deleteFile, fileExists, writeFileAtomic } from "@/commands/fs"
import { toErrorMessage, logger } from "@/lib/utils"
import { acceptDeepChapterDraft } from "./novel-session-status"
import { updateEmotionLedgerFromChapter } from "./emotion-ledger"
import { promote, sha256Prefix } from "./promotion-bridge"

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
    // E-05 (run-execute-1, 双库架构蓝图) C-7/C-13: formal-writeback 通道接线。
    // accept 成功后触发晋升（PromotionRecord 落盘 + 事件日志）。
    // 失败/歧义 → 入 promotion-retry 队列 + warn，**不回滚 accept/正文**
    // （accept 唯一不可逆门，铁律②；「已 accept 未晋升」是可补偿态，重放收敛）。
    try {
      const digestPrefix = await sha256Prefix(input.finalChapterContent)
      await promote({
        channel: "formal-writeback",
        projectPath: input.projectPath,
        chapterId: `chapter-${input.chapterNumber}`,
        chapterNumber: input.chapterNumber,
        revision: 1,
        entity: `chapter-${input.chapterNumber}`,
        acceptTimestamp: new Date().toISOString(),
        gateContext: { draftStatus: "accepted", decisionGatesPass: true, manualFinal: false },
        contentDigestPrefix: digestPrefix,
      })
    } catch (promotionError) {
      logger.warn(
        "promotion-bridge",
        `formal-writeback promote failed (non-fatal, chapter ${input.chapterNumber}): ${toErrorMessage(promotionError)}`,
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
