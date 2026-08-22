/**
 * thrill-echarts.tsx — F-07 爽点仪表盘 ECharts 图表组件（懒加载目标）
 *
 * 包含：
 *   - TensionRawSmoothedChart: 张力曲线 raw/smoothed 双列
 *   - BeatIntensityChart: beat 强度柱状图
 *   - SixDimRadarChart: 六维雷达图
 *
 * 本模块由 thrill-dashboard 通过 React.lazy 动态 import，控制 echarts bundle
 * 分离（~1.1MB gzip 前），仅在 dashboard 首次渲染时加载。
 */
import { useRef, useEffect, useMemo, useId } from "react"
import * as echarts from "echarts"
import type { TensionSample, QuantifiedHit } from "@/lib/novel/craft/thrill-quantifier"
import type { SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"

// ============================================================================
// 辅助：初始化/销毁 ECharts 实例
// ============================================================================

function useECharts(
  containerRef: React.RefObject<HTMLDivElement | null>,
  option: echarts.EChartsOption | null,
) {
  const instanceRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    if (!instanceRef.current) {
      instanceRef.current = echarts.init(containerRef.current, undefined, { renderer: "canvas" })
    }
    if (option) {
      instanceRef.current.setOption(option, { notMerge: true })
    }
    const handleResize = () => instanceRef.current?.resize()
    window.addEventListener("resize", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
      if (instanceRef.current) {
        instanceRef.current.dispose()
        instanceRef.current = null
      }
    }
  }, [containerRef, option])
}

// ============================================================================
// 1. 张力曲线 raw/smoothed 双列图
// ============================================================================

export interface TensionCurveChartProps {
  tensionCurve: readonly TensionSample[]
}

export function TensionCurveChart({ tensionCurve }: TensionCurveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartId = useId()

  const option = useMemo<echarts.EChartsOption | null>(() => {
    if (!tensionCurve || tensionCurve.length === 0) return null

    const positions = tensionCurve.map((s) => (s.positionRatio * 100).toFixed(1))
    const rawData = tensionCurve.map((s) => Number(s.raw.toFixed(3)))
    const smoothedData = tensionCurve.map((s) => Number(s.smoothed.toFixed(3)))

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ seriesName: string; value: number; axisValueLabel: string }>
          if (!Array.isArray(arr)) return ""
          return arr
            .map((p) => `${p.seriesName}: ${p.value.toFixed(3)}`)
            .join("<br/>")
        },
      },
      legend: {
        data: ["Raw 原始张力", "Smoothed 平滑张力"],
        bottom: 0,
        textStyle: { fontSize: 10 },
      },
      grid: { left: 50, right: 16, top: 16, bottom: 36 },
      xAxis: {
        type: "category",
        data: positions,
        axisLabel: { fontSize: 9, rotate: 45 },
        name: "全书位置 (%)",
        nameTextStyle: { fontSize: 9 },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        name: "张力值",
        nameTextStyle: { fontSize: 9 },
        axisLabel: { fontSize: 9 },
        splitLine: { lineStyle: { type: "dashed", opacity: 0.3 } },
      },
      series: [
        {
          name: "Raw 原始张力",
          type: "line",
          data: rawData,
          smooth: false,
          lineStyle: { width: 1, opacity: 0.5 },
          symbol: "none",
          areaStyle: { opacity: 0.05 },
        },
        {
          name: "Smoothed 平滑张力",
          type: "line",
          data: smoothedData,
          smooth: true,
          lineStyle: { width: 2 },
          symbol: "none",
          areaStyle: { opacity: 0.15 },
        },
      ],
    } as echarts.EChartsOption
  }, [tensionCurve])

  useECharts(containerRef, option)

  if (!tensionCurve || tensionCurve.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        暂无张力曲线数据
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      id={`tension-curve-${chartId}`}
      className="h-52 w-full"
      role="img"
      aria-label="张力曲线：原始与平滑双列"
    />
  )
}

// ============================================================================
// 2. Beat 强度柱状图
// ============================================================================

export interface BeatIntensityChartProps {
  hits: readonly QuantifiedHit[]
}

