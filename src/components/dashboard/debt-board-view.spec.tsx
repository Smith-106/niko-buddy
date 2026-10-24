// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { DebtBoardView, getChaseDebtSpan, getForeshadowingDebtGauge, buildEmotionSparkline } from "./debt-board-view"
import type { ForeshadowingDebtReport, ChaseDebt, ChaseDebtEvent, EmotionLedgerEntry } from "@/lib/novel"

// useTranslation mock — 返回 key fallback（i18n 在 SSR 下需要 mock，
// 与 inspector-panel.spec.tsx / review-view.dismiss.spec.tsx 同款模式）。
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
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

  it("55 W1-5: 传 onSettleDebt → active 债务渲染结清/核销按钮, 点击回调携带 (debtId, status)", () => {
    const onSettleDebt = vi.fn()
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={2}
        onSettleDebt={onSettleDebt}
      />,
    )
    expect(html).toContain("settle-debt-debt-1")
    expect(html).toContain("writeoff-debt-debt-1")
    expect(html).toContain("dashboard.section.chaseDebtSettle")
    expect(html).toContain("dashboard.section.chaseDebtWriteOff")
  })

  it("55 W1-5: 点击结清/核销按钮 → onSettleDebt 携带 (debtId, status) (防空转: busy 态 + 回调契约)", async () => {
    const onSettleDebt = vi.fn()
    render(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={2}
        onSettleDebt={onSettleDebt}
      />,
    )
    fireEvent.click(screen.getByTestId("settle-debt-debt-1"))
    expect(onSettleDebt).toHaveBeenCalledWith("debt-1", "paid")
    // odyssey-ui M4: 异步结账 busy 态——等待复位后第二次点击可达（防双击重复入账）
    await waitFor(() => expect(screen.getByTestId("settle-debt-debt-1")).toBeEnabled())
    fireEvent.click(screen.getByTestId("writeoff-debt-debt-1"))
    expect(onSettleDebt).toHaveBeenCalledWith("debt-1", "written_off")
  })

  it("55 W1-5: 不传 onSettleDebt → 不渲染操作按钮 (后向兼容, 现状只读行为)", () => {
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={2}
      />,
    )
    expect(html).not.toContain("settle-debt-")
    expect(html).not.toContain("writeoff-debt-")
  })

  it("55 W1-5: paid/written_off 态债务不渲染操作按钮", () => {
    const settledDebts: ChaseDebt[] = [
      { ...sampleChaseDebts[0]!, status: "paid" },
      { ...sampleChaseDebts[1]!, status: "written_off" },
    ]
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={settledDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={2}
        onSettleDebt={vi.fn()}
      />,
    )
    expect(html).not.toContain("settle-debt-")
    expect(html).not.toContain("writeoff-debt-")
  })
})

describe("第 6 块：债务可视化（跨度条 + 堆叠条 + 双向条）", () => {
  it("getChaseDebtSpan：游标百分比/超期章数/复利倍数，零跨度不除零", () => {
    // source=1 due=5 current=4 → 游标 75%，未超期，倍数 2。
    expect(getChaseDebtSpan(1, 5, 4, 1, 2)).toEqual({ cursorPct: 75, overdueBy: 0, compoundRatio: 2 })
    // debt-2 口径：source=1 due=3 current=4 → 游标钳制 100%，超期 1 章。
    expect(getChaseDebtSpan(1, 3, 4, 2, 2)).toEqual({ cursorPct: 100, overdueBy: 1, compoundRatio: 1 })
    // due<=source 退化为 1 章槽；original<=0 倍数退化为 1。
    expect(getChaseDebtSpan(5, 5, 5, 0, 0)).toEqual({ cursorPct: 0, overdueBy: 0, compoundRatio: 1 })
  })

  it("getForeshadowingDebtGauge：三色百分比求和 100，零未回收归零", () => {
    // sampleDebtReport：total=3 critical=1 warning=2 → 其余 0。
    expect(getForeshadowingDebtGauge(3, 1, 2)).toEqual({
      criticalPct: expect.closeTo(100 / 3, 5),
      warningPct: expect.closeTo(200 / 3, 5),
      restPct: 0,
    })
    expect(getForeshadowingDebtGauge(0, 0, 0)).toEqual({ criticalPct: 0, warningPct: 0, restPct: 0 })
  })

  it("buildEmotionSparkline：多点归一化点串，空数组给空串", () => {
    const points = buildEmotionSparkline(
      [
        { chapter: 1, delta: -0.5 },
        { chapter: 3, delta: 0.5 },
      ],
      72,
      20,
    )
    expect(points).toBe("2.0,18.0 70.0,2.0")
    expect(buildEmotionSparkline([])).toBe("")
  })

  it("逐条渲染 debt-span-bar：逾期 debt-2 带赤字段与超期文案", () => {
    const html = renderToStaticMarkup(
      <DebtBoardView
        chaseDebts={sampleChaseDebts}
        chaseDebtEvents={sampleChaseDebtEvents}
        currentChapter={4}
        debtReport={null}
        emotionDebts={[]}
      />,
    )
    expect(html).toContain('data-testid="debt-span-bar-debt-1"')
    expect(html).toContain('data-testid="debt-span-bar-debt-2"')
    // debt-2 超期 1 章：赤字段 + 超期文案 + 复利 key。
    expect(html).toContain("bg-destructive/70")
    expect(html).toContain("超期1")
    expect(html).toContain("dashboard.section.chaseDebtCompound")
  })

  it("渲染 foreshadowing-debt-gauge：三色堆叠 + debtScore 水位", () => {
    const html = renderToStaticMarkup(<DebtBoardView debtReport={sampleDebtReport} />)
    expect(html).toContain('data-testid="foreshadowing-debt-gauge"')
    expect(html).toContain("critical:1 warning:2")
    expect(html).toContain("debtScore:72")
  })

  it("情绪双向条：角色 testid + VAD 胶囊 + 多点 history 才有 sparkline", () => {
    const withHistory: EmotionLedgerEntry = {
      ...sampleEmotionDebts[0]!,
      history: [
        { chapter: 5, delta: -0.4, reason: "挫败" },
        { chapter: 6, delta: 0.1, reason: "回暖" },
      ],
    }
    const html = renderToStaticMarkup(<DebtBoardView emotionDebts={[withHistory]} />)
    expect(html).toContain('data-testid="emotion-net-bar-林烬"')
    expect(html).toContain("V-0.5 A0.3 D-0.2")
    expect(html).toContain("<polyline")
    // 无 history → 无 sparkline，但双向条仍在。
    const bare = renderToStaticMarkup(<DebtBoardView emotionDebts={sampleEmotionDebts} />)
    expect(bare).toContain('data-testid="emotion-net-bar-林烬"')
    expect(bare).not.toContain("<polyline")
  })
})
