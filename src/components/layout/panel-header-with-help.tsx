import { CircleHelp } from "lucide-react"
import { openExternalUrl } from "@/lib/open-external-url"
import { getHelpLinkUrl, type HelpLinkKey } from "@/config/help-links"

interface PanelHeaderWithHelpProps {
  title: string
  helpKey?: HelpLinkKey
  helpTitle?: string
  className?: string
}

/**
 * 面板标题组件：title + 可选帮助链接（鼠标悬停变色、点击打开飞书文档）。
 *
 * 如果 helpKey 找不到对应链接，则只显示标题（不显示问号图标），保证安全降级。
 */
export function PanelHeaderWithHelp({
  title,
  helpKey,
  helpTitle,
  className = "text-sm font-semibold text-foreground transition-colors hover:text-primary",
}: PanelHeaderWithHelpProps) {
  const helpUrl = helpKey ? getHelpLinkUrl(helpKey) : null

  return (
    <div className="flex items-center gap-1.5">
      {helpUrl ? (
        <button type="button"
          className={`cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm ${className}`}
          title={helpTitle ?? `${title}使用说明`}
          onClick={(e) => {
            e.stopPropagation()
            void openExternalUrl(helpUrl)
          }}
        >
          {title}
        </button>
      ) : (
        <span className={className}>{title}</span>
      )}
      {helpUrl ? <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" /> : null}
    </div>
  )
}
