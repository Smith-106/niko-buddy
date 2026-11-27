// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * 主控顶部自治启动条（Campaign 长程战役 + Incubator 冷启动孵化）。
 *
 * 设计约束：
 * - 纯 UI 编排层：复用现有 CampaignDashboardDialog 与 AutonomousIncubatorDialog，
 *   不新增第二份持久化状态、不触碰 Draft-first 安全边界；
 * - 订阅纯内存 `useMainControlRuntimeStore.pendingLaunchDialog`，使 Ctrl+K 命令面板
 *   可在切换至 mainControl 视图后一步直达对应自治弹窗；
 * - 未打开项目（`project === null`）时按钮干净禁用并丢弃待打开请求，避免无效交互。
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Flame, Wand2 } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { useMainControlRuntimeStore } from "@/stores/main-control-runtime-store"
import { cn } from "@/lib/utils"
import { CampaignDashboardDialog } from "./campaign-dashboard-dialog"
import { AutonomousIncubatorDialog } from "./autonomous-incubator-dialog"

export function MainControlAutonomyBar() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const pendingLaunchDialog = useMainControlRuntimeStore((s) => s.pendingLaunchDialog)
  const [campaignOpen, setCampaignOpen] = useState(false)
  const [incubatorOpen, setIncubatorOpen] = useState(false)

  const disabled = project === null

  useEffect(() => {
    if (!pendingLaunchDialog) return
    const next = useMainControlRuntimeStore.getState().consumePendingLaunchDialog()
    if (disabled || !next) return
    if (next === "campaign") {
      setCampaignOpen(true)
    } else if (next === "incubator") {
      setIncubatorOpen(true)
    }
  }, [pendingLaunchDialog, disabled])

  useEffect(() => {
    if (disabled) {
      setCampaignOpen(false)
      setIncubatorOpen(false)
    }
  }, [disabled])

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="main-control-autonomy-bar"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setCampaignOpen(true)}
        title={disabled ? t("mainControl.noProject") : t("mainControl.launchCampaignHint")}
        data-testid="main-control-launch-campaign"
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled
            ? "cursor-not-allowed text-muted-foreground opacity-50"
            : "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10",
        )}
      >
        <Flame className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("mainControl.launchCampaign")}</span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIncubatorOpen(true)}
        title={disabled ? t("mainControl.noProject") : t("mainControl.launchIncubatorHint")}
        data-testid="main-control-launch-incubator"
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled
            ? "cursor-not-allowed text-muted-foreground opacity-50"
            : "border-border bg-background text-foreground hover:bg-accent",
        )}
      >
        <Wand2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("mainControl.launchIncubator")}</span>
      </button>
      <CampaignDashboardDialog open={campaignOpen} onOpenChange={setCampaignOpen} />
      <AutonomousIncubatorDialog open={incubatorOpen} onOpenChange={setIncubatorOpen} />
    </div>
  )
}
