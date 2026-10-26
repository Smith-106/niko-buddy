// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useTranslation } from "react-i18next"
import { Sparkles } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"

export interface ChatPanelEmptyStateProps {
  onSuggest: (text: string) => void
}

// POLISH-08/D2 (odyssey-ui): empty state was a passive icon + two
// muted lines with opacity-stacked text (A11Y-002 contrast hit).
// Replaced with an actionable hero: token-colored icon, readable
// copy, and suggestion chips that one-click create+a conversation
// (onSuggest auto-creates the conversation). Turns a dead-end into
// an on-ramp — especially important for first-run users who don't
// yet know what the chat can do.
// M14-3: peeled from chat-panel.tsx (second incremental slice). Pure
// presentational component; reads novelMode from the store like
// ConversationTabs so the host only passes the single callback.
export function ChatPanelEmptyState({ onSuggest }: ChatPanelEmptyStateProps) {
  const { t } = useTranslation()
  const novelMode = useWikiStore((s) => s.novelMode)

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-6 w-6 shrink-0" />
        </div>
        <h3 className="text-base font-medium text-foreground">
          {t(novelMode ? "novel.chat.startNewConversation" : "chat.startNewConversation")}
        </h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t(novelMode ? "novel.chat.clickNewChatToBegin" : "chat.clickNewChatToBegin")}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {(novelMode
            ? [
                "帮我梳理当前小说的世界观和主要矛盾",
                "根据上一章结尾，构思下一章的冲突推进",
                "分析主角当前的性格弧线和发展空间",
              ]
            : [
                "总结一下当前项目的知识结构",
                "这个概念和哪些实体有关联？",
                "帮我对比这两个来源的观点差异",
              ]
          ).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggest(suggestion)}
              className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
