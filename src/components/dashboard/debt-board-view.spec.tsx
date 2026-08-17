import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DebtBoardView } from "./debt-board-view"
import type { ForeshadowingDebtReport } from "@/lib/novel/foreshadowing-debt"
import type { ChaseDebt, ChaseDebtEvent } from "@/lib/novel/novel-session-status"
import type { EmotionLedgerEntry } from "@/lib/novel/emotion-ledger"

// useTranslation mock — 返回 key fallback（i18n 在 SSR 下需要 mock，
// 与 inspector-panel.spec.tsx / review-view.dismiss.spec.tsx 同款模式）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const sampleChaseDebts: ChaseDebt[] = [
  {
    id: "debt-1",
    debt_type: "micropayoff",
    original_amount: 1,
    current_amount: 1,
    interest_rate: 0.1,
    source_chapter: 1,
    due_chapter: 5,
    status: "active",
    ref: "metric:micropayoff:ch1",
  },
  {
    id: "debt-2",
    debt_type: "hook_strength",
    original_amount: 2,
    current_amount: 2,
    interest_rate: 0.1,
    source_chapter: 1,
    due_chapter: 3,
    status: "active",
  },
]

const sampleChaseDebtEvents: ChaseDebtEvent[] = []

const sampleDebtReport: ForeshadowingDebtReport = {
  items: [],
  totalUnresolved: 3,
  criticalCount: 1,
  warningCount: 2,
  debtScore: 72,
  thresholds: { plantedStale: 5, advancedStale: 10, densityLimit: 5 },
}

const sampleEmotionDebts: EmotionLedgerEntry[] = [
  {
    characterName: "林烬",
    valence: -0.5,
    arousal: 0.3,
    dominance: -0.2,
    // 存储 netValue 可能与机械层重算不一致 — 视图用 calculateEmotionNetValue 重算展示。
    netValue: -0.7,
    lastUpdatedChapter: 6,
    history: [],
  },
]

describe("W3 / R16 / TASK-302: DebtBoardView 债务看板", () => {
  it("settled and unknown chase debt states use muted/fallback labels", () => {
    const paid: ChaseDebt = {
      ...sampleChaseDebts[0],
      id: "paid-debt",
      status: "paid",
      debt_type: "coolpoint",
      current_amount: 0,
    }
    const writtenOff: ChaseDebt = {
      ...sampleChaseDebts[0],
      id: "written-off-debt",
      status: "written_off",
      debt_type: "unknown-type",
    }
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={[paid, writtenOff]}
        currentChapter={9}
        emotionDebts={[]}
      />,
    )
    expect(html).toContain("dashboard.debtType.coolpoint")
    expect(html).toContain("dashboard.debtStatus.paid")
    expect(html).toContain("dashboard.debtStatus.written_off")
    expect(html).toContain("unknown-type")
    expect(html).toContain("text-muted-foreground")
  })

  it("unknown computed status uses raw status fallback label", () => {
    const unknownStatus = {
      ...sampleChaseDebts[0],
      id: "unknown-status",
      status: "mystery",
    } as unknown as ChaseDebt
    const html = renderToStaticMarkup(<DebtBoardView chaseDebts={[unknownStatus]} />)
    expect(html).toContain("mystery")
  })

  it("emotion debt tone branches cover negative, positive and neutral net values", () => {
    const negative: EmotionLedgerEntry = {
      characterName: "负向",
      valence: -1,
      arousal: 1,
      dominance: -1,
      netValue: -1,
      lastUpdatedChapter: 1,
      history: [],
    }
    const positive: EmotionLedgerEntry = {
      characterName: "正向",
      valence: 1,
      arousal: 1,
      dominance: 1,
      netValue: 1,
      lastUpdatedChapter: 1,
      history: [],
    }
    const neutral: EmotionLedgerEntry = {
      characterName: "中性",
      valence: 0,
      arousal: 0,
      dominance: 0,
      netValue: 0,
      lastUpdatedChapter: 1,
      history: [],
    }
    const html = renderToStaticMarkup(<DebtBoardView emotionDebts={[negative, positive, neutral]} />)
    expect(html).toContain("负向")
    expect(html).toContain("正向")
    expect(html).toContain("中性")
    expect(html).toContain("text-destructive")
    expect(html).toContain("text-foreground")
    expect(html).toContain("text-muted-foreground")
  })

  it("chase debt repayment can settle amount to zero before due chapter", () => {
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={[sampleChaseDebts[0]]}
        chaseDebtEvents={[{
          debt_id: "debt-1",
          event_type: "full_payment",
          amount: 1,
          chapter: 2,
        }]}
        currentChapter={2}
      />,
    )
    expect(html).toContain("dashboard.debtStatus.active")
    expect(html).not.toContain("dashboard.debtStatus.overdue")
  })

  it("渲染组件根标记与三类分区标题（[UI-observable]）", () => {
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={4}
        debtReport={sampleDebtReport}
        emotionDebts={sampleEmotionDebts}
      />,
    )
    expect(html).toContain('data-debt-board-view="true"')
    expect(html).toContain("dashboard.section.chaseDebt")
    expect(html).toContain("dashboard.section.foreshadowingDebt")
    expect(html).toContain("dashboard.section.emotionDebt")
  })

  it("chase_debt 分区渲染字段 + computeChaseDebtState overdue 高亮", () => {
    // debt-2 due_chapter=3, currentChapter=4 → 到期未偿清 → overdue 高亮。
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={4}
        debtReport={null}
        emotionDebts={[]}
      />,
    )
    expect(html).toContain("dashboard.debtType.micropayoff")
    expect(html).toContain("dashboard.debtType.hook_strength")
    expect(html).toContain("dashboard.debtStatus.overdue")
    expect(html).toContain("dashboard.debtStatus.active")
    expect(html).toContain("dashboard.section.chaseDebtAmount")
    expect(html).toContain("dashboard.section.chaseDebtInterest")
    expect(html).toContain("dashboard.section.chaseDebtDue")
  })

  it("伏笔逾期聚合分区渲染 criticalCount/warningCount/debtScore", () => {
    const html = renderToStaticMarkup(<DebtBoardView debtReport={sampleDebtReport} />)
    expect(html).toContain("dashboard.section.debtScore")
    expect(html).toContain("72")
    expect(html).toContain("dashboard.debtLevel.critical")
    expect(html).toContain("dashboard.debtLevel.warning")
  })

  it("情绪债务分区渲染角色名与机械层净值（calculateEmotionNetValue）", () => {
    // calculateEmotionNetValue = -0.5*0.4 + 0.3*0.3 + (-0.2)*0.3 + history(0) = -0.17
    const html = renderToStaticMarkup(<DebtBoardView emotionDebts={sampleEmotionDebts} />)
    expect(html).toContain("林烬")
    expect(html).toContain("dashboard.section.emotionNetValue")
    expect(html).toContain("-0.17")
  })

  it("三类数据全空时（含 chase_debt 缺失）不渲染", () => {
    const html = renderToStaticMarkup(<DebtBoardView />)
    expect(html).toBe("")
  })
})
