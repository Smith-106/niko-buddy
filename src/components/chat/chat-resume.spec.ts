import { describe, expect, it } from "vitest"
import {
  appendContinueUnfinishedDeepChapterContext,
  buildInterruptedResumeContextPayload,
  buildContinueUnfinishedDeepChapterPrompt,
  canContinueUnfinishedDeepChapter,
  extractContinueUnfinishedDeepChapterContext,
  hydrateChatHistoryWithInterruptedDeepChapter,
  stripContinueUnfinishedDeepChapterContext,
} from "./chat-resume"
import type { NovelSessionStatus } from "@/lib/novel/novel-session-status"

describe("chat deep chapter resume", () => {
  it("only allows continuation for failed deep chapter messages with thinking content", () => {
    expect(canContinueUnfinishedDeepChapter("<think>阶段1</think>\n\n出错：深度生成章节失败：无法连接")).toBe(true)
    expect(canContinueUnfinishedDeepChapter("<think>## 继续未完成\n已经继续了一段</think>\n\n出错：继续未完成失败：error sending request")).toBe(true)
    expect(canContinueUnfinishedDeepChapter("出错：深度生成章节失败：无法连接")).toBe(false)
    expect(canContinueUnfinishedDeepChapter("<think>阶段1</think>\n\n普通回答")).toBe(false)
  })

  it("builds a continuation prompt that reuses previous thinking without restarting all stages", () => {
    const prompt = buildContinueUnfinishedDeepChapterPrompt({
      originalRequest: "生成第3章内容",
      failedAssistantContent: "<think>\n## 阶段1：上下文分析\n## 阶段6：简单审查\n</think>\n\n出错：深度生成章节失败：error sending request",
    })

    expect(prompt).toContain("生成第3章内容")
    expect(prompt).toContain("阶段6：简单审查")
    expect(prompt).toContain("不要从头重复生成这些阶段")
    expect(prompt).toContain("从第一次未完成的那个缺口继续")
    expect(prompt).toContain("节省 token")
  })

  it("persists the original deep request in a hidden resume context", () => {
    const visible = "<think>阶段1：上下文分析</think>\n\n出错：深度生成章节失败：HTTP 429"
    const withContext = appendContinueUnfinishedDeepChapterContext(visible, {
      originalRequest: "生成第3章，主角进入旧城",
      resumeContext: "阶段1：上下文分析\n阶段2：任务书\n目标：生成第3章",
      rootResumeContext: "阶段1：上下文分析\n阶段2：任务书\n阶段4：字数审核与正文优化",
      checkpoint: {
        version: 1,
        originalRequest: "生成第3章，主角进入旧城",
        chapterNumber: 3,
        stage: "after_review",
        taskBrief: "任务书",
        draftContent: "正文草稿",
        reviewResults: [],
      },
    })

    expect(withContext).toContain(visible)
    expect(stripContinueUnfinishedDeepChapterContext(withContext)).toBe(visible)

    const parsed = extractContinueUnfinishedDeepChapterContext(withContext)
    expect(parsed?.originalRequest).toBe("生成第3章，主角进入旧城")
    expect(parsed?.resumeContext).toContain("阶段2：任务书")
    expect(parsed?.rootResumeContext).toContain("阶段4：字数审核与正文优化")
    expect(parsed?.checkpoint?.stage).toBe("after_review")
  })

  it("strips hidden session debug comments from visible resume content", () => {
    const visible = [
      "<think>## 阶段1：上下文分析</think>",
      "",
      "已停止生成。",
      "<!-- qmai-novel-session-debug:%7B%22flow%22%3A%22deep-chapter%22%7D -->",
    ].join("\n")

    expect(stripContinueUnfinishedDeepChapterContext(visible)).toBe([
      "<think>## 阶段1：上下文分析</think>",
      "",
      "已停止生成。",
    ].join("\n"))
  })

  it("uses the persisted original request instead of the visible continue command", () => {
    const prompt = buildContinueUnfinishedDeepChapterPrompt({
      originalRequest: "继续未完成",
      failedAssistantContent: "<think>## 继续未完成\n只有很短的二次失败思考</think>\n\n出错：继续未完成失败：HTTP 429",
      resumeContext: "原始阶段1：上下文分析\n原始阶段2：任务书\n章节目标：生成第3章，主角进入旧城",
      persistedOriginalRequest: "生成第3章，主角进入旧城",
    })

    expect(prompt).toContain("生成第3章，主角进入旧城")
    expect(prompt).toContain("原始阶段2：任务书")
    expect(prompt).not.toContain("原始用户请求：\n继续未完成")
  })

  it("keeps the first unfinished chain as the primary resume context after later retries fail", () => {
    const prompt = buildContinueUnfinishedDeepChapterPrompt({
      originalRequest: "继续未完成",
      persistedOriginalRequest: "生成第3章，主角进入旧城",
      failedAssistantContent: "<think>## 继续未完成\n只有很短的二次失败思考</think>\n\n出错：继续未完成失败：HTTP 429",
      rootResumeContext: "原始阶段4：字数审核与正文优化\n第 1 次优化完成",
      resumeContext: "原始阶段4：字数审核与正文优化\n第 1 次优化完成\n\n## 最近一次继续未完成失败时的输出\n只有很短的二次失败思考",
    })

    expect(prompt).toContain("原始阶段4：字数审核与正文优化")
    expect(prompt).toContain("最近一次“继续未完成”失败时的输出")
    expect(prompt).toContain("以原始阶段链为准")
  })

  it("hydrates startup chat state with a visible continue-unfinished entry for interrupted sessions", () => {
    const status: NovelSessionStatus = {
      schema_version: "1",
      session_id: "novel-20260630-000001",
      source: "deep_chapter_generation",
      created_at: "2026-06-30T00:00:01.000Z",
      updated_at: "2026-06-30T00:00:09.000Z",
      status: "running",
      active_step_index: 3,
      current_task: {
        task_id: "tsk-conv-11",
        conversation_id: "conv-11",
        user_request: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
        chapter_number: 11,
        checkpoint_stage: "after_review",
        status: "running",
      },
      draft: {
        draft_id: "conv-11",
        file_path: "E:/Novel/.novel/drafts/conv-11.json",
        draft_status: "pending",
        checkpoint_stage: "after_review",
        updated_at: "2026-06-30T00:00:09.000Z",
      },
      decision_gates: {
        consistency: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pass",
      },
      evidence_refs: ["E:/Novel/.novel/drafts/conv-11.json"],
      resume_checkpoint: {
        version: 1,
        originalRequest: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
        chapterNumber: 11,
        stage: "after_review",
        taskBrief: "TASK BRIEF",
        draftContent: "正文草稿",
        reviewResults: [],
      },
    }

    const hydrated = hydrateChatHistoryWithInterruptedDeepChapter({
      conversations: [],
      messages: [],
    }, status, Date.parse("2026-06-30T00:00:10.000Z"))

    expect(hydrated.focusConversationId).toBe("conv-11")
    expect(hydrated.conversations).toHaveLength(1)
    expect(hydrated.messages).toHaveLength(2)
    expect(hydrated.messages[0]?.role).toBe("user")
    expect(hydrated.messages[1]?.role).toBe("assistant")
    expect(hydrated.messages[1]?.content).toContain("已停止生成。")
    expect(canContinueUnfinishedDeepChapter(hydrated.messages[1]?.content ?? "")).toBe(true)
    const parsed = extractContinueUnfinishedDeepChapterContext(hydrated.messages[1]?.content ?? "")
    expect(parsed?.checkpoint?.stage).toBe("after_review")
    expect(parsed?.originalRequest).toBe("生成第11章，写一段约120字的中文小说正文，只输出正文。")
  })

  it("does not duplicate an existing continue-unfinished bootstrap message", () => {
    const status: NovelSessionStatus = {
      schema_version: "1",
      session_id: "novel-20260630-000001",
      source: "deep_chapter_generation",
      created_at: "2026-06-30T00:00:01.000Z",
      updated_at: "2026-06-30T00:00:09.000Z",
      status: "paused",
      active_step_index: 2,
      current_task: {
        task_id: "tsk-conv-11",
        conversation_id: "conv-11",
        user_request: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
        chapter_number: 11,
        checkpoint_stage: "after_draft",
        status: "paused",
      },
      draft: {
        draft_id: "conv-11",
        file_path: "E:/Novel/.novel/drafts/conv-11.json",
        draft_status: "pending",
        checkpoint_stage: "after_draft",
        updated_at: "2026-06-30T00:00:09.000Z",
      },
      decision_gates: {
        consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: ["E:/Novel/.novel/drafts/conv-11.json"],
      resume_checkpoint: {
        version: 1,
        originalRequest: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
        chapterNumber: 11,
        stage: "after_draft",
        taskBrief: "TASK BRIEF",
        draftContent: "正文草稿",
        reviewResults: [],
      },
    }
    const existingMessage = appendContinueUnfinishedDeepChapterContext("<think>阶段</think>\n\n已停止生成。", {
      originalRequest: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
      resumeContext: "阶段",
      checkpoint: status.resume_checkpoint,
    })

    const hydrated = hydrateChatHistoryWithInterruptedDeepChapter({
      conversations: [{
        id: "conv-11",
        title: "生成第11章",
        createdAt: 1,
        updatedAt: 2,
        deAiMode: false,
      }],
      messages: [
        {
          id: "u1",
          role: "user",
          content: "生成第11章，写一段约120字的中文小说正文，只输出正文。",
          timestamp: 1,
          conversationId: "conv-11",
        },
        {
          id: "a1",
          role: "assistant",
          content: existingMessage,
          timestamp: 2,
          conversationId: "conv-11",
        },
      ],
    }, status)

    expect(hydrated.messages).toHaveLength(2)
  })

  it("rebuilds authoritative resume context from status.json instead of trusting stale message context", () => {
    const status: NovelSessionStatus = {
      schema_version: "1",
      session_id: "novel-20260630-000002",
      source: "deep_chapter_generation",
      created_at: "2026-06-30T00:10:01.000Z",
      updated_at: "2026-06-30T00:10:09.000Z",
      status: "paused",
      active_step_index: 3,
      current_task: {
        task_id: "tsk-conv-22",
        conversation_id: "conv-22",
        user_request: "请为第 2 章生成正文",
        chapter_number: 2,
        checkpoint_stage: "after_review",
        status: "paused",
      },
      draft: {
        draft_id: "conv-22",
        file_path: "E:/Novel/.novel/drafts/conv-22.json",
        draft_status: "pending",
        checkpoint_stage: "after_draft",
        updated_at: "2026-06-30T00:10:09.000Z",
      },
      decision_gates: {
        consistency: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        anti_ai: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
        overall: "pending",
      },
      evidence_refs: ["E:/Novel/.novel/drafts/conv-22.json"],
      resume_checkpoint: {
        version: 1,
        originalRequest: "请为第 2 章生成正文",
        chapterNumber: 2,
        stage: "after_draft",
        taskBrief: "任务书",
        draftContent: "旧草稿正文",
        reviewResults: [],
        currentContent: "review 后正文",
      },
    }

    const rebuilt = buildInterruptedResumeContextPayload(status, "conv-22")

    expect(rebuilt?.originalRequest).toBe("请为第 2 章生成正文")
    expect(rebuilt?.checkpoint?.stage).toBe("after_review")
    expect(rebuilt?.resumeContext).toContain("阶段：after_review")
    expect(rebuilt?.resumeContext).toContain("当前正文草稿")
    expect(rebuilt?.resumeContext).toContain("review 后正文")
  })
})
