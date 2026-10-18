// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"
import { Construction, LayoutDashboard } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { getPlannedView } from "./planned-views"

/**
 * 计划态视图占位页。
 *
 * `activeView` 联合类型里的计划模块可以被 setActiveView / 深链赋值。没有这个
 * 占位页时它们会落到 content-area 的 `default`（聊天面板）——用户被送到一个
 * 与所选模块无关的页面。现在它们渲染一个如实说明「即将上线」的页面，
 * 并给回工作台的出口。
 */
export function PlannedView({ view }: { view: string }) {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const spec = getPlannedView(view)

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="planned-view"
      data-planned-view={view}
    >
      <Construction className="h-8 w-8 text-muted-foreground" />
      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t("wb.planned")}
      </span>
      <h1 className="text-lg font-semibold" data-testid="planned-view-title">
        {spec ? t(spec.labelKey) : view}
      </h1>
      {spec && (
        <p className="max-w-md text-sm text-muted-foreground" data-testid="planned-view-desc">
          {t(spec.descKey)}
        </p>
      )}
      <p className="max-w-md text-xs text-muted-foreground">{t("wb.plannedView.hint")}</p>
      <button
        type="button"
        onClick={() => setActiveView("workbench")}
        data-testid="planned-view-back"
        className="mt-2 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
      >
        <LayoutDashboard className="h-4 w-4" />
        {t("wb.plannedView.back")}
      </button>
    </div>
  )
}
