// Copyright © 2024-2099 QAHUI (https://qmai.qimai-im.com/)
// SPDX-License-Identifier: MIT

import type { ChatDockPosition } from "@/stores/wiki-store"

export function getChatBarVisibility(chatExpanded: boolean, chatDockPosition: ChatDockPosition = "bottom") {
  const isVisible = chatExpanded && chatDockPosition === "bottom"
  return isVisible ? "expanded" : "hidden"
}

export function getNextChatExpanded(chatExpanded: boolean): boolean {
  return !chatExpanded
}

export function shouldShowWritingChat(chatExpanded: boolean, chatDockPosition: ChatDockPosition = "bottom"): boolean {
  return chatExpanded && chatDockPosition === "bottom"
}

export function shouldShowRightDockChat(chatExpanded: boolean, chatDockPosition: ChatDockPosition = "bottom"): boolean {
  return chatExpanded && chatDockPosition === "right"
}

export function getChapterToolbarOrder(): string[] {
  return ["ai-session", "de-ai", "chapter-status"]
}
