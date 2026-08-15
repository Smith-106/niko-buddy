import { useTranslation } from "react-i18next"
import { AlertOctagon, Coins, HeartCrack } from "lucide-react"
import { computeChaseDebtState, type ChaseDebt, type ChaseDebtEvent } from "@/lib/novel/novel-session-status"
import type { ForeshadowingDebtReport } from "@/lib/novel/foreshadowing-debt"
import { calculateEmotionNetValue, type EmotionLedgerEntry } from "@/lib/novel/emotion-ledger"

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
}

export function DebtBoardView({
  chaseDebts = [],
  chaseDebtEvents = [],
  currentChapter = 0,
  debtReport = null,
  emotionDebts = [],
}: DebtBoardViewProps = {}) {
  const { t } = useTranslation()

  const hasChaseDebts = chaseDebts.length > 0
  const hasEmotionDebts = emotionDebts.length > 0
  const hasForeshadowingDebt = Boolean(debtReport && debtReport.totalUnresolved > 0)
  if (!hasChaseDebts && !hasEmotionDebts && !hasForeshadowingDebt) return null

  return (
    <div data-debt-board-view="true" className="border-t p-3">
      {/* 1. chase_debt 追读债务（overdue 高亮） */}
      {hasChaseDebts && (
        <div className="mb-2 rounded-md border bg-muted/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <Coins className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t("dashboard.section.chaseDebt")}</span>
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
            <span className="text-sm font-medium">{t("dashboard.section.foreshadowingDebt")}</span>
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
        </div>
      )}

      {/* 3. 情绪债务 Top-N（calculateEmotionNetValue 净值展示） */}
      {hasEmotionDebts && (
        <div className="rounded-md border bg-muted/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <HeartCrack className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t("dashboard.section.emotionDebt")}</span>
          </div>
          <div className="space-y-1">
            {emotionDebts.map((entry) => {
              const netValue = calculateEmotionNetValue(entry)
              return (
                <div key={entry.characterName} className="flex items-center justify-between text-xs">
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
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