export function BeatIntensityChart({ hits }: BeatIntensityChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartId = useId()

  const option = useMemo<echarts.EChartsOption | null>(() => {
    if (!hits || hits.length === 0) return null

    const sorted = [...hits].sort((a, b) => a.positionRatio - b.positionRatio)
    const labels = sorted.map((h) => h.beatType)
    const colors = sorted.map((h) =>
      h.closureState === "closed" ? "#22c55e" : h.closureState === "open" ? "#f59e0b" : "#6b7280",
    )

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ value: number; dataIndex: number }>
          if (!Array.isArray(arr) || arr.length === 0) return ""
          const idx = arr[0].dataIndex
          const hit = sorted[idx]
          if (!hit) return ""
          return [
            `类型: ${hit.beatType}`,
            `加权强度: ${hit.weightedIntensity.toFixed(3)}`,
            `原始强度: ${hit.rawIntensity.toFixed(3)}`,
            `位置: ${(hit.positionRatio * 100).toFixed(1)}%`,
            `闭环: ${hit.closureState === "closed" ? "已闭环" : "开放"}`,
          ].join("<br/>")
        },
      },
      grid: { left: 50, right: 16, top: 16, bottom: 60 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { fontSize: 8, rotate: 60, interval: 0 },
        boundaryGap: true,
      },
      yAxis: {
        type: "value",
        name: "加权强度",
        nameTextStyle: { fontSize: 9 },
        axisLabel: { fontSize: 9 },
        splitLine: { lineStyle: { type: "dashed", opacity: 0.3 } },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((h, i) => ({
            value: Number(h.weightedIntensity.toFixed(3)),
            itemStyle: { color: colors[i] },
          })),
          barMaxWidth: 20,
        },
      ],
    } as echarts.EChartsOption
  }, [hits])

  useECharts(containerRef, option)

  if (!hits || hits.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
        暂无 beat 强度数据
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      id={`beat-intensity-${chartId}`}
      className="h-52 w-full"
      role="img"
      aria-label="Beat 强度柱状图"
    />
  )
}

// ============================================================================
// 3. 六维雷达图
// ============================================================================

export interface SixDimRadarChartProps {
  /** 六维评分（0-10），键为 SixReviewDimensionKey */
  scores: Partial<Record<SixReviewDimensionKey, number>>
  /** 维度标签覆盖（可选，默认中文） */
  labels?: Partial<Record<SixReviewDimensionKey, string>>
}

const DIM_LABELS: Record<SixReviewDimensionKey, string> = {
  thrill: "爽感密度",
  consistency: "设定自治",
  pacing: "节奏张力",
  character: "角色深度",
  continuity: "时间线连续性",
  pull: "情感牵引",
}

const DIM_ORDER: SixReviewDimensionKey[] = [
  "thrill",
  "consistency",
  "pacing",
  "character",
  "continuity",
  "pull",
]

export function SixDimRadarChart({ scores, labels }: SixDimRadarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartId = useId()

  const option = useMemo<echarts.EChartsOption | null>(() => {
    const dims = DIM_ORDER
    const indicator = dims.map((key) => ({
      name: labels?.[key] ?? DIM_LABELS[key],
      max: 10,
    }))
    const values = dims.map((key) => scores[key] ?? 0)

    // 检查是否有有效数据
    if (values.every((v) => v === 0)) return null

    return {
      tooltip: {
        formatter: (params: unknown) => {
          const arr = params as Array<{ value: number[]; name: string }>
          if (!Array.isArray(arr) || arr.length === 0) return ""
          return dims
            .map((_key, i) => `${indicator[i].name}: ${values[i].toFixed(1)}`)
            .join("<br/>")
        },
      },
      radar: {
        indicator,
        center: ["50%", "50%"],
        radius: "65%",
        axisName: { fontSize: 10 },
        splitArea: {
          areaStyle: {
            color: ["rgba(100,100,100,0.05)", "rgba(100,100,100,0.02)"],
          },
        },
      },
      series: [
        {
          type: "radar",
          data: [
            {
              value: values,
              name: "六维评分",
              areaStyle: { opacity: 0.2 },
              lineStyle: { width: 2 },
              itemStyle: { color: "#6366f1" },
            },
          ],
        },
      ],
    } as echarts.EChartsOption
  }, [scores, labels])

  useECharts(containerRef, option)

  if (!option) {
    return (
      <div className="flex h-52 items-center justify-center text-xs text-muted-foreground">
        暂无六维评分数据
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      id={`six-dim-radar-${chartId}`}
      className="h-52 w-full"
      role="img"
      aria-label="六维雷达图"
    />
  )
}