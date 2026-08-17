import { describe, expect, it } from "vitest"
import {
  clampChatHeight,
  clampChatWidth,
  clampSidebarWidth,
  getConversationTabTitle,
  getPreviewContentContainerClass,
  isWorkspaceView,
  shouldUseCompactChapterToolbar,
  sortConversationsByUpdatedAt,
} from "./workspace-layout"
import type { Conversation } from "@/stores/chat-store"

describe("workspace layout", () => {
  it("uses the compact chapter toolbar when the preview header is narrow", () => {
    expect(shouldUseCompactChapterToolbar(640)).toBe(true)
    expect(shouldUseCompactChapterToolbar(560)).toBe(true)
  })

  it("shows the full chapter toolbar when there is enough room", () => {
    expect(shouldUseCompactChapterToolbar(920)).toBe(false)
    expect(shouldUseCompactChapterToolbar(1040)).toBe(false)
  })

  it("keeps the outer preview content from scrolling in immersive chapter writing", () => {
    expect(getPreviewContentContainerClass(true)).toContain("overflow-hidden")
  })

  it("keeps the outer preview content scrollable for normal files", () => {
    expect(getPreviewContentContainerClass(false)).toContain("overflow-auto")
  })

  it("identifies workspace-level sidebar views", () => {
    expect(isWorkspaceView("wiki")).toBe(true)
    expect(isWorkspaceView("trash")).toBe(true)
    expect(isWorkspaceView("sources")).toBe(false)
    expect(isWorkspaceView("search")).toBe(false)
    expect(isWorkspaceView("graph")).toBe(false)
    expect(isWorkspaceView("lint")).toBe(false)
    expect(isWorkspaceView("review")).toBe(false)
    expect(isWorkspaceView("characterAura")).toBe(false)
    expect(isWorkspaceView("settings")).toBe(false)
  })

  it("clamps the sidebar width into the 150-400 px range", () => {
    expect(clampSidebarWidth(50)).toBe(150)
    expect(clampSidebarWidth(600)).toBe(400)
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(150)).toBe(150)
    expect(clampSidebarWidth(400)).toBe(400)
  })

  it("clamps the chat panel height into the 180-520 px range", () => {
    expect(clampChatHeight(10)).toBe(180)
    expect(clampChatHeight(900)).toBe(520)
    expect(clampChatHeight(400)).toBe(400)
    expect(clampChatHeight(180)).toBe(180)
    expect(clampChatHeight(520)).toBe(520)
  })

  it("clamps the chat panel width into the 280-520 px range", () => {
    expect(clampChatWidth(10)).toBe(280)
    expect(clampChatWidth(900)).toBe(520)
    expect(clampChatWidth(400)).toBe(400)
    expect(clampChatWidth(280)).toBe(280)
    expect(clampChatWidth(520)).toBe(520)
  })

  it("truncates conversation titles with an ellipsis", () => {
    expect(getConversationTabTitle("short")).toBe("short")
    expect(getConversationTabTitle("a".repeat(20))).toBe(`${"a".repeat(11)}…`)
    expect(getConversationTabTitle("a".repeat(20), 5)).toBe("aaaa…")
    // maxLength 1 → still at least one char before the ellipsis
    expect(getConversationTabTitle("abc", 1)).toBe("a…")
  })

  it("sorts conversations by most recently updated first without mutating input", () => {
    const older: Conversation = {
      id: "a",
      title: "old",
      createdAt: 1,
      updatedAt: 1,
      deAiMode: false,
    }
    const newer: Conversation = {
      id: "b",
      title: "new",
      createdAt: 2,
      updatedAt: 2,
      deAiMode: false,
    }
    const input = [older, newer]
    const sorted = sortConversationsByUpdatedAt(input)
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"])
    expect(input.map((c) => c.id)).toEqual(["a", "b"])
  })
})
