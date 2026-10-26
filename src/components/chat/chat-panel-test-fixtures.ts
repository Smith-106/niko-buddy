/**
 * M6-1 切片：chat-panel 测试脚手架的纯数据 fixture 簇 + 状态/mock 默认行为工厂。
 *
 * 来源：`./chat-panel-test-setup`（原 1526 行巨石）。本文件只收与 `vi` 无关的纯逻辑，
 * `vi.hoisted` mock 仓与全部 `vi.mock` 工厂必须留在原文件（vitest 要求 mock 工厂只能
 * 引用同文件 hoisted 变量，跨文件必炸），故原文件保留对外 import 面：全部同名符号经
 * re-export / 薄 wrapper 原签名透出，4 个 chat-panel spec 的导入路径零改动。
 */

import type {
  DeepChapterDecisionGates,
  DeepChapterGenerationResult,
  NovelReviewResult,
  NovelSessionStatus,
} from "@/lib/novel"
import zhLocaleChatPanel from "@/i18n/zh.json"

/* eslint-disable @typescript-eslint/no-explicit-any */

export function lookupZhChatPanel(key: string): string | undefined {
  let o: unknown = zhLocaleChatPanel
  for (const p of key.split(".")) {
    if (o == null || typeof o !== "object") return undefined
    o = (o as Record<string, unknown>)[p]
  }
  return typeof o === "string" ? o : undefined
}

// ── 测试侧构造器（真实类型，与原文件逐字一致）─────────────────────────────────
export const EMPTY_DECISION_GATES: DeepChapterDecisionGates = {
  consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
  overall: "pass",
}

export function deepGenResult(over: Partial<DeepChapterGenerationResult> = {}): DeepChapterGenerationResult {
  return {
    finalContent: "F",
    taskBrief: "",
    draftContent: "",
    reviewResults: [],
    revised: false,
    decisionGates: EMPTY_DECISION_GATES,
    manualReviewRequired: false,
    retryCount: 0,
    partial: false,
    partialReason: null,
    // Wave 5 (v2.5.0): 上下文用量快照（additive，缺省 undefined）
    contextUsage: {
      memoryChars: 80,
      retrievalChars: 5120,
      graphChars: 2048,
      bodyChars: 51200,
      otherChars: 25600,
      maxCtx: 100000,
    },
    ...over,
  }
}

export function reviewResult(over: Partial<NovelReviewResult> = {}): NovelReviewResult {
  return {
    severity: "error",
    type: "consistency",
    message: "review finding",
    evidence: "",
    relatedMemory: "",
    suggestion: "",
    ...over,
  }
}

export const SESSION_STATUS_BASE: NovelSessionStatus = {
  schema_version: "1",
  session_id: "session-1",
  source: "deep_chapter_generation",
  created_at: "t",
  updated_at: "t",
  status: "paused",
  active_step_index: 1,
  current_task: {
    task_id: "tsk-conv-1",
    conversation_id: "conv-1",
    user_request: "需求",
    checkpoint_stage: "started",
    status: "paused",
  },
  draft: {
    draft_id: "draft-1",
    file_path: "/p/mybook/.novel/drafts/draft-1.md",
    draft_status: "pending",
    updated_at: "t",
  },
  decision_gates: EMPTY_DECISION_GATES,
  evidence_refs: [],
}

export type SessionStatusOverrides = Partial<Omit<NovelSessionStatus, "current_task" | "draft">> & {
  current_task?: Partial<NovelSessionStatus["current_task"]>
  draft?: Partial<NovelSessionStatus["draft"]>
}

export function sessionStatus(over: SessionStatusOverrides = {}): NovelSessionStatus {
  return {
    ...SESSION_STATUS_BASE,
    ...over,
    current_task: { ...SESSION_STATUS_BASE.current_task, ...(over.current_task ?? {}) },
    draft: { ...SESSION_STATUS_BASE.draft, ...(over.draft ?? {}) },
  }
}

// ── 状态重置（原 `resetStates` 本体，`mocks.chatState/wikiState` 经参数注入）───
export function resetChatPanelStates(chatState: any, wikiState: any): void {
  Object.assign(chatState, {
    conversations: [],
    activeConversationId: null,
    messages: [],
    streamingContents: {},
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 20,
  })
  Object.assign(wikiState, {
    project: null,
    novelMode: false,
    novelConfig: {
      autoIngestOnSave: false,
      residualCampaignEnabled: false,
      contextTokenBudget: 0,
      chapterTargetChars: 3000,
    },
    llmConfig: {
      provider: "openai",
      apiKey: "",
      model: "gpt-test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
      reasoning: { mode: "auto" },
    },
    providerConfigs: {},
    aiChatModel: "",
    chatEditModeEnabled: false,
    selectedFile: null,
    dataVersion: 0,
  })
}

