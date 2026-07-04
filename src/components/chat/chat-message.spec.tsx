import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { DisplayMessage } from "@/stores/chat-store"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { getDeepChapterToggleButtonClass } from "./chat-panel"

vi.mock("@/lib/novel/agent-parser", () => ({
  parseAgentResponse: (content: string) => ({
    textContent: content,
    edits: [],
    hasEdits: false,
  }),
}))

function tenThinkingLines(): string {
  return Array.from({ length: 10 }, (_value, index) => `stage line ${index + 1}`).join("\n")
}

function createAssistantMessage(content: string): DisplayMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content,
    timestamp: 0,
    conversationId: "conv-1",
  }
}

describe("chat thinking display", () => {
  it("keeps completed thinking content in a fixed scrollable panel", () => {
    const thinking = tenThinkingLines()
    const html = renderToStaticMarkup(
      <StreamingMessage content={`<think>\n${thinking}\n</think>\n\nfinal answer`} />,
    )

    expect(html).toContain("stage line 1")
    expect(html).toContain("stage line 10")
    expect(html).toContain("max-h-")
    expect(html).toContain("overflow-y-auto")
    expect(html).not.toContain("Thought for")
  })

  it("keeps streaming thinking content in a fixed scrollable panel", () => {
    const thinking = tenThinkingLines()
    const html = renderToStaticMarkup(<StreamingMessage content={`<think>\n${thinking}`} />)

    expect(html).toContain("stage line 1")
    expect(html).toContain("stage line 10")
    expect(html).not.toContain("h-[5lh]")
    expect(html).toContain("max-h-")
    expect(html).toContain("overflow-y-auto")
  })
})

describe("deep chapter thinking toggle style", () => {
  it("uses a clear dark selected state when deep chapter generation is enabled", () => {
    const activeClassName = getDeepChapterToggleButtonClass(true)
    const inactiveClassName = getDeepChapterToggleButtonClass(false)

    expect(activeClassName).toContain("bg-primary")
    expect(activeClassName).toContain("text-primary-foreground")
    expect(activeClassName).toContain("border-primary")
    expect(inactiveClassName).not.toContain("bg-primary")
  })
})

describe("chapter save preview sync regression", () => {
  it("always routes AI chapter saves to the next chapter instead of reusing the current chapter", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain('strategy.action === "direct_explicit_target_new"')
    expect(source).toContain("await getNextChapterNumber(pp)")
    expect(source).toContain('updateChapterStatus(')
    expect(source).toContain('"final"')
    expect(source).toContain("commitAcceptedDeepChapterDraft({")
    expect(source).toContain("let nextStatus = `已接受草稿并保存为 ${chapterTitle}`")
  })

  it("no longer uses the pending chapter save dialog flow", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).not.toContain("pendingChapterSaveDialog")
    expect(source).not.toContain("applyPendingChapterSave")
    expect(source).not.toContain("保存到章节后面")
  })
})

describe("deep chapter unfinished continuation action", () => {
  it("shows a continuation button and explanation for failed deep chapter thinking", () => {
    const source = readFileSync(resolve(__dirname, "chat-message.tsx"), "utf8")

    expect(source).toContain("onContinueUnfinished")
    expect(source).toContain("继续未完成")
    expect(source).toContain("节省 token")
    expect(source).toContain("canContinueUnfinishedDeepChapter")
  })

  it("wires the continuation action through chat panel without rerunning regenerate", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("handleContinueUnfinished")
    expect(source).toContain("buildContinueUnfinishedDeepChapterPrompt")
    expect(source).toContain("appendContinueUnfinishedDeepChapterContext")
    expect(source).toContain("extractContinueUnfinishedDeepChapterContext")
    expect(source).toContain("contextPackToPrompt")
    expect(source).toContain('addMessage("user", "继续未完成")')
    expect(source).toContain("resolveNovelModel")
    expect(source).toContain("onContinueUnfinished={isLastAssistant ? () => handleContinueUnfinished(msg) : undefined}")
  })

  it("binds continue-unfinished to the assistant message conversation instead of the active tab", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")
    const start = source.indexOf("const handleContinueUnfinished = useCallback(async (assistantMessage: DisplayMessage) => {")
    const end = source.indexOf("let continuationSystemPrompt =", start)
    const snippet = source.slice(start, end)

    expect(snippet).toContain("let convId = assistantMessage.conversationId?.trim()")
    expect(snippet).toContain("storeState.setActiveConversation(convId)")
    expect(snippet).toContain('useChatStore.getState().messages.filter((message) => message.conversationId === convId)')
    expect(snippet).toContain("buildInterruptedResumeContextPayload(statusResume, convId)")
  })

  it("keeps the ai chat footer labels as readable Chinese text", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("深度模式")
    expect(source).toContain("编辑章节")
    expect(source).toContain("继续未完成")
  })

  it("starts continue-next-chapter in a fresh conversation before sending", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")
    const start = source.indexOf("const handleContinueNextChapter = useCallback(() => {")
    const end = source.indexOf("const handleContinueUnfinished = useCallback", start)
    const snippet = source.slice(start, end)

    expect(snippet).toContain("createConversation()")
    expect(snippet).toContain("handleSend(`请根据当前小说上下文、记忆库、最新章节结尾、下一章推进建议和章纲，继续生成下一章正文。")
  })
})

