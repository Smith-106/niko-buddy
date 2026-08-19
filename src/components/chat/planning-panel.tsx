// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"
import { RefreshCw, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChapterPlanView } from "@/lib/novel/planning"

/**
 * Wave 3 计划模式 — 计划面板（受控纯展示组件）。
 *
 * 零 store 访问、零 IO：数据由父级（chat-panel）获取后注入。
 * 三类数据只读展示（伏笔债务 / 角色出场 / 支线推进），逐维 degraded 可见标记。
 */

export interface PlanningPanelProps {
  plan: ChapterPlanView | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onStartWriting: (plan: ChapterPlanView) => void
  onClose: () => void
}

const DEBT_LEVEL_STYLES: Record<string, string> = {
  critical: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  normal: "bg-muted text-muted-foreground",
}

const ARC_STATE_STYLES: Record<string, string> = {
  Falling: "bg-warning/10 text-warning",
  Climax: "bg-accent/10 text-accent",
  Rising: "bg-accent/10 text-accent",
  Setup: "bg-muted text-muted-foreground",
  Resolved: "bg-success/10 text-success",
  Unresolved: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
}

export function PlanningPanel({ plan, loading, error, onRefresh, onStartWriting, onClose }: PlanningPanelProps) {
  const { t } = useTranslation()

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {t("novel.planning.title", { defaultValue: "本章确定性范围" })}
        </h3>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh} aria-label={t("novel.planning.refresh", { defaultValue: "刷新" })}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t("novel.planning.close", { defaultValue: "关闭" })}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : plan ? (
        <div className="space-y-3 text-sm">
          {/* 伏笔债务 */}
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {t("novel.planning.foreshadowing", { defaultValue: "伏笔债务" })}
            </h4>
            {plan.foreshadowing.status === "degraded" ? (
              <p className="text-xs text-warning">{t("novel.planning.degraded", { defaultValue: "数据源不可用" })}</p>
            ) : plan.foreshadowing.report && plan.foreshadowing.report.items.length > 0 ? (
              <ul className="space-y-1">
                {plan.foreshadowing.report.items.slice(0, 5).map((item) => (
                  <li key={item.name} className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${DEBT_LEVEL_STYLES[item.debtLevel] ?? DEBT_LEVEL_STYLES.normal}`}>
                      {item.debtLevel}
                    </span>
                    <span className="truncate">{item.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t("novel.planning.chaptersSince", { defaultValue: "已 {{n}} 章未推进", n: item.chaptersSincePlanted })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.empty", { defaultValue: "无未回收伏笔" })}</p>
            )}
          </section>

          {/* 角色出场 */}
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {t("novel.planning.characters", { defaultValue: "角色出场" })}
            </h4>
            {plan.characters.status === "degraded" ? (
              <p className="text-xs text-warning">{t("novel.planning.degraded", { defaultValue: "数据源不可用" })}</p>
            ) : plan.characters.items.length > 0 ? (
              <ul className="space-y-1">
                {plan.characters.items.slice(0, 6).map((c) => (
                  <li key={c.name} className="flex items-center gap-2">
                    <span className="truncate">{c.name}</span>
                    {c.inCurrentOutline && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                        {t("novel.planning.inOutline", { defaultValue: "本章出场" })}
                      </span>
                    )}
                    {c.isAlive === false && (
                      <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                        {t("novel.planning.dead", { defaultValue: "已退场" })}
                      </span>
                    )}
                    {c.chaptersSinceSeen !== undefined && c.chaptersSinceSeen >= 10 && !c.inCurrentOutline && (
                      <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                        {t("novel.planning.dormant", { defaultValue: "已 {{n}} 章未出场", n: c.chaptersSinceSeen })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.empty", { defaultValue: "无角色数据" })}</p>
            )}
          </section>

          {/* 支线推进 */}
          <section>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {t("novel.planning.threads", { defaultValue: "支线推进" })}
            </h4>
            {plan.threads.status === "degraded" ? (
              <p className="text-xs text-warning">{t("novel.planning.degraded", { defaultValue: "数据源不可用" })}</p>
            ) : plan.threads.items.length > 0 ? (
              <ul className="space-y-1">
                {plan.threads.items.slice(0, 5).map((thread) => (
                  <li key={thread.title} className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${ARC_STATE_STYLES[thread.arcState] ?? ARC_STATE_STYLES.Setup}`}>
                      {thread.arcState}
                    </span>
                    <span className="truncate">{thread.title}</span>
                    {thread.transitionViolation && (
                      <span className="ml-auto shrink-0 text-xs text-destructive">{thread.transitionViolation}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.empty", { defaultValue: "无支线数据" })}</p>
            )}
          </section>

          <div className="flex items-center justify-between border-t pt-2">
            <p className="text-xs text-muted-foreground">
              {t("novel.planning.summary", {
                defaultValue: "债务 {{debt}} · 开放支线 {{threads}} · 逾期角色 {{due}}",
                debt: plan.summary.debtScore,
                threads: plan.summary.openThreads,
                due: plan.summary.charactersDue,
              })}
            </p>
            <Button type="button" size="sm" onClick={() => onStartWriting(plan)}>
              <Play className="mr-1 h-3.5 w-3.5" />
              {t("novel.planning.startWriting", { defaultValue: "以此计划开写" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
