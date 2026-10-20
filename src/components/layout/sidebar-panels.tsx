import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { Button } from "@/components/ui/button"
import { Users } from "lucide-react"

export function SearchHistoryPanel() {
  const { t } = useTranslation()
  const searchHistory = useWikiStore((s) => s.searchHistory)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setSearchTrigger = useWikiStore((s) => s.setSearchTrigger)

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="text-sm font-semibold text-foreground">
          {t("novel.nav.search")}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {searchHistory.length === 0 ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">{t("novel.outlineImport.noHistory")}</div>
        ) : (
          <div className="space-y-1">
            {searchHistory.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setActiveView("search")
                  setSearchTrigger({ query: item, ts: Date.now() })
                }}
                className="w-full rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <span className="line-clamp-2 break-all">{item}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


export function MemoryCenterListButton({
  label,
  count,
  selected,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  icon: typeof Users
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      className="h-auto w-full justify-between px-3 py-2.5"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-3 shrink-0 text-sm font-semibold leading-none">{count}</span>
    </Button>
  )
}
