// Copyright (c) 2024 Niko-hub contributors. MIT License.
import {
  findChapterFileByNumber,
  normalizeChapterEditFile,
  readSelectedChapterNumberForFile,
  resolveChatEditTarget,
  validateStructuredChapterEditResult,
  writeDraft,
} from "@/lib/novel"
import { readFile } from "@/commands/fs"
import {
  ChapterAdoptionUnavailableError,
  getChapterWriteCoordinator,
  type ChapterWriteIntent,
} from "@/components/layout/preview-panel-helpers"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileStem } from "@/lib/path-utils"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { refreshProjectState } from "@/lib/project-refresh"
import { streamChat } from "@/lib/llm-client"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { MessageReference } from "@/stores/chat-store"
import type { StreamSessionGuard } from "./stream-session"

export interface ChatEditModeContext {
  /** 用户原始请求文本。 */
  text: string
  /** 已被 handleSend 捕获的会话 ID（finalizeStream 目标）。 */
  capturedConvId: string
  /** stream-session guard 分配的会话代数。 */
  sessionId: number
  /** 归一化后的项目根路径。 */
  pp: string
  /** 当前选中文件（用于定位待改章节）。 */
  selectedFile: string | null
  /** 已解析的生效 LLM 配置。 */
  effectiveChatLlmConfig: LlmConfig
  /** 调用方预创建的取消控制器（R2-U01/U06：支持装配期即中止）。 */
  controller?: AbortController
  finalizeStream: (content: string, references?: MessageReference[] | undefined, targetConvId?: string) => void
  appendStreamToken: (token: string, conversationId: string) => void
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
  streamSessionGuardRef: { current: StreamSessionGuard }
}

/**
 * 章节修改模式（chat-panel 拆分 T4；R2-U01 中止与写协调器加固）。
 *
 * 行为保留自 handleSend 内的 shouldUseEditMode 分支并收敛到 Draft-first 边界：
 * 目标解析失败 / 章节缺失 / 流式错误 / 结构化校验失败 / 单章缺少结果 /
 * 归一化失败各自经 streamSessionGuardRef.finish finalizeStream 后提前返回；
 * 已中止或失效会话绝不写盘；成功路径经 ChapterWriteCoordinator("chat-edit") 串行化
 * 剥离 YAML frontmatter 后通过 writeDraft 写入 .qm-drafts/ 待审草稿箱，等待作者采纳。
 */
