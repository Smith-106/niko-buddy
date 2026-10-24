/**
 * thrill-dashboard.tsx — F-07 爽点仪表盘
 *
 * 使用 ECharts（React.lazy 懒加载）展示：
 *   - tension raw/smoothed 双列曲线
 *   - beat 强度柱状图
 *   - 六维雷达图
 *   - 张弛比（open/closed 比例）
 * 使用 @tanstack/react-table 展示量化 hit 表格。
 *
 * 数据源：只读消费 T27 thrill-quantifier 纯算术输出，不修改上游模块。
 * 分组：与 review-center-view 子面板 tab 集成，不新增 activeView。
 */
import { Component, useMemo, useState, Suspense, lazy, useId, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
// @tanstack/react-table v9 API 不兼容 v8 行/列模型，此处使用原生 HTML 表格
import { BarChart3, RefreshCw } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import type { ThrillQuantifierResult, TensionSample, QuantifiedHit, SixReviewDimensionKey } from "@/lib/novel"

// 懒加载 ECharts 图表组件——首次渲染 thrill-dashboard 时才加载 echarts bundle
const ThrillECharts = lazy(() =>
  import("./thrill-echarts").then((m) => ({
    default: function ThrillEChartsWrapper(props: {
      tensionCurve: readonly TensionSample[]
      hits: readonly QuantifiedHit[]
      sixDimScores?: Partial<Record<SixReviewDimensionKey, number>>
    }) {
      return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-card p-2">
            <div className="mb-1 px-1 text-sm font-semibold text-foreground" title="Raw=该位置爽点原始叠加强度；Smoothed=滑动平均后的阅读体感节奏；取值 0–1">
              张力曲线（Raw 原始叠加 / Smoothed 阅读体感，0–1）
            </div>
            <m.TensionCurveChart tensionCurve={props.tensionCurve} />
          </div>
          <div className="rounded-lg border bg-card p-2">
            <div className="mb-1 px-1 text-sm font-semibold text-foreground" title="加权强度 = 原始强度 × 闭环权重，>1 为高光">
              Beat 强度（绿=已闭环疏解 / 黄=开放延宕；数值=加权强度）
            </div>
            <m.BeatIntensityChart hits={props.hits} />
          </div>
          {props.sixDimScores && (
            <div className="rounded-lg border bg-card p-2 md:col-span-2">
              <div className="mb-1 px-1 text-sm font-semibold text-foreground" title="六维评分 0–10 分，越高越好">
                六维雷达（0–10 分，越高越好）
              </div>
              <div className="mx-auto max-w-sm">
                <m.SixDimRadarChart scores={props.sixDimScores} />
              </div>
            </div>
          )}
        </div>
      )
    },
  })),
)

// ============================================================================
// 张弛比指标
// ============================================================================

interface TensionRelaxRatioProps {
  hits: readonly QuantifiedHit[]
}

function TensionRelaxRatio({ hits }: TensionRelaxRatioProps) {
  const { t } = useTranslation()
  const stats = useMemo(() => {
    if (!hits || hits.length === 0) return null
    const open = hits.filter((h) => h.closureState === "open").length
    const closed = hits.filter((h) => h.closureState === "closed").length
    const total = hits.length
    const ratio = closed > 0 ? (open / closed) : open > 0 ? Infinity : 0
    const avgWeighted =
      hits.reduce((sum, h) => sum + h.weightedIntensity, 0) / hits.length
    return { open, closed, total, ratio, avgWeighted }
  }, [hits])

  if (!stats) return null

  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3 sm:grid-cols-4">
      <div className="text-center" title="爽点总数 = 已闭环 + 开放">
        <div className="text-xl font-extrabold tabular-nums text-foreground">{stats.total}</div>
        <div className="text-xs text-muted-foreground">{t("craft.thrillDashboard.totalPayoffs")}</div>
      </div>
      <div className="text-center" title="开放 = 延宕未疏解的爽点">
        <div className="text-xl font-extrabold tabular-nums text-warning">{stats.open}</div>
        <div className="text-xs text-muted-foreground">{t("craft.thrillDashboard.open")}</div>
      </div>
      <div className="text-center" title="已闭环 = 已疏解的爽点">
        <div className="text-xl font-extrabold tabular-nums text-success">{stats.closed}</div>
        <div className="text-xs text-muted-foreground">{t("craft.thrillDashboard.closed")}</div>
      </div>
      <div className="text-center" title="张弛比 = 开放 / 已闭环；>3 偏紧，>1.5 偏悬念，≤1.5 偏舒缓">
        <div className={`text-xl font-extrabold tabular-nums ${stats.ratio > 3 ? "text-destructive" : stats.ratio > 1.5 ? "text-warning" : "text-success"}`}>
          {stats.ratio === Infinity ? "∞" : stats.ratio.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">{t("craft.thrillDashboard.tensionRatio")}</div>
      </div>
    </div>
  )
}

