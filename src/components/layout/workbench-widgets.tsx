// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Buddy Contributors

/** 工作台顶部「下一步推荐 / 最近使用」两块（UX 审计批次三·12）。 */

import { useTranslation } from "react-i18next"
import { ArrowRight, History } from "lucide-react"
import type { WikiState } from "@/stores/wiki-store"
import { NAV_ITEMS } from "./nav-items"
import { nextStepRecommendations } from "./workbench-helpers"

type View = WikiState["activeView"]

export function WorkbenchNextSteps({ hasProject, onOpen }: { hasProject: boolean; onOpen: (view: View) => void }) {
  const { t } = useTranslation()
  const items = nextStepRecommendations(hasProject)
  return (
    <section className="mb-5" data-testid="workbench-next-steps">
      <h2 className="mb-2 text-sm font-semibold">{t("wb.nextTitle")}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map((item, index) => (
          <button
            key={item.view}
            type="button"
            data-next-step={item.view}
            onClick={() => onOpen(item.view)}
            className={
              index === 0
                ? "flex flex-col items-start gap-1 rounded-lg border border-primary bg-primary/5 p-4 text-left hover:bg-primary/10"
                : "flex flex-col items-start gap-1 rounded-lg border p-4 text-left hover:border-primary/50 hover:bg-accent/50"
            }
          >
            <span className="flex items-center gap-1 text-sm font-medium">
              {t(item.labelKey)}
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs text-muted-foreground">{t(item.descKey)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function WorkbenchRecentViews({ views, onOpen }: { views: readonly View[]; onOpen: (view: View) => void }) {
  const { t } = useTranslation()
  const known = views
    .map((view) => NAV_ITEMS.find((item) => item.view === view))
    .filter((item): item is (typeof NAV_ITEMS)[number] => Boolean(item))
  if (known.length === 0) return null
  return (
    <section className="mb-6" data-testid="workbench-recent">
      <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold text-muted-foreground">
        <History className="h-4 w-4" />
        {t("wb.recentTitle")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {known.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.view}
              type="button"
              data-recent-view={item.view}
              onClick={() => onOpen(item.view)}
              className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs hover:border-primary/50 hover:bg-accent/50"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              {t(item.labelKey)}
            </button>
          )
        })}
      </div>
    </section>
  )
}
