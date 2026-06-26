import { describe, expect, it } from "vitest"
import { buildRecoveredStreamContent, shouldAutoFinalizeRecoveredStream } from "./chat-panel"

describe("chat panel recovery helpers", () => {
  it("only auto-finalizes when persisted truth is completed for the active conversation", () => {
    expect(shouldAutoFinalizeRecoveredStream({
      isStreaming: true,
      activeConversationId: "conv-1",
      statusSchema: {
        status: "completed",
      } as never,
      draftConversationId: "conv-1",
    })).toBe(true)

    expect(shouldAutoFinalizeRecoveredStream({
      isStreaming: true,
      activeConversationId: "conv-1",
      statusSchema: {
        status: "running",
      } as never,
      draftConversationId: "conv-1",
    })).toBe(false)

    expect(shouldAutoFinalizeRecoveredStream({
      isStreaming: true,
      activeConversationId: "conv-1",
      statusSchema: {
        status: "completed",
      } as never,
      draftConversationId: "conv-2",
    })).toBe(false)
  })

  it("prefers visible streaming text, then persisted final, then persisted draft, then explanation fallback", () => {
    expect(buildRecoveredStreamContent({
      streamingContent: "stream visible",
      draftFinalContent: "final saved",
      draftContent: "draft saved",
      sessionExplanation: { detail: "completed" } as never,
    })).toBe("stream visible")

    expect(buildRecoveredStreamContent({
      streamingContent: "   ",
      draftFinalContent: "final saved",
      draftContent: "draft saved",
      sessionExplanation: { detail: "completed" } as never,
    })).toBe("final saved")

    expect(buildRecoveredStreamContent({
      streamingContent: "",
      draftFinalContent: "",
      draftContent: "draft saved",
      sessionExplanation: { detail: "completed" } as never,
    })).toBe("draft saved")

    expect(buildRecoveredStreamContent({
      streamingContent: "",
      draftFinalContent: "",
      draftContent: "",
      sessionExplanation: { detail: "status completed" } as never,
    })).toContain("status completed")
  })
})