describe("deep chapter session persistence wiring", () => {
  it("persists deep chapter generation progress into novel-session-status during runtime", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("startDeepChapterSession({")
    expect(source).toContain("persistDeepChapterCheckpoint({")
    expect(source).toContain("completeDeepChapterSession({")
    expect(source).toContain("blockDeepChapterSession({")
    expect(source).toContain("pauseDeepChapterSession({")
  })

  it("allows continue-unfinished to fall back to status.json when chat message context is incomplete", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("loadNovelSessionStatus(")
    expect(source).toContain("buildInterruptedResumeContextPayload(statusResume, convId)")
    expect(source).toContain("const resumeCheckpoint = statusResumeCheckpoint ?? persistedResume?.checkpoint")
    expect(source).toContain("const resumeContext = statusResumePayload?.resumeContext || persistedResume?.resumeContext || visibleAssistantContent")
  })

  it("lets the normal deep send path auto-resume when the same running status session still exists", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("resolveInterruptedSessionResumeCheckpoint")
    expect(source).toContain("autoResumedFromStatus")
    expect(source).toContain("resumeCheckpoint: interruptedResumeCheckpoint")
  })

  it("reads deep chapter toggle from shared state before entering the send branch", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("const sharedDeepChapterEnabledRef = { current: false }")
    expect(source).toContain("useState(sharedDeepChapterEnabledRef.current)")
    expect(source).toContain("sharedDeepChapterEnabledRef.current = resolvedValue")
    expect(source).toContain("const deepChapterEnabledNow = sharedDeepChapterEnabledRef.current")
    expect(source).toContain("if (novelMode && project && deepChapterEnabledNow)")
  })
})

describe("deep chapter draft action visibility", () => {
  it("hides chapter draft actions for stopped assistant status messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("已停止生成。")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps only continue-unfinished for failed deep chapter messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n出错：深度生成章节失败：HTTP 429")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps continue-unfinished for manually stopped deep chapter messages with resume context", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n已停止生成。\n<!-- qmai-continue-unfinished-context:%7B%22originalRequest%22%3A%22%E8%AF%B7%E4%B8%BA%E7%AC%AC1%E7%AB%A0%E7%94%9F%E6%88%90%E6%AD%A3%E6%96%87%22%2C%22resumeContext%22%3A%22%3Cthink%3E%23%23%20%E9%98%B6%E6%AE%B51%EF%BC%9A%E4%B8%8A%E4%B8%8B%E6%96%87%E5%88%86%E6%9E%90%3C%2Fthink%3E%22%2C%22checkpoint%22%3A%7B%22version%22%3A1%2C%22originalRequest%22%3A%22%E8%AF%B7%E4%B8%BA%E7%AC%AC1%E7%AB%A0%E7%94%9F%E6%88%90%E6%AD%A3%E6%96%87%22%2C%22chapterNumber%22%3A1%2C%22stage%22%3A%22after_context%22%7D%7D -->")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("keeps continue-unfinished for manually stopped deep chapter messages with only debug metadata", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage("<think>## 阶段1：上下文分析</think>\n\n已停止生成。\n<!-- qmai-novel-session-debug:%7B%22flow%22%3A%22deep-chapter%22%2C%22lastCheckpointStage%22%3A%22after_context%22%7D -->")}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
        onContinueUnfinished={() => {}}
      />,
    )

    expect(html).toContain("继续未完成")
    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })

  it("shows chapter draft actions for generated chapter content", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22ready%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).toContain("接受草稿")
    expect(html).toContain("拒绝草稿")
  })

  it("only allows reject while the managed draft is still pending manual review", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22pending%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).toContain("拒绝草稿")
  })

  it("does not show draft actions once the managed draft marker is accepted", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "The protagonist leaned into the seam first, listening for proof that the movement inside belonged to more than the wind.",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%2C%22draftStatus%22%3A%22accepted%22%7D -->",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("鎺ュ彈鑽夌")
    expect(html).not.toContain("鎷掔粷鑽夌")
    expect(html).not.toContain("缁х画鐢熸垚涓嬩竴绔?")
  })

  it("does not show chapter draft actions for plain assistant chapter-like text without a managed draft marker", () => {
    const chapterDraft = [
      "# Chapter 4 Cold Key",
      "",
      "Rain tapped along the broken tiles in steady layers, and the old roofline caught enough light to look sharpened by the dark.",
      "",
      "When the door finally opened, damp dust rolled out in a low wave, and the cabinet inside carried the mark of a hurried search.",
    ].join("\n")

    const html = renderToStaticMarkup(
      <ChatMessage
        message={createAssistantMessage(chapterDraft)}
        isLastAssistant
        novelMode
        onSaveAsChapter={() => {}}
        onDiscardDraft={() => {}}
        onContinueNextChapter={() => {}}
      />,
    )

    expect(html).not.toContain("接受草稿")
    expect(html).not.toContain("拒绝草稿")
  })
})