// ============================================================================
// 数据表格（@tanstack/react-table）
// ============================================================================

interface HitsTableProps {
  hits: readonly QuantifiedHit[]
}

/** 简易 HTML 表格（@tanstack/react-table v9 API 不兼容 v8 行模型，改用原生表） */
function HitsTable({ hits }: HitsTableProps) {
  const { t } = useTranslation()
  if (!hits || hits.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
        暂无量化数据
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-xs" role="grid">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground">{t("craft.thrillDashboard.beatType")}</th>
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground" title="原始强度：该 beat 自身强度">{t("craft.thrillDashboard.rawIntensity")}</th>
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground" title="加权强度 = 原始强度 × 闭环权重，>1 为高光">{t("craft.thrillDashboard.weightedIntensity")}</th>
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground" title="该 beat 在全书中的相对位置">{t("craft.thrillDashboard.position")}</th>
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground">{t("craft.thrillDashboard.closeLoop")}</th>
            <th className="px-2.5 py-2 text-left text-xs font-medium text-muted-foreground">{t("craft.thrillDashboard.arcId")}</th>
          </tr>
        </thead>
        <tbody>
          {[...hits].map((h, idx) => (
            <tr key={idx} className="border-b border-border/50 last:border-0 hover:bg-muted/10">
              <td className="px-2.5 py-1.5">
                <span className="text-xs font-medium text-foreground">{h.beatType}</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">{h.rawIntensity.toFixed(3)}</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className={`text-xs font-medium ${h.weightedIntensity > 1 ? "text-warning" : "text-foreground"}`}>
                  {h.weightedIntensity.toFixed(3)}
                </span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">{(h.positionRatio * 100).toFixed(1)}%</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                  h.closureState === "closed"
                    ? "bg-success/10 text-success"
                    : "bg-warning/10 text-warning"
                }`}>
                  {h.closureState === "closed" ? "已闭环" : "开放"}
                </span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">{h.arcId || "—"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============================================================================
// Props
// ============================================================================

export interface ThrillDashboardProps {
  /** 爽点量化结果（T27 thrill-quantifier 输出）。缺省时显示空状态。 */
  result?: ThrillQuantifierResult | null
  /** 六维评分（可选，来自 review run 的六维评分）。 */
  sixDimScores?: Partial<Record<SixReviewDimensionKey, number>>
  /** 章节标题（可选） */
  chapterTitle?: string
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * 图表加载/渲染失败的错误边界。
 *
 * `React.lazy` 导入失败（例如 echarts 未安装）是 render 期抛错，`Suspense` 只能接住
 * pending、接不住错误；旧实现只声明了 `const [echartsError] = useState(false)`（无 setter），
 * 下方「图表加载失败」分支实际上是死代码，失败时用户只会看到一个空白区域。
 */
class ChartErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error("[ThrillDashboard] 图表渲染失败:", error)
    this.props.onError()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export function ThrillDashboard({ result, sixDimScores, chapterTitle }: ThrillDashboardProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const [echartsError, setEchartsError] = useState(false)

  if (!result) {
    const goWrite = () => useWikiStore.getState().setActiveView("wiki")
    const goImport = () => useWikiStore.getState().setActiveView("bookAnalysis")
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BarChart3 className="mb-1 h-8 w-8 opacity-40" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{t("craft.thrillDashboard.noData", "暂无爽点量化数据，请先运行爽点量化")}</p>
        <p className="text-xs text-muted-foreground">先写出第一章正文或导入拆书，再回来生成张力曲线与爽点明细。</p>
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={goWrite} className="rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent/40">去写第一章</button>
          <button type="button" onClick={goImport} className="rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent/40">导入拆书</button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" role="region" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        {chapterTitle
          ? t("craft.thrillDashboard.titleWithChapter", { title: chapterTitle, defaultValue: `爽点仪表盘 — ${chapterTitle}` })
          : t("craft.thrillDashboard.title", "爽点仪表盘")}
      </h3>

      {/* 张弛比指标卡片 */}
      <TensionRelaxRatio hits={result.hits} />

      {/* ECharts 图表（懒加载，带 Suspense fallback 和错误兜底） */}
      {!echartsError ? (
        <ChartErrorBoundary onError={() => setEchartsError(true)}>
          <Suspense
            fallback={
              <div className="flex h-48 items-center justify-center rounded-lg border bg-card">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            }
          >
            <ThrillECharts
              tensionCurve={result.tensionCurve}
              hits={result.hits}
              sixDimScores={sixDimScores}
            />
          </Suspense>
        </ChartErrorBoundary>
      ) : (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {t("craft.thrillDashboard.chartFailed", "图表加载失败，请确认 echarts 依赖已安装")}
        </div>
      )}

      {/* 量化表格 */}
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          爽点量化明细 ({result.hits.length} 条)
        </div>
        <HitsTable hits={result.hits} />
      </div>
    </div>
  )
}