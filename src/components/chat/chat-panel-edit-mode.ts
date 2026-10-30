// Copyright (c) 2024 Niko-hub contributors. MIT License.
import {
  appendChapterWorkspaceSnapshot,
  backupChapterFile,
  findChapterFileByNumber,
  invalidateChapterCache,
  normalizeChapterEditFile,
  readSelectedChapterNumberForFile,
  resolveChatEditTarget,
  validateStructuredChapterEditResult,
} from "@/lib/novel"
import { readFile, writeFileAtomic } from "@/commands/fs"
import { resolveUserVisibleReasoning } from "@/lib/user-visible-reasoning"
import { refreshProjectState } from "@/lib/project-refresh"
import { streamChat } from "@/lib/llm-client"
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
  finalizeStream: (content: string, references?: MessageReference[] | undefined, targetConvId?: string) => void
  appendStreamToken: (token: string, conversationId: string) => void
  abortControllersRef: { current: Record<string, AbortController> }
  activeStreamSessionsRef: { current: Record<string, number> }
  streamSessionGuardRef: { current: StreamSessionGuard }
}

/**
 * 章节修改模式（chat-panel 拆分 T4）。
 *
 * 行为逐字保留自 handleSend 内的 shouldUseEditMode 分支：
 * 目标解析失败 / 章节缺失 / 流式错误 / 结构化校验失败 / 单章缺少结果 /
 * 归一化失败各自 finalizeStream 后提前返回；成功路径的
 * backup → appendChapterWorkspaceSnapshot → writeFileAtomic 顺序不变。
 * 所有 return 语义等同于「调用方在 await 之后立即 return」。
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

  const resolvedTarget = resolveChatEditTarget({
    userRequest: text,
    selectedChapterNumber: await readSelectedChapterNumberForFile(selectedFile) ?? null,
  })
  if (!resolvedTarget.ok) {
    finalizeStream(resolvedTarget.message, [], capturedConvId)
    delete activeStreamSessionsRef.current[capturedConvId]
    return
  }

  const chapterPayloads = await Promise.all(
    resolvedTarget.target.chapterNumbers.map(async (chapterNumber) => {
      const chapterPath = await findChapterFileByNumber(pp, chapterNumber)
      if (!chapterPath) {
        return { chapterNumber, chapterPath: null, content: "" }
      }
      const original = await readFile(chapterPath).catch(() => "")
      return { chapterNumber, chapterPath, content: original }
    }),
  )

  if (chapterPayloads.some((item) => !item.chapterPath)) {
    const missing = chapterPayloads.filter((item) => !item.chapterPath).map((item) => item.chapterNumber).join("、")
    finalizeStream(`未找到以下章节，暂时无法执行修改：第${missing}章`, [], capturedConvId)
    delete activeStreamSessionsRef.current[capturedConvId]
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

  const controller = new AbortController()
  abortControllersRef.current[capturedConvId] = controller
  let editResult = ""
  let editError: Error | null = null

  await streamChat(
    effectiveChatLlmConfig,
    [{ role: "user", content: editPrompt }],
    {
      onToken: (token) => {
        if (!streamSessionGuardRef.current.isActive(capturedConvId, sessionId)) return
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

  if (editError) {
    const editErrorMessage = String(editError)
    finalizeStream(`修改失败：${editErrorMessage}`, [], capturedConvId)
    delete activeStreamSessionsRef.current[capturedConvId]
    delete abortControllersRef.current[capturedConvId]
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
    finalizeStream(validatedEdits.message, [], capturedConvId)
    delete activeStreamSessionsRef.current[capturedConvId]
    delete abortControllersRef.current[capturedConvId]
    return
  }

  for (const chapter of chapterPayloads) {
    /* v8 ignore next */
    if (!chapter.chapterPath) continue
    const rawResult = validatedEdits.files.find((item) => item.chapterNumber === chapter.chapterNumber)?.content
    if (!rawResult) {
      finalizeStream(`第${chapter.chapterNumber}章缺少修改结果，已停止写回。`, [], capturedConvId)
      delete activeStreamSessionsRef.current[capturedConvId]
      delete abortControllersRef.current[capturedConvId]
      return
    }
    const normalizedResult = normalizeChapterEditFile({
      targetChapterNumber: chapter.chapterNumber,
      content: rawResult,
      originalContent: chapter.content,
    })
    if (!normalizedResult.ok) {
      finalizeStream(normalizedResult.message, [], capturedConvId)
      delete activeStreamSessionsRef.current[capturedConvId]
      delete abortControllersRef.current[capturedConvId]
      return
    }
    await backupChapterFile({
      projectPath: pp,
      chapterPath: chapter.chapterPath,
      chapterNumber: chapter.chapterNumber,
      content: chapter.content,
      source: "manual",
    })
    // 64 号实施接线（chapter-workspace 消费）：保存后追加快照（静默失败）
    await appendChapterWorkspaceSnapshot(pp, chapter.chapterNumber, normalizedResult.content)
    await writeFileAtomic(chapter.chapterPath, normalizedResult.content)
  }
  invalidateChapterCache(pp)

  await refreshProjectState(pp)
  /* v8 ignore next */
  if (chapterPayloads[0]?.chapterPath) {
    useWikiStore.getState().setSelectedFile(chapterPayloads[0].chapterPath)
  }
  finalizeStream(
    resolvedTarget.target.mode === "single"
      ? `已完成第${resolvedTarget.target.chapterNumbers[0]}章修改，并已自动备份原内容。`
      : `已完成 ${resolvedTarget.target.chapterNumbers.length} 个章节的批量修改，并已分别备份原内容。`,
    [],
    capturedConvId,
  )
  delete activeStreamSessionsRef.current[capturedConvId]
  delete abortControllersRef.current[capturedConvId]
  return
}
