/**
 * UI layout helpers for the workspace sidebar, chat panel,
 * chapter toolbar, and conversation list.
 * MIT License — independently implemented.
 */

import type { Conversation } from "@/stores/chat-store"

/** Whether the given sidebar view is a workspace-level view (wiki or trash). */
export function isWorkspaceView(view: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "characterAura" | "settings" | "trash"): boolean {
  return view === "wiki" || view === "trash"
}

/** Constrain the sidebar width to the 150–400 px range. */
export function clampSidebarWidth(width: number): number {
  return Math.max(150, Math.min(400, width))
}

/** Constrain the chat panel height to the 180–520 px range. */
export function clampChatHeight(height: number): number {
  return Math.max(180, Math.min(520, height))
}

/** Constrain the chat panel width to the 280–520 px range. */
export function clampChatWidth(width: number): number {
  return Math.max(280, Math.min(520, width))
}

/** Switch to the compact chapter toolbar when the viewport is narrower than 720 px. */
export function shouldUseCompactChapterToolbar(width: number): boolean {
  return width < 720
}

/**
 * Return Tailwind classes for the preview content container.
 * In immersive chapter mode scrolling is disabled (overflow-hidden);
 * otherwise the container scrolls normally.
 */
export function getPreviewContentContainerClass(immersiveChapter: boolean): string {
  return immersiveChapter
    ? "flex-1 min-w-0 overflow-hidden"
    : "flex-1 min-w-0 overflow-auto"
}

/**
 * Truncate a conversation tab title to `maxLength` characters,
 * replacing the last character with an ellipsis when truncated.
 */
export function getConversationTabTitle(title: string, maxLength = 12): string {
  if (title.length <= maxLength) return title
  return `${title.slice(0, Math.max(1, maxLength - 1))}…`
}

/** Return conversations sorted by most recently updated first. */
export function sortConversationsByUpdatedAt(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}
