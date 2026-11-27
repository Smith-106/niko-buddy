import { deleteFile, fileExists, readFileAsBase64, writeFilesAtomic } from "@/commands/fs"
import { toErrorMessage, logger, todayStamp } from "@/lib/utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { parseChapterNumber } from "./chapter-meta"
import { chapterMarkdownHasBody, readManagedChapterHeader } from "./chapter-save-strategy"
import { acceptDeepChapterDraft, markExternalDraftAcceptedInStatus } from "./novel-session-status"
import { updateEmotionLedgerFromChapter } from "./emotion-ledger"
import { promote, resolveNextPromotionRevision, sha256Prefix } from "./promotion-bridge"

export interface FinalizeAcceptedChapterInput {
  projectPath: string
  chapterNumber: number
  formalChapterPath?: string
  finalChapterContent: string
  /** 可选：需要同步外部草稿（`.qm-drafts/`）状态到 `.novel/status.json` 时传入。 */
  syncExternalStatus?: {
    draftId?: string
    chapterName?: string
    targetKey?: string
  }
  /** 是否手动最终采纳（透传给 promote gateContext.manualFinal，默认 false）。 */
  manualFinal?: boolean
}

/**
 * 采纳后共享写回总闸（Chat 深章与外部 `.qm-drafts/` 采纳路径共用）：
 * 1. 可选同步外部草稿状态到 `.novel/status.json`（含 chase_debt 记账/计息）；
 * 2. 提取正文情绪基调并写回 emotion-ledger；
 * 3. 触发 formal-writeback 通道晋升凭证（PromotionRecord 落盘）。
 *
 * 所有步骤均为 non-fatal try/catch（使用 `toErrorMessage` 记 warn）：
 * 正式正文落盘是唯一不可逆门（Draft-first 铁律），派生层失败绝不回滚正文、不向上抛错。
 */
export async function finalizeAcceptedChapter(
  input: FinalizeAcceptedChapterInput,
): Promise<void> {
  if (input.syncExternalStatus && input.formalChapterPath) {
    try {
      await markExternalDraftAcceptedInStatus({
        projectPath: input.projectPath,
        draftId: input.syncExternalStatus.draftId,
        formalChapterPath: input.formalChapterPath,
        chapterNumber: input.chapterNumber,
        chapterName: input.syncExternalStatus.chapterName,
        targetKey: input.syncExternalStatus.targetKey,
        finalChapterContent: input.finalChapterContent,
      })
    } catch (statusError) {
      logger.warn(
        "Novel Session",
        `external draft status sync failed (non-fatal, chapter ${input.chapterNumber}): ${toErrorMessage(statusError)}`,
      )
    }
  }
  // A19 emotion-ledger 写入端 (B 方案, PLN-20260716-emotion-ledger-writehook):
  // accept 成功后扫正文提取情绪基调 + 共现匹配出场角色 + 写情绪账本。
  // Draft-first 守恒: 仅在 accept 成功后写账本 (正式层), draft 生成点不写。
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
  // accept 成功后触发晋升（PromotionRecord 落盘 + 事件日志），失败仅 warn 不回滚正文。
  try {
    const digestPrefix = await sha256Prefix(input.finalChapterContent)
    const chapterId = `chapter-${input.chapterNumber}`
    const promotionsFilePath = `${normalizePath(input.projectPath)}/.novel/promotions.json`
    const revision = (await fileExists(promotionsFilePath))
      ? await resolveNextPromotionRevision(
          input.projectPath,
          "formal-writeback",
          chapterId,
          chapterId,
          digestPrefix,
        )
      : 1
    await promote({
      channel: "formal-writeback",
      projectPath: input.projectPath,
      chapterId,
      chapterNumber: input.chapterNumber,
      revision,
      entity: chapterId,
      acceptTimestamp: new Date().toISOString(),
      gateContext: {
        draftStatus: "accepted",
        decisionGatesPass: true,
        manualFinal: input.manualFinal ?? false,
      },
      contentDigestPrefix: digestPrefix,
    })
  } catch (promotionError) {
    logger.warn(
      "promotion-bridge",
      `formal-writeback promote failed (non-fatal, chapter ${input.chapterNumber}): ${toErrorMessage(promotionError)}`,
    )
  }
}

