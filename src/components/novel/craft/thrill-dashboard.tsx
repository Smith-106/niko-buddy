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
import { useMemo, useState, Suspense, lazy, useId } from "react"
import { useTranslation } from "react-i18next"
// @tanstack/react-table v9 API 不兼容 v8 行/列模型，此处使用原生 HTML 表格
import { BarChart3, RefreshCw } from "lucide-react"
import type { ThrillQuantifierResult, TensionSample, QuantifiedHit } from "@/lib/novel/craft/thrill-quantifier"
import type { SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"

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
            <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">
              张力曲线 (Raw / Smoothed)
            </div>
            <m.TensionCurveChart tensionCurve={props.tensionCurve} />
          </div>
          <div className="rounded-lg border bg-card p-2">
            <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">
              Beat 强度 (绿=已闭环, 黄=开放)
            </div>
            <m.BeatIntensityChart hits={props.hits} />
          </div>
          {props.sixDimScores && (
            <div className="rounded-lg border bg-card p-2 md:col-span-2">
              <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">
                六维雷达
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
      <div className="text-center">
        <div className="text-lg font-bold text-foreground">{stats.total}</div>
        <div className="text-[10px] text-muted-foreground">爽点总数</div>
      </div>
      <div className="text-center">
        <div className="text-lg font-bold text-amber-500">{stats.open}</div>
        <div className="text-[10px] text-muted-foreground">开放 (延宕)</div>
      </div>
      <div className="text-center">
        <div className="text-lg font-bold text-green-500">{stats.closed}</div>
        <div className="text-[10px] text-muted-foreground">已闭环 (疏解)</div>
      </div>
      <div className="text-center">
        <div className={`text-lg font-bold ${stats.ratio > 3 ? "text-destructive" : stats.ratio > 1.5 ? "text-amber-500" : "text-green-500"}`}>
          {stats.ratio === Infinity ? "∞" : stats.ratio.toFixed(2)}
        </div>
        <div className="text-[10px] text-muted-foreground">张弛比 (open/closed)</div>
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
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">Beat 类型</th>
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">原始强度</th>
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">加权强度</th>
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">位置 (%)</th>
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">闭环</th>
            <th className="px-2.5 py-2 text-left text-[11px] font-medium text-muted-foreground">弧光 ID</th>
          </tr>
        </thead>
        <tbody>
          {[...hits].map((h, idx) => (
            <tr key={idx} className="border-b border-border/50 last:border-0 hover:bg-muted/10">
              <td className="px-2.5 py-1.5">
                <span className="text-[11px] font-medium text-foreground">{h.beatType}</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground">{h.rawIntensity.toFixed(3)}</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className={`text-[11px] font-medium ${h.weightedIntensity > 1 ? "text-amber-500" : "text-foreground"}`}>
                  {h.weightedIntensity.toFixed(3)}
                </span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground">{(h.positionRatio * 100).toFixed(1)}%</span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  h.closureState === "closed"
                    ? "bg-green-500/10 text-green-600"
                    : "bg-amber-500/10 text-amber-600"
                }`}>
                  {h.closureState === "closed" ? "已闭环" : "开放"}
                </span>
              </td>
              <td className="px-2.5 py-1.5">
                <span className="text-[11px] text-muted-foreground">{h.arcId || "—"}</span>
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

export function ThrillDashboard({ result, sixDimScores, chapterTitle }: ThrillDashboardProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const [echartsError] = useState(false)

  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <BarChart3 className="mb-2 h-8 w-8 opacity-40" aria-hidden="true" />
        <p>{t("craft.thrillDashboard.noData", "暂无爽点量化数据，请先运行爽点量化")}</p>
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
      ) : (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          图表加载失败，请确认 echarts 依赖已安装
        </div>
      )}

      {/* 量化表格 */}
      <div>
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">
          爽点量化明细 ({result.hits.length} 条)
        </div>
        <HitsTable hits={result.hits} />
      </div>
    </div>
  )
}