// ── mock 默认行为（原 `resetMockDefaults` 本体，`mocks` 经参数注入）─────────────
export function applyChatPanelMockDefaults(m: any): void {
  m.t.mockImplementation((key: string, opts?: { message?: string }) => {
    const base = lookupZhChatPanel(key) ?? key
    return opts?.message ? `${base}::${opts.message}` : base
  })
  m.streamChat.mockImplementation(async (_config: any, _messages: any, handlers: any) => {
    handlers?.onDone?.()
  })
  m.routeTask.mockImplementation(() => ({
    intent: "general_chat",
    confidence: 1,
    chapterNumber: undefined,
    extractedParams: {},
  }))
  m.streamGuard.isActive.mockReturnValue(true)
  m.streamGuard.start.mockReturnValue(1)
  m.readFile.mockImplementation(async () => "")
  m.fileExists.mockImplementation(async () => false)
  m.searchWiki.mockImplementation(async () => [])
  m.isGreeting.mockReturnValue(false)
  m.detectGoldenThreeChapterRequest.mockReturnValue({ enabled: false, requestedFirstThree: false })
  m.buildGoldenThreeChapterDirective.mockReturnValue("")
  m.buildTaskDirective.mockReturnValue("")
  m.buildQmQuaiSystemPrompt.mockReturnValue("")
  m.isChatEditRequest.mockReturnValue(false)
  m.resolveChatEditTarget.mockReturnValue({ ok: false as const, message: "无法解析目标章节" })
  m.validateStructuredChapterEditResult.mockReturnValue({ ok: false as const, message: "解析失败" })
  m.normalizeChapterEditFile.mockReturnValue({ ok: true as const, content: "NORMALIZED" })
  m.findChapterFileByNumber.mockImplementation(async () => null)
  m.decideChapterSaveStrategy.mockReturnValue({ action: "direct_next_chapter" })
  m.detectGeneratedTargetChapterNumber.mockReturnValue(null)
  m.readSelectedChapterNumberForFile.mockImplementation(async () => undefined)
  m.getNextChapterNumber.mockImplementation(async () => 7)
  m.detectLastGeneratedChapterNumber.mockReturnValue(undefined)
  m.resolveTargetChapterNumberForChat.mockImplementation(async () => 5)
  m.loadNovelSessionStatus.mockImplementation(async () => {
    throw new Error("no status")
  })
  m.resolveInterruptedSessionResumeCheckpoint.mockReturnValue(undefined)
  m.startDeepChapterSession.mockImplementation(async () => sessionStatus({ status: "running" }))
  m.runDeepChapterGeneration.mockImplementation(async () => deepGenResult({ finalContent: "FINAL" }))
  m.pauseDeepChapterSession.mockImplementation(async () =>
    sessionStatus({ current_task: { last_error: undefined } }),
  )
  m.persistDeepChapterCheckpoint.mockImplementation(async () => sessionStatus({ status: "running" }))
  m.buildContextPack.mockImplementation(async () => ({
    task: "",
    chapterGoal: "",
    outline: "",
    recentSummaries: [],
    previousChapterEnding: "",
    characterStates: "",
    soulDoc: "",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "",
    timeline: "",
    relatedSettings: "",
    canonRules: "",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }))
  m.contextPackToPrompt.mockReturnValue("CONTEXT_PROMPT")
  m.detectEditIntent.mockReturnValue(false)
  m.readScopeFileContents.mockImplementation(async () => [])
  m.buildAgentSystemSuffix.mockReturnValue("AGENT_SUFFIX")
  m.buildRetrievalGraph.mockImplementation(async () => ({ nodes: new Map(), dataVersion: 0 }))
  m.getRelatedNodes.mockReturnValue([])
  m.deepStreamRenderer.updateThinking.mockImplementation((c: string) => c)
  m.deepStreamRenderer.appendFinal.mockImplementation((c: string) => c)
  m.deepStreamRenderer.getContent.mockReturnValue("")
  m.extractContinueUnfinishedDeepChapterContext.mockReturnValue(null)
  m.buildInterruptedResumeContextPayload.mockReturnValue(null)
  m.buildContinueUnfinishedDeepChapterPrompt.mockReturnValue("RESUME_PROMPT")
  m.appendContinueUnfinishedDeepChapterContext.mockImplementation((content: string) => content)
  m.cleanGeneratedChapterContentWithTitle.mockImplementation((content: string) => ({
    content,
    title: "测试章",
  }))
  m.ingestChapter.mockImplementation(async () => ({ snapshot: null }))
  m.exemplarABStats.mockReturnValue({ enabledAvg: null, disabledAvg: null })
  m.loadStyleExemplarsViaRust.mockImplementation(async () => [])
  m.markStyleExemplarViaRust.mockImplementation(async () => {})
  m.deleteStyleExemplarViaRust.mockImplementation(async () => {})
  m.refreshProjectState.mockImplementation(async () => {})
  m.executeIngestWrites.mockImplementation(async () => [])
  m.resolveChapterLengthSpec.mockReturnValue({
    targetChars: 3000,
    minChars: 1500,
    draftMaxChars: 6000,
    maxOutputTokens: 4000,
  })
  m.createNovelSessionId.mockReturnValue("synthetic-session")
  m.hasUsableLlm.mockReturnValue(true)
}
