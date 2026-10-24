import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertOctagon, Coins, HeartCrack, Loader2 } from "lucide-react"
import { computeChaseDebtState, calculateEmotionNetValue } from "@/lib/novel"
import type { ChaseDebt, ChaseDebtEvent, ForeshadowingDebtReport, EmotionLedgerEntry } from "@/lib/novel"

/**
 * 债务看板（roadmap W3 / R16, TASK-302）：聚合三类债务的只读分区视图。
 *   - chase_debt 追读债务台账（additive-optional，旧 status.json 无此字段时容忍缺失）
 *   - 伏笔逾期聚合（ForeshadowingDebtReport criticalCount/warningCount/debtScore）
 *   - 情绪债务 Top-N（getTopEmotionalDebt 结果，netValue 升序，越负债务越重）
 *
 * 契约区分（对齐 novel-session-status S2b）：chase_debt = 追读力债务
 * （hook/micropayoff/coolpoint 欠账，阅读动力维度）；伏笔逾期债务走
 * foreshadowing-debt（剧情连续性债务，由 related-chapters 扫描），不混入 chase_debt。
 */

const CHASE_DEBT_TYPE_LABEL_KEYS: Record<string, string> = {
  hook_strength: "dashboard.debtType.hook_strength",
  micropayoff: "dashboard.debtType.micropayoff",
  coolpoint: "dashboard.debtType.coolpoint",
}

const CHASE_DEBT_STATUS_LABEL_KEYS: Record<string, string> = {
  active: "dashboard.debtStatus.active",
  paid: "dashboard.debtStatus.paid",
  overdue: "dashboard.debtStatus.overdue",
  written_off: "dashboard.debtStatus.written_off",
}

export interface ChaseDebtSpan {
  /** 当前章在 source→due 槽内的进度 0~100（超期钳制 100） */
  cursorPct: number
  /** 超期章数（未超期为 0） */
  overdueBy: number
  /** current/original 复利膨胀倍数（original<=0 时为 1） */
  compoundRatio: number
}

/** 追读债务跨度条纯计算：source→due 为槽，currentChapter 为游标（第 6 块可视化用）。 */
export function getChaseDebtSpan(
  sourceChapter: number,
  dueChapter: number,
  currentChapter: number,
  originalAmount: number,
  currentAmount: number,
): ChaseDebtSpan {
  const span = Math.max(dueChapter - sourceChapter, 1)
  const raw = (currentChapter - sourceChapter) / span
  const cursorPct = Math.min(Math.max(raw, 0), 1) * 100
  return {
    cursorPct,
    overdueBy: Math.max(currentChapter - dueChapter, 0),
    compoundRatio: originalAmount > 0 ? currentAmount / originalAmount : 1,
  }
}

export interface ForeshadowingDebtGauge {
  criticalPct: number
  warningPct: number
  restPct: number
}

/** 伏笔债务三色堆叠纯计算：critical / warning / 其余未回收占 totalUnresolved 百分比。 */
export function getForeshadowingDebtGauge(totalUnresolved: number, criticalCount: number, warningCount: number): ForeshadowingDebtGauge {
  if (totalUnresolved <= 0) return { criticalPct: 0, warningPct: 0, restPct: 0 }
  const criticalPct = Math.min((criticalCount / totalUnresolved) * 100, 100)
  const warningPct = Math.min((warningCount / totalUnresolved) * 100, 100 - criticalPct)
  const rawRest = Math.max(100 - criticalPct - warningPct, 0)
  return { criticalPct, warningPct, restPct: rawRest < 1e-9 ? 0 : rawRest }
}