export interface CommitAcceptedDeepChapterDraftInput {
  projectPath: string
  conversationId: string
  userRequest: string
  chapterNumber: number
  chapterPath: string
  finalChapterContent: string
  sessionId?: string
  overwriteExisting?: boolean
  expectedExistingContent?: string | null
}

export function buildManagedChapterDocument(chapterNumber: number, title: string, body: string, source?: "autonomous-campaign"): string {
  return [
    "---",
    "type: chapter",
    `chapter_number: ${chapterNumber}`,
    "chapter_status: final",
    `title: ${JSON.stringify(title)}`,
    ...(source ? [`source: ${source}`] : []),
    `created: ${todayStamp()}`,
    "---",
    body,
  ].join("\n")
}

/** The ordinary Markdown reader strips the BOM and can decode legacy bytes lossily. */
export async function readManagedChapterForWrite(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null
  const { base64 } = await readFileAsBase64(path)
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0)))
}

/**
 * 正式正文「写 + 校验 + 回滚闭包」：先缓存原文（不可读则中止，零写入），
 * 拒绝未授权覆盖已有正文，writeFilesAtomic 守卫批量落盘并回读校验精确字节；
 * 返回 undo 闭包——若 accept 后续步骤失败，把正文还原到写前状态。
 * 单文件原子写本身不是 ACID 多文件事务；rollback 只碰本次新写的精确字节。
 */
async function writeVerifiedChapter(
  input: CommitAcceptedDeepChapterDraftInput,
): Promise<() => Promise<void>> {
  const path = input.chapterPath
  const match = /(?:^|\/)chapter-(\d+)\.md$/i.exec(normalizePath(path))
  if (match && Number(match[1]) !== input.chapterNumber) {
    throw new Error("Formal chapter filename does not match the reviewed chapter")
  }
  const original = await readManagedChapterForWrite(path)
  if (input.expectedExistingContent !== undefined && original !== input.expectedExistingContent) {
    throw new Error("The target chapter changed after confirmation")
  }

  if (original === null) {
    const canonicalName = `chapter-${String(input.chapterNumber).padStart(3, "0")}.md`
    if (getFileName(path) !== canonicalName) {
      throw new Error("New formal chapters must use the canonical chapter filename")
    }
  } else {
    const markdown = original.replace(/^\uFEFF/, "")
    const existingChapterNumber = parseFrontmatter(markdown).frontmatter?.chapter_number
    if ((!match || existingChapterNumber !== undefined) && parseChapterNumber(existingChapterNumber) !== input.chapterNumber) {
      throw new Error("The existing formal chapter does not match the reviewed chapter")
    }
    if (!input.overwriteExisting && chapterMarkdownHasBody(markdown)) {
      throw new Error(`Formal chapter already exists: ${path}`)
    }
  }

  const rollback = async () => {
    const current = await readManagedChapterForWrite(path)
    if (current === original) return
    if (current !== input.finalChapterContent) {
      throw new Error("Formal chapter changed during acceptance; rollback left it untouched")
    }
    if (original !== null) {
      await writeFilesAtomic([[path, original]], [input.finalChapterContent])
      if ((await readManagedChapterForWrite(path)) !== original) {
        throw new Error("Could not verify restored formal chapter")
      }
    } else {
      await deleteFile(path, input.finalChapterContent)
      if (await fileExists(path)) {
        throw new Error("Could not verify removal of the newly written chapter")
      }
    }
  }

  await writeFilesAtomic([[path, input.finalChapterContent]], [original])
  try {
    if ((await readManagedChapterForWrite(path)) !== input.finalChapterContent) {
      throw new Error(`Could not verify the written formal chapter: ${path}`)
    }
  } catch (error) {
    try {
      await rollback()
    } catch (rollbackError) {
      throw new Error(`Failed to roll back formal chapter write: ${toErrorMessage(rollbackError)}; original error: ${toErrorMessage(error)}`)
    }
    throw error
  }
  return rollback
}