export async function runChatEditMode(ctx: ChatEditModeContext): Promise<void> {
  const {
    text,
    capturedConvId,
    sessionId,
    pp,
    selectedFile,
    effectiveChatLlmConfig,
    finalizeStream,
    appendStreamToken,
    abortControllersRef,
    activeStreamSessionsRef,
    streamSessionGuardRef,
  } = ctx

  const controller = ctx.controller ?? new AbortController()
  if (!controller.signal.aborted && abortControllersRef.current[capturedConvId] !== controller) {
    abortControllersRef.current[capturedConvId] = controller
  }

  const isStillActive = () =>
    !controller.signal.aborted && streamSessionGuardRef.current.isActive(capturedConvId, sessionId)

  let finalized = false
  const finishWithMessage = (message: string) => {
    if (finalized) return
    finalized = true
    streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
      finalizeStream(message, [], capturedConvId)
      if (activeStreamSessionsRef.current[capturedConvId] === sessionId) {
        delete activeStreamSessionsRef.current[capturedConvId]
      }
    })
  }

  try {
    if (!isStillActive()) return

    const selectedChapterNumber = (await readSelectedChapterNumberForFile(selectedFile)) ?? null
    if (!isStillActive()) return

    const resolvedTarget = resolveChatEditTarget({
      userRequest: text,
      selectedChapterNumber,
    })
    if (!resolvedTarget.ok) {
      finishWithMessage(resolvedTarget.message)
      return
    }

    const coordinator = getChapterWriteCoordinator()
    const chapterPayloads = await Promise.all(
      resolvedTarget.target.chapterNumbers.map(async (chapterNumber) => {
        const chapterPath = await findChapterFileByNumber(pp, chapterNumber)
        if (!chapterPath) {
          return { chapterNumber, chapterPath: null, content: "", writeIntent: null as ChapterWriteIntent | null }
        }
        const observedSeq = coordinator.currentSequence()
        const writeIntent = coordinator.captureIntent("chat-edit", chapterPath, observedSeq)
        let original = ""
        try {
          original = await readFile(chapterPath)
        } catch (err) {
          logger.warn("ChatEditMode", "read chapter before edit failed, degrading to empty", {
            chapterPath,
            error: toErrorMessage(err),
          })
        }
        return { chapterNumber, chapterPath, content: original, writeIntent }
      }),
    )

    if (!isStillActive()) return

    if (chapterPayloads.some((item) => !item.chapterPath)) {
      const missing = chapterPayloads.filter((item) => !item.chapterPath).map((item) => item.chapterNumber).join("、")
      finishWithMessage(`未找到以下章节，暂时无法执行修改：第${missing}章`)
      return
    }

    const editPrompt = [
      "你正在执行小说章节修改任务。",
      "请严格按照用户要求修改指定章节内容。",
      "如果是多章修改，必须逐章返回完整修改稿。",
      "输出格式必须严格如下：",
      "【第11章】",
      "修改后的完整正文",
      "",
      "【第12章】",
      "修改后的完整正文",
      "",
      "不要解释，不要补充说明。",
      "",
      `用户要求：${text}`,
      "",
      "待修改章节如下：",
      ...chapterPayloads.map((item) => `【第${item.chapterNumber}章原文】\n${item.content}`),
    ].join("\n")

    let editResult = ""
    let editError: Error | null = null

    await streamChat(
      effectiveChatLlmConfig,
      [{ role: "user", content: editPrompt }],
      {
        onToken: (token) => {
          if (!isStillActive()) return
          editResult += token
          appendStreamToken(token, capturedConvId)
        },
        onDone: () => {},
        onError: (error) => {
          editError = error
        },
      },
      controller.signal,
      { reasoning: resolveUserVisibleReasoning(effectiveChatLlmConfig.reasoning) },
    )

    // R2-U01: 流结束后强验未中止且会话仍活跃，已中止绝不写回正式章。
    if (!isStillActive()) return

    if (editError) {
      const editErrorMessage = String(editError)
      finishWithMessage(`修改失败：${editErrorMessage}`)
      return
    }

    const validatedEdits = resolvedTarget.target.mode === "single"
      ? {
        ok: true as const,
        files: [{
          chapterNumber: resolvedTarget.target.chapterNumbers[0],
          content: editResult,
        }],
      }
      : validateStructuredChapterEditResult({
        content: editResult,
        targetChapterNumbers: resolvedTarget.target.chapterNumbers,
      })

    if (!validatedEdits.ok) {
      finishWithMessage(validatedEdits.message)
      return
    }

    for (const chapter of chapterPayloads) {
      if (!isStillActive()) return
      /* v8 ignore next */
      if (!chapter.chapterPath || !chapter.writeIntent) continue
      const chapterPath = chapter.chapterPath
      const rawResult = validatedEdits.files.find((item) => item.chapterNumber === chapter.chapterNumber)?.content
      if (!rawResult) {
        finishWithMessage(`第${chapter.chapterNumber}章缺少修改结果，已停止写回。`)
        return
      }
      const normalizedResult = normalizeChapterEditFile({
        targetChapterNumber: chapter.chapterNumber,
        content: rawResult,
        originalContent: chapter.content,
      })
      if (!normalizedResult.ok) {
        finishWithMessage(normalizedResult.message)
        return
      }
      const parsedNormalized = parseFrontmatter(normalizedResult.content.replace(/^\uFEFF/, ""))
      const draftBody = parsedNormalized.rawBlock
        ? parsedNormalized.body.replace(/^(?:\r?\n)+/, "")
        : normalizedResult.content
      if (!draftBody.trim()) {
        finishWithMessage(`第${chapter.chapterNumber}章修改结果正文为空，已停止生成草稿。`)
        return
      }
      const chapterName = getFileStem(chapterPath).trim() || `第${chapter.chapterNumber}章`
      if (!isStillActive()) return
      const admission = coordinator.admitMutation(chapter.writeIntent, [chapterPath], async () => {
        if (!isStillActive()) return
        await writeDraft(pp, chapterName, draftBody, {
          sourceConversationId: capturedConvId,
        })
      })
      if (admission.kind === "fenced") {
        finishWithMessage(`第${chapter.chapterNumber}章正在被保存或采纳，已停止生成修改草稿，请稍后重试。`)
        return
      }
      try {
        await admission.result
      } catch (err) {
        if (err instanceof ChapterAdoptionUnavailableError && err.reason === "relocated") {
          finishWithMessage(`第${chapter.chapterNumber}章路径已发生变更，已停止生成修改草稿，请刷新后重试。`)
          return
        }
        throw err
      }
      if (!isStillActive()) return
    }

    await refreshProjectState(pp)
    if (!isStillActive()) return
    /* v8 ignore next */
    if (chapterPayloads[0]?.chapterPath) {
      useWikiStore.getState().setSelectedFile(chapterPayloads[0].chapterPath)
    }
    finishWithMessage(
      resolvedTarget.target.mode === "single"
        ? `已完成第${resolvedTarget.target.chapterNumbers[0]}章修改并存入待审草稿箱，请在草稿箱审阅并采纳后再写入正式章节。`
        : `已完成 ${resolvedTarget.target.chapterNumbers.length} 个章节的批量修改并存入待审草稿箱，请在草稿箱审阅并采纳后再写入正式章节。`,
    )
  } catch (err) {
    if (isStillActive()) {
      finishWithMessage(`修改失败：${toErrorMessage(err)}`)
    }
  } finally {
    if (!finalized) {
      finalized = true
      streamSessionGuardRef.current.finish(capturedConvId, sessionId, () => {
        if (!controller.signal.aborted) {
          finalizeStream("已停止生成。", [], capturedConvId)
        }
        if (activeStreamSessionsRef.current[capturedConvId] === sessionId) {
          delete activeStreamSessionsRef.current[capturedConvId]
        }
      })
    }
    if (abortControllersRef.current[capturedConvId] === controller) {
      delete abortControllersRef.current[capturedConvId]
    }
    if (activeStreamSessionsRef.current[capturedConvId] === sessionId) {
      delete activeStreamSessionsRef.current[capturedConvId]
    }
  }
}
