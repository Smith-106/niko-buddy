import { PanelBottom, PanelRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore, type ChatDockPosition } from "@/stores/wiki-store"

const DOCK_TARGETS: Record<ChatDockPosition, {
  value: ChatDockPosition
  labelKey: string
  icon: typeof PanelBottom
}> = {
  bottom: { value: "right", labelKey: "chat.dockToSidebar", icon: PanelRight },
  right: { value: "bottom", labelKey: "chat.dockToBottom", icon: PanelBottom },
}

export function ChatDockControls() {
  const { t } = useTranslation()
  const chatDockPosition = useWikiStore((s) => s.chatDockPosition)
  const setChatDockPosition = useWikiStore((s) => s.setChatDockPosition)
  const target = DOCK_TARGETS[chatDockPosition]
  const Icon = target.icon
  const label = t(target.labelKey)

  return (
    <div className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-muted/30 p-0.5">
      <button
        type="button"
        onClick={() => setChatDockPosition(target.value)}
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={label}
        aria-label={label}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
