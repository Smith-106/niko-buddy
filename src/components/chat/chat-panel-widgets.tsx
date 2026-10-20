import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { deleteFile } from "@/commands/fs"
import { formatOperationError } from "@/lib/format-operation-error"
import { getConversationTabTitle, sortConversationsByUpdatedAt } from "@/lib/workspace-layout"
import { useChatStore, type DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

export function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function findPreviousUserRequest(messages: DisplayMessage[], assistantMessageId: string): string | undefined {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId)
  const searchRange = assistantIndex >= 0 ? messages.slice(0, assistantIndex) : messages
  const userMessages = [...searchRange].reverse().filter((message) => message.role === "user")
  return userMessages.find((message) => message.content.trim() !== "继续未完成")?.content ?? userMessages[0]?.content
}

export async function loadEnabledDismantlingDirective(projectPath: string): Promise<string> {
  void projectPath
  return ""
}

export function ConversationTabs({ onAbortStream }: { onAbortStream: (convId: string) => void }) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const streamingContents = useChatStore((s) => s.streamingContents)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // R4 共识（deepseek+qwen）: 会话文件的物理删除失败会被完全吞掉（`.catch(() => {})`），
  // 而内存态已移除 ⇒ 用户以为已删除，重载后旧会话又出现且无任何解释。改为如实反馈。
  const [deleteFileError, setDeleteFileError] = useState<string | null>(null)
  // MI-009 (odyssey-ui): delete is destructive — two-step confirm so a stray
  // click (or a touch tap meant to switch tabs) can't silently wipe a
  // conversation. Single shared state keyed by conv id keeps the map flat.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const sorted = sortConversationsByUpdatedAt(conversations)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  function handleDeleteConversation(convId: string, onAbortStream: (convId: string) => void) {
    onAbortStream(convId)
    deleteConversation(convId)
    const proj = useWikiStore.getState().project
    if (proj) {
      deleteFile(`${proj.path}/.niko-buddy/chats/${convId}.json`).catch((err) => {
        // 内存态已移除，但磁盘文件仍在：必须如实告知，否则重载后会话“复活”无法解释。
        setDeleteFileError(formatOperationError(t, err))
      })
    }
    setConfirmDeleteId(null)
  }

  return (
    <div className="@container shrink-0 border-b bg-muted/20 px-2 py-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-2 rounded-full"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          {t(novelMode ? "novel.chat.newChat" : "chat.newChat")}
        </Button>

        {sorted.length === 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(novelMode ? "novel.chat.noConversationsYet" : "chat.noConversationsYet")}
          </span>
        ) : (
          <div role="tablist" className="flex items-center gap-2">
            {sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const isThisStreaming = conv.id in streamingContents
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                // IS-006/A11Y-008 (odyssey-ui): outer was a <button> with a
                // nested <span onClick> delete — nested interactive elements
                // are invalid HTML and the delete was keyboard-unreachable.
                // Switched to a div[role=tab] so the delete can be a real
                // focusable <button>. Enter/Space activates the tab (W3C ARIA
                // Pattern for tabs). focus-visible ring restored.
                className={`group flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? "border-primary/40 bg-background text-foreground shadow-sm"
                    : "border-border bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                onClick={() => setActiveConversation(conv.id)}
                onKeyDown={(e) => {
                  /* v8 ignore next */
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setActiveConversation(conv.id)
                  }
                }}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
                title={conv.title}
              >
                {isThisStreaming && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
                <span className="max-w-[140px] truncate font-medium">
                  {getConversationTabTitle(conv.title, 10)}
                </span>
                <span className="hidden text-[0.625rem] tabular-nums text-muted-foreground @md:inline">{msgCount}</span>
                <span className="hidden text-[0.625rem] tabular-nums text-muted-foreground @md:inline">{formatDate(conv.updatedAt)}</span>
                {/*
                 * MI-002/MI-009 (odyssey-ui): delete button.
                 * - Real <button> with aria-label (was <span onClick> — AT + keyboard blind).
                 * - Visible on hover AND focus-within AND when active, so touch users
                 *   who can't hover still get it on the active tab (touch fallback).
                 * - Two-step confirm: first click arms (icon → "确认?" text), second
                 *   click within the same tab deletes. Leaving the tab resets.
                 */}
                {(() => {
                  const armed = confirmDeleteId === conv.id
                  const visible = hoveredId === conv.id || isActive || armed
                  // ui-audit-20261016 P0-B5（F-A3，WCAG 2.1.1）：旧实现在不可见时直接
                  // `return null`，键盘用户 Tab 永远到不了删除钮。改为常渲染 + opacity
                  // 隐藏（隐藏时 pointer-events-none，避免看不见的点击区）；获得焦点
                  // 或所属行内出现焦点时重新显现。
                  return (
                    <button
                      type="button"
                      aria-label={armed ? "确认删除该会话" : "删除该会话"}
                      title={armed ? "再次点击确认删除" : "删除该会话"}
                      className={`shrink-0 rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible ? "opacity-100" : "pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"} ${
                        armed
                          ? "bg-destructive/10 px-1.5 text-destructive"
                          : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (armed) {
                          handleDeleteConversation(conv.id, onAbortStream)
                        } else {
                          setConfirmDeleteId(conv.id)
                        }
                      }}
                      onBlur={() => setConfirmDeleteId((cur) => (cur === conv.id ? null : cur))}
                    >
                      {armed ? (
                        <span className="text-[0.625rem] font-medium">{t("chat.confirmShort")}</span>
                      ) : (
                        <Trash2 className="h-3 w-3 shrink-0" />
                      )}
                    </button>
                  )
                })()}
              </div>
            )
            })}
          </div>
        )}
      </div>
      {deleteFileError ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {deleteFileError}
        </p>
      ) : null}
    </div>
  )
}
