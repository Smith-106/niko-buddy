import { deleteFile, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { toErrorMessage, logger } from "@/lib/utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isFinalChapter } from "./chapter-meta"
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
  overwriteExisting?: boolean
}

export async function commitAcceptedDeepChapterDraft(
  input: CommitAcceptedDeepChapterDraftInput,
): Promise<void> {
  // DF-2: 覆盖前缓存原文件是否存在及其原内容。accept/覆盖失败时回滚必须「还原文」
  // 而非硬删（旧实现 rollback=deleteFile，令 planned 骨架/旧稿永久销毁，回滚路径
  // 既不用回收站也不用备份设施）。
  let hadOriginalFile = false
  let originalContent: string | null = null
  if (await fileExists(input.chapterPath)) {
    hadOriginalFile = true
    try {
      originalContent = await readFile(input.chapterPath)
    } catch {
      // 原文件存在但读取失败 → 无法缓存；回滚时不得删除（删除只会销毁现场）。
      originalContent = null
    }
    if (!input.overwriteExisting && originalContent !== null) {
      try {
        const { frontmatter, body } = parseFrontmatter(originalContent)
        // 仅当已有文件明确为已定稿章节 (isFinalChapter 为 true 且正文字数 >= 100) 时拒绝覆盖
        const isFormalFinal = isFinalChapter(frontmatter ?? {}) && body.trim().length >= 100
        if (isFormalFinal) {
          throw new Error(`Formal chapter already exists: ${input.chapterPath}`)
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Formal chapter already exists")) {
          throw err
        }
        // 解析失败或非定稿章节（如 planned 骨架、未完成草稿）允许覆盖晋升；
        // 读取失败时 originalContent === null 走同一放行路径（与旧「读失败→允许覆盖」一致）。
      }
    }
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
      if (hadOriginalFile) {
        if (originalContent !== null) {
          // DF-2: 还原被覆盖前的原文（writeFileAtomic 原子还原），而非删除。
          await writeFileAtomic(input.chapterPath, originalContent)
        } else {
          // 原文在覆盖前已不可读、无法还原：保留现有文件（绝不删除），并留诊断日志。
          logger.warn(
            "formal-writeback",
            `rollback kept file after accept failure: original content was unreadable before overwrite (${input.chapterPath})`,
          )
        }
      } else {
        // 覆盖前文件不存在：本次写入的「新建文件」回滚删除（等同旧行为）。
        await deleteFile(input.chapterPath)
      }
    } catch (rollbackError) {
      throw new Error(
        `Failed to roll back formal chapter write after draft accept failure: ${toErrorMessage(rollbackError)}; original error: ${toErrorMessage(error)}`,
      )
    }
    throw error
  }
}
