// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChapterPlanView, ParticlePlanItem, PlanDimensionSlice, StateDeltaPlanItem } from "@/lib/novel"

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
  Unresolved: "bg-kind-purple/10 text-kind-purple dark:text-kind-purple",
}

/**
 * P2-IMP-11 四新维共用渲染块（受控纯展示）。
 * 逐维 topN + 字符预算封顶已在 buildChapterPlanView 完成，
 * 本组件只展示封顶后的 items（degraded / 空态 / 截断标记均可见）。
 */
function DimensionSection<TItem>({
  title,
  slice,
  emptyText,
  renderItem,
}: {
  title: string
  slice: PlanDimensionSlice<TItem> | undefined
  emptyText: string
  renderItem: (item: TItem) => string
}) {
  const { t } = useTranslation()
  // ISS-20260712-017 长列表虚拟化（轻量窗口化）：超过 20 项时首屏仅渲染前 20，
  // 其余按需展开，避免一次性挂载数百节点；短列表行为不变，文案语义不变。
  const [expanded, setExpanded] = useState(false)
  if (!slice) return null
  const VIRTUALIZE_THRESHOLD = 20
  const needsVirtualization = slice.items.length > VIRTUALIZE_THRESHOLD
  const visibleItems = needsVirtualization && !expanded ? slice.items.slice(0, VIRTUALIZE_THRESHOLD) : slice.items
  return (
    <section>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {slice.status === "degraded" ? (
        <p className="text-xs text-warning">
          {t("novel.planning.degraded", { defaultValue: "数据源不可用" })}
          {slice.reason ? `（${slice.reason}）` : ""}
        </p>
      ) : slice.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <ul className="max-h-64 space-y-1 overflow-y-auto [content-visibility:auto]" data-testid="planning-virtual-list">
            {visibleItems.map((item, index) => (
              <li key={`${renderItem(item).slice(0, 48)}-${index}`} className="truncate">
                {renderItem(item)}
              </li>
            ))}
          </ul>
          {needsVirtualization && !expanded && (
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
            >
              {t("novel.planning.showMore", { defaultValue: `展开其余 ${slice.items.length - VIRTUALIZE_THRESHOLD} 项` })}
            </button>
          )}
          {slice.truncated && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("novel.planning.dimensionTruncated", { defaultValue: "已按逐维预算截断" })}
            </p>
          )}
        </>
      )}
    </section>
  )
}

export function PlanningPanel({ plan, loading, error, onRefresh, onStartWriting, onClose }: PlanningPanelProps) {
  const { t } = useTranslation()

  return (
    // ISS-20260712-017 响应式断点：窄屏单列、sm 起双列信息密度，容器查询与视口断点并存
    <div className="rounded-lg border bg-background p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {t("novel.planning.title", { defaultValue: "本章确定性范围" })}
        </h3>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh} aria-label={t("novel.planning.refresh", { defaultValue: "刷新" })}>
            <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label={t("novel.planning.close", { defaultValue: "关闭" })}>
            <X className="h-3.5 w-3.5 shrink-0" />
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
        <div className="grid gap-3 text-sm sm:grid-cols-2">
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
                  <li key={item.name} className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${DEBT_LEVEL_STYLES[item.debtLevel] ?? DEBT_LEVEL_STYLES.normal}`}>
                      {item.debtLevel}
                    </span>
                    <span className="min-w-0 truncate">{item.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t("novel.planning.chaptersSince", { defaultValue: "已 {{n}} 章未推进", n: item.chaptersSincePlanted })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.emptyForeshadow", { defaultValue: "无未回收伏笔" })}</p>
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
                  <li key={c.name} className="flex items-center gap-2 min-w-0">
                    <span className="min-w-0 truncate">{c.name}</span>
                    {c.inCurrentOutline && (
                      <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">
                        {t("novel.planning.inOutline", { defaultValue: "本章出场" })}
                      </span>
                    )}
                    {c.isAlive === false && (
                      <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                        {t("novel.planning.dead", { defaultValue: "已退场" })}
                      </span>
                    )}
                    {c.chaptersSinceSeen !== undefined && c.chaptersSinceSeen >= 10 && !c.inCurrentOutline && (
                      <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                        {t("novel.planning.dormant", { defaultValue: "已 {{n}} 章未出场", n: c.chaptersSinceSeen })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.emptyCharacters", { defaultValue: "无角色数据" })}</p>
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
                  <li key={thread.title} className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${ARC_STATE_STYLES[thread.arcState] ?? ARC_STATE_STYLES.Setup}`}>
                      {thread.arcState}
                    </span>
                    <span className="min-w-0 truncate">{thread.title}</span>
                    {thread.transitionViolation && (
                      <span className="ml-auto shrink-0 text-xs text-destructive">{thread.transitionViolation}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("novel.planning.emptySubplots", { defaultValue: "无支线数据" })}</p>
            )}
          </section>

          {/* P2-IMP-11 四新维：认知盲区 / 近章状态变更 / 见面边界 / 粒子持有 */}
          <DimensionSection
            title={t("novel.planning.cognition", { defaultValue: "认知盲区" }) + (plan.povCharacter ? `（视角：${plan.povCharacter}）` : "")}
            slice={plan.cognition}
            emptyText={t("novel.planning.cognitionEmpty", { defaultValue: "无认知盲区记录" })}
            renderItem={(fact) => `不知道：${fact}`}
          />
          <DimensionSection
            title={t("novel.planning.stateDeltas", { defaultValue: "近章状态变更" })}
            slice={plan.recentStateDeltas}
            emptyText={t("novel.planning.stateDeltasEmpty", { defaultValue: "近章无状态变更" })}
            renderItem={(d: StateDeltaPlanItem) => `第${d.chapter}章 [${d.kind}] ${d.entity}：${d.change}`}
          />
          <DimensionSection
            title={t("novel.planning.encounter", { defaultValue: "见面边界" }) + (plan.povCharacter ? `（视角：${plan.povCharacter}）` : "")}
            slice={plan.encounter}
            emptyText={t("novel.planning.encounterEmpty", { defaultValue: "无已见面记录" })}
            renderItem={(name) => `已见过：${name}`}
          />
          <DimensionSection
            title={t("novel.planning.particles", { defaultValue: "粒子持有" }) + (plan.povCharacter ? `（视角：${plan.povCharacter}）` : "")}
            slice={plan.particles}
            emptyText={t("novel.planning.particlesEmpty", { defaultValue: "无粒子账本" })}
            renderItem={(p: ParticlePlanItem) => `${p.kind}：${p.name} → ${p.state}`}
          />

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
              <Play className="mr-1 h-3.5 w-3.5 shrink-0" />
              {t("novel.planning.startWriting", { defaultValue: "以此计划开写" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