const FINALIZABLE_CHAPTER_STATUS_RE =
  /^([ \t]*chapter_status:[ \t]*)(['"]?)(?:planned|draft|revised|outline|archived)\2(?=[ \t]*(?:#[^\r\n]*)?\r?$)/m

/**
 * 将既有章节 frontmatter 块的 `chapter_status` 升级为 `final`，
 * 无损保留可选 UTF-8 BOM、CRLF/LF 换行、引号、缩进与行尾注释。
 * 已为 `final` 时逐字节原样返回；缺失 `chapter_status` 时在闭合 `---` 前插入；
 * 非法或无法升级的状态一律 fail-loud 抛错。
 */
export function finalizeChapterFrontmatterBlock(rawBlock: string): string {
  const fm = parseFrontmatter(rawBlock.replace(/^\uFEFF/, "")).frontmatter
  if (!fm) {
    throw new Error("Could not finalize the existing chapter header")
  }
  if (fm.chapter_status === "final") {
    return rawBlock
  }
  let nextBlock = rawBlock
  if (FINALIZABLE_CHAPTER_STATUS_RE.test(rawBlock)) {
    nextBlock = rawBlock.replace(FINALIZABLE_CHAPTER_STATUS_RE, "$1$2final$2")
  } else if (fm.chapter_status === undefined && !/^[ \t]*chapter_status:/m.test(rawBlock)) {
    const eol = rawBlock.includes("\r\n") ? "\r\n" : "\n"
    nextBlock = rawBlock.replace(/(\r?\n)(---\s*)$/, `$1chapter_status: final${eol}$2`)
  }
  if (parseFrontmatter(nextBlock.replace(/^\uFEFF/, "")).frontmatter?.chapter_status !== "final") {
    throw new Error("Could not finalize the existing chapter header")
  }
  return nextBlock
}

function chapterDocumentForWrite(input: CommitAcceptedDeepChapterDraftInput, original: string | null): string {
  const candidate = readManagedChapterHeader(input.finalChapterContent)
  if (!candidate || !candidate.prefix.endsWith("\n") || candidate.frontmatter?.type !== "chapter"
    || candidate.chapterNumber !== input.chapterNumber || candidate.frontmatter.chapter_status !== "final") {
    throw new Error("Formal chapter frontmatter does not match the reviewed draft")
  }
  if (original === null) return input.finalChapterContent
  const existing = readManagedChapterHeader(original)
  if (!existing) {
    if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(original)) throw new Error("The existing formal chapter has a malformed header")
    return original.startsWith("\uFEFF") && !input.finalChapterContent.startsWith("\uFEFF")
      ? `\uFEFF${input.finalChapterContent}` : input.finalChapterContent
  }
  if (existing.frontmatter?.type !== "chapter" || existing.chapterNumber !== input.chapterNumber) {
    throw new Error("The existing formal chapter does not match the reviewed chapter")
  }
  let prefix = finalizeChapterFrontmatterBlock(existing.prefix)
  if (!prefix.endsWith("\n")) prefix += prefix.includes("\r\n") ? "\r\n" : "\n"
  return prefix + input.finalChapterContent.slice(candidate.prefix.length)
}

export async function commitAcceptedDeepChapterDraft(
  input: CommitAcceptedDeepChapterDraftInput,
): Promise<void> {
  // accept 会话锁内先执行正式写（writeVerifiedChapter 返回 undo 闭包），
  // 随后 persist 失败时经闭包还原；正式写自身失败则直接上抛（原子单文件失败
  // 无中间态需还原）。accept 成功后 emotion-ledger / promotion 仍走
  // 既有 non-fatal 降级——派生失败不回滚正文。
  const original = await readManagedChapterForWrite(input.chapterPath)
  if (input.expectedExistingContent !== undefined && original !== input.expectedExistingContent) {
    throw new Error("The target chapter changed after confirmation")
  }
  const finalChapterContent = chapterDocumentForWrite(input, original)
  const writeInput = { ...input, expectedExistingContent: original, finalChapterContent }
  await acceptDeepChapterDraft({
    projectPath: input.projectPath,
    conversationId: input.conversationId,
    userRequest: input.userRequest,
    chapterNumber: input.chapterNumber,
    sessionId: input.sessionId,
    formalChapterPath: input.chapterPath,
    finalChapterContent,
    writeVerifiedChapter: () => writeVerifiedChapter(writeInput),
  })
  await finalizeAcceptedChapter({
    projectPath: input.projectPath,
    chapterNumber: input.chapterNumber,
    formalChapterPath: input.chapterPath,
    finalChapterContent,
  })
}