/** 情绪 history sparkline 纯计算：chapter→x、delta→y 归一化折线点串。 */
export function buildEmotionSparkline(
  history: Array<{ chapter: number; delta: number }>,
  width = 72,
  height = 20,
): string {
  if (history.length === 0) return ""
  const chapters = history.map((h) => h.chapter)
  const deltas = history.map((h) => h.delta)
  const minC = Math.min(...chapters)
  const maxC = Math.max(...chapters)
  const minD = Math.min(...deltas)
  const maxD = Math.max(...deltas)
  const spanC = maxC - minC || 1
  const spanD = maxD - minD || 1
  return history
    .map((h) => {
      const x = ((h.chapter - minC) / spanC) * (width - 4) + 2
      const y = height - 2 - ((h.delta - minD) / spanD) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
}

export interface DebtBoardViewProps {
  /** chase_debt 追读债务台账（additive-optional，缺失时为空数组） */
  chaseDebts?: ChaseDebt[]
  /** 计息/还款事件日志（computeChaseDebtState 到期判定 + 防重复计息用） */
  chaseDebtEvents?: ChaseDebtEvent[]
  /** 当前章节号（currentChapter >= due_chapter 且未偿清 → overdue 高亮） */
  currentChapter?: number
  /** 伏笔逾期聚合报告（criticalCount/warningCount/debtScore） */
  debtReport?: ForeshadowingDebtReport | null
  /** 情绪债务 Top-N（getTopEmotionalDebt 结果，netValue 升序） */
  emotionDebts?: EmotionLedgerEntry[]
  /**
   * 55 号设计 W1-5 (54④ 收尾): 结账回调 (debtId, newStatus)。
   * optional: 缺省 → 不渲染操作按钮 (现状只读行为)。
   * 可返回 Promise（推荐）：等待期间按钮进入 busy 态防双击重复入账。
   */
  onSettleDebt?: (debtId: string, newStatus: "paid" | "written_off") => void | Promise<void>
}

export function DebtBoardView({
  chaseDebts = [],
  chaseDebtEvents = [],
  currentChapter = 0,
  debtReport = null,
  emotionDebts = [],
  onSettleDebt,
}: DebtBoardViewProps = {}) {
  const { t } = useTranslation()
  const [settling, setSettling] = useState<{ id: string; status: "paid" | "written_off" } | null>(null)

  // odyssey-ui M4：异步结账 busy 态——等待期间禁用两钮防双击重复入账
  const handleSettle = useCallback(
    async (debtId: string, status: "paid" | "written_off") => {
      if (settling) return
      setSettling({ id: debtId, status })
      try {
        await onSettleDebt?.(debtId, status)
      } finally {
        setSettling(null)
      }
    },
    [onSettleDebt, settling],
  )

  const hasChaseDebts = chaseDebts.length > 0
  const hasEmotionDebts = emotionDebts.length > 0
  const hasForeshadowingDebt = Boolean(debtReport && debtReport.totalUnresolved > 0)
  // 情绪双向条归一化分母：全员最大 |netValue|（全 0 时退化为 1，不画条只标数）。
  const emotionMaxAbs = Math.max(1e-6, ...emotionDebts.map((e) => Math.abs(calculateEmotionNetValue(e))))
  if (!hasChaseDebts && !hasEmotionDebts && !hasForeshadowingDebt) return null

  return (
    <div data-debt-board-view="true" className="border-t p-3">
      {/* 1. chase_debt 追读债务（overdue 高亮） */}
      {hasChaseDebts && (
        <div className="mb-2 rounded-md border bg-muted/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <Coins className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("dashboard.section.chaseDebt")}</h3>
          </div>
          <div className="space-y-1">
            {chaseDebts.map((debt) => {
              const computed = computeChaseDebtState(debt, currentChapter, chaseDebtEvents)
              const isOverdue = computed.status === "overdue"
              const isSettled = computed.status === "paid" || computed.status === "written_off"
              return (
                <div key={debt.id} className="rounded border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={isOverdue ? "text-destructive" : isSettled ? "text-muted-foreground" : ""}>
                      {t(CHASE_DEBT_TYPE_LABEL_KEYS[debt.debt_type] ?? debt.debt_type)}
                    </span>
                    {isOverdue && (
                      <span className="rounded bg-destructive/10 px-1 py-0.5 text-destructive">
                        {t("dashboard.debtStatus.overdue")}
                      </span>
                    )}
                    <span className="ml-auto text-muted-foreground">
                      {t(CHASE_DEBT_STATUS_LABEL_KEYS[computed.status] ?? computed.status)}
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {t("dashboard.section.chaseDebtAmount")}: {computed.current_amount.toFixed(2)} ·{" "}
                    {t("dashboard.section.chaseDebtInterest")}: {debt.interest_rate}%/章 ·{" "}
                    {t("dashboard.section.chaseDebtDue")}: 第{debt.due_chapter}
                    {t("dashboard.section.chapters")}
                  </p>
                  {/* 第 6 块：章节跨度甘特条（source→due 槽 + currentChapter 游标 + 超期赤字 + 复利条）。 */}
                  {(() => {
                    const span = getChaseDebtSpan(
                      debt.source_chapter,
                      debt.due_chapter,
                      currentChapter,
                      debt.original_amount,
                      computed.current_amount,
                    )
                    const duePct =
                      Math.min(
                        Math.max((debt.due_chapter - debt.source_chapter) / Math.max(debt.due_chapter - debt.source_chapter, 1), 0),
                        1,
                      ) * 100
                    return (
                      <div className="mt-1" data-testid={`debt-span-bar-${debt.id}`}>
                        <div className="relative h-2 overflow-hidden rounded bg-muted">
                          <div className="absolute inset-y-0 left-0 rounded-l bg-accent/60" style={{ width: `${span.cursorPct}%` }} />
                          {isOverdue && (
                            <div
                              className="absolute inset-y-0 rounded-r bg-destructive/70"
                              style={{ left: `${duePct}%`, width: `${Math.max(span.cursorPct - duePct, 0)}%` }}
                            />
                          )}
                          <div
                            className="absolute inset-y-0 w-0.5 bg-foreground"
                            style={{ left: `${span.cursorPct}%` }}
                            title={`current:${currentChapter}`}
                          />
                        </div>
                        <p className="mt-0.5 text-muted-foreground">
                          第{debt.source_chapter}→第{debt.due_chapter}
                          {t("dashboard.section.chapters")} · 当前第{currentChapter}
                          {t("dashboard.section.chapters")} · {t("dashboard.section.chaseDebtCompound")}×{span.compoundRatio.toFixed(2)}
                          {span.overdueBy > 0 && !isSettled ? ` · 超期${span.overdueBy}${t("dashboard.section.chapters")}` : ""}
                        </p>
                      </div>
                    )
                  })()}
                  {/* 55 号设计 W1-5 (54④ 收尾): 结账按钮——paid/written_off 态可达 (updateChaseDebtStatus 接线)。
                      回调缺省 → 不渲染 (现状只读行为)。 */}
                  {onSettleDebt && !isSettled && (
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        data-testid={`settle-debt-${debt.id}`}
                        onClick={() => void handleSettle(debt.id, "paid")}
                        disabled={settling?.id === debt.id}
                        className="inline-flex min-h-6 items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {settling?.id === debt.id && settling.status === "paid" && (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        )}
                        {t("dashboard.section.chaseDebtSettle")}
                      </button>
                      <button
                        type="button"
                        data-testid={`writeoff-debt-${debt.id}`}
                        onClick={() => void handleSettle(debt.id, "written_off")}
                        disabled={settling?.id === debt.id}
                        className="inline-flex min-h-6 items-center gap-1 rounded border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {settling?.id === debt.id && settling.status === "written_off" && (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        )}
                        {t("dashboard.section.chaseDebtWriteOff")}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 2. 伏笔逾期聚合（ForeshadowingDebtReport 摘要） */}
      {hasForeshadowingDebt && debtReport && (
        <div className="mb-2 rounded-md border bg-muted/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("dashboard.section.foreshadowingDebt")}</h3>
            <span className="ml-auto text-xs text-muted-foreground">
              {t("dashboard.section.debtScore")}: {debtReport.debtScore}/100
            </span>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="flex items-center gap-1 text-destructive">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
              {debtReport.criticalCount} {t("dashboard.debtLevel.critical")}
            </span>
            <span className="flex items-center gap-1 text-warning">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
              {debtReport.warningCount} {t("dashboard.debtLevel.warning")}
            </span>
          </div>
          {/* 第 6 块：伏笔风险三色堆叠条 + debtScore 压力水位槽。 */}
          {(() => {
            const gauge = getForeshadowingDebtGauge(
              debtReport.totalUnresolved,
              debtReport.criticalCount,
              debtReport.warningCount,
            )
            return (
              <div className="mt-1" data-testid="foreshadowing-debt-gauge">
                <div className="flex h-2 overflow-hidden rounded bg-muted" title={`critical:${debtReport.criticalCount} warning:${debtReport.warningCount}`}>
                  <div className="h-full bg-destructive/80" style={{ width: `${gauge.criticalPct}%` }} />
                  <div className="h-full bg-warning/80" style={{ width: `${gauge.warningPct}%` }} />
                  <div className="h-full bg-muted-foreground/40" style={{ width: `${gauge.restPct}%` }} />
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" title={`debtScore:${debtReport.debtScore}`}>
                  <div
                    className="h-full rounded bg-accent/70"
                    style={{ width: `${Math.min(Math.max(debtReport.debtScore, 0), 100)}%` }}
                  />
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* 3. 情绪债务 Top-N（calculateEmotionNetValue 净值展示） */}
      {hasEmotionDebts && (
        <div className="rounded-md border bg-muted/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <HeartCrack className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t("dashboard.section.emotionDebt")}</h3>
          </div>
          <div className="space-y-1">
            {emotionDebts.map((entry) => {
              const netValue = calculateEmotionNetValue(entry)
              const pct = Math.min((Math.abs(netValue) / emotionMaxAbs) * 50, 50)
              const points = entry.history.length >= 2 ? buildEmotionSparkline(entry.history) : ""
              return (
                <div key={entry.characterName} className="text-xs">
                  <div className="flex items-center justify-between">
                    <span>{entry.characterName}</span>
                    <span
                      className={
                        netValue < -0.3
                          ? "text-destructive"
                          : netValue > 0.3
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {t("dashboard.section.emotionNetValue")}: {netValue.toFixed(2)}
                    </span>
                  </div>
                  {/* 第 6 块：0 中轴双向条 + V/A/D 胶囊 + history sparkline。 */}
                  <div className="mt-0.5 flex items-center gap-1.5" data-testid={`emotion-net-bar-${entry.characterName}`}>
                    <div className="relative h-2 flex-1 overflow-hidden rounded bg-muted" title={`net:${netValue.toFixed(2)}`}>
                      <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/60" />
                      {netValue < 0 ? (
                        <div className="absolute inset-y-0 bg-destructive/70" style={{ right: "50%", width: `${pct}%` }} />
                      ) : netValue > 0 ? (
                        <div className="absolute inset-y-0 bg-emerald-500/70" style={{ left: "50%", width: `${pct}%` }} />
                      ) : null}
                    </div>
                    <span className="shrink-0 rounded border px-1 text-muted-foreground">
                      V{entry.valence.toFixed(1)} A{entry.arousal.toFixed(1)} D{entry.dominance.toFixed(1)}
                    </span>
                    {points ? (
                      <svg width="72" height="20" aria-hidden="true" className="shrink-0">
                        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground" />
                      </svg>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
