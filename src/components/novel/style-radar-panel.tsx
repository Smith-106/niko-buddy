/**
 * style-radar-panel.tsx — 风格 / 节奏雷达面板（**只读**）。
 *
 * 用户诉求：「把风格化做成雷达图，可视化管理和控制要写什么风格、怎么控节奏」。
 *
 * 诚实边界（与投影一致，不在这里放宽）：
 *   - 半径只放 6 个**机械代理指标**（0–100，由正文统计得出），面板标题与图例都写明
 *     「机械代理指标，不是文学评分」；
 *   - 目标风格（`BookStyleProfile`）是自由文本，**不进半径**，只在旁边列成文本；
 *   - 目标节奏（压力级 1–5 / 情绪 1–10）**不同量纲**，单独用数字卡片呈现，不叠图；
 *   - 无正文 → 不画雷达（显式空态），不画 0 分雷达。
 *
 * 零新依赖：手写 SVG（与既有 `context-ring.tsx` / `SixDimRadarChart` 的做法一致）。
 */

import { useEffect, useState } from "react"
import { Radar } from "lucide-react"

import { toErrorMessage } from "@/lib/utils"
import {
  projectStyleRadar,
  radarPoints,
  toPointsAttr,
  type StyleRadarInput,
  type StyleRadarProjection,
} from "@/lib/novel"

const SIZE = 240
const CENTER = SIZE / 2
const RADIUS = SIZE / 2 - 34

export interface StyleRadarPanelProps {
  /** 注入投影（测试可替换）。 */
  readonly projection?: StyleRadarProjection
  /** 注入输入（测试可替换；优先级低于 projection）。 */
  readonly input?: StyleRadarInput
  /** 注入装载器；缺省不读盘（面板为纯展示，读盘由外层注入）。 */
  readonly loader?: () => Promise<StyleRadarInput | null>
}

/**
 * 背景环顶点必须落在**真实轴角**上（原始轴位 / 轴总数），否则缺值轴一出现，
 * 环会按剩下轴数等分重排，与辐线、数据点错位（对抗式审查 P2）。
 */
function ringPoints(
  ratio: number,
  axisIndexes: readonly number[],
  totalAxes: number,
): { x: number; y: number }[] {
  return axisIndexes.map((index) => {
    const angle = (Math.PI * 2 * index) / totalAxes - Math.PI / 2
    return { x: CENTER + Math.cos(angle) * RADIUS * ratio, y: CENTER + Math.sin(angle) * RADIUS * ratio }
  })
}

export function StyleRadarPanel({ projection, input, loader }: StyleRadarPanelProps) {
  const [loaded, setLoaded] = useState<StyleRadarInput | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projection !== undefined || input !== undefined || !loader) return
    let cancelled = false
    void loader()
      .then((next) => {
        if (!cancelled) setLoaded(next)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`装载失败：${toErrorMessage(e)}`)
      })
    return () => {
      cancelled = true
    }
  }, [input, loader, projection])

  const resolved: StyleRadarProjection = projection ?? projectStyleRadar(input ?? loaded ?? {})
  // 只画**有值**的轴：缺值轴既不落圆心、也不画辐线/标签（否则弦会跨过空轴切出假半径）。
  const valueless = resolved.axes.filter((axis) => axis.value === null)
  const axisCount = resolved.axes.length - valueless.length
  const plotted = radarPoints(resolved.axes, RADIUS, { x: CENTER, y: CENTER })
  const drawable = plotted.length >= 3
  const polygon = drawable ? toPointsAttr(plotted) : ""
  const plottedAxes = resolved.axes.filter((axis) => axis.value !== null)
  // 有值轴的**原始轴位**：环、辐线、顶点统一用这一组角度。
  const plottedIndexes = resolved.axes
    .map((axis, index) => (axis.value === null ? -1 : index))
    .filter((index) => index >= 0)

  return (
    <section data-testid="style-radar-panel" className="space-y-3 rounded-md border border-border p-3">
      <header className="space-y-1">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Radar className="h-4 w-4" />
          风格 / 节奏雷达（只读）
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="style-radar-scope">
          半径 = 6 项**机械代理指标**（正文抽样统计，0–100），不是文学评分。目标风格（自由文本）与目标节奏
          （压力级 1–5 / 情绪 1–10）**不同量纲**，都不叠进这张图。
        </p>
      </header>

      {error ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="style-radar-error">
          {error}
        </p>
      ) : null}

      {drawable ? (
        <div className="flex flex-wrap items-start gap-4">
          <svg
            data-testid="style-radar-svg"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            width={SIZE}
            height={SIZE}
            role="img"
            aria-label="风格与节奏机械代理指标雷达图"
          >
            {[0.25, 0.5, 0.75, 1].map((ratio) => (
              <polygon
                key={ratio}
                points={toPointsAttr(ringPoints(ratio, plottedIndexes, resolved.axes.length))}
                className="fill-none stroke-border"
                strokeWidth={1}
              />
            ))}
            {Array.from({ length: axisCount }, (_, i) => {
              // 辐线按**原始轴位**取角度，与 radarPoints 的顶点角度一致。
              const originalIndex = resolved.axes.indexOf(plottedAxes[i]!)
              const angle = (Math.PI * 2 * originalIndex) / resolved.axes.length - Math.PI / 2
              const x = CENTER + Math.cos(angle) * RADIUS
              const y = CENTER + Math.sin(angle) * RADIUS
              return (
                <line
                  key={i}
                  x1={CENTER}
                  y1={CENTER}
                  x2={x}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                />
              )
            })}
            <polygon
              data-testid="style-radar-polygon"
              points={polygon}
              className="fill-emerald-500/25 stroke-emerald-600"
              strokeWidth={2}
            />
            {plottedAxes.map((axis) => {
              const originalIndex = resolved.axes.indexOf(axis)
              const angle = (Math.PI * 2 * originalIndex) / resolved.axes.length - Math.PI / 2
              const lx = CENTER + Math.cos(angle) * (RADIUS + 20)
              const ly = CENTER + Math.sin(angle) * (RADIUS + 20)
              return (
                <text
                  key={axis.key}
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-xs"
                >
                  {axis.label}
                </text>
              )
            })}
          </svg>

          <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="style-radar-axes">
            {resolved.axes.map((axis) => (
              <li key={axis.key} data-testid={`style-radar-axis-${axis.key}`}>
                {axis.label}：
                <b className="text-foreground">{axis.value === null ? "暂无" : axis.value.toFixed(1)}</b>
              </li>
            ))}
            <li className="pt-1">
              机械层均分：<b className="text-foreground">{resolved.overall === null ? "暂无" : resolved.overall.toFixed(1)}</b>
            </li>
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="style-radar-empty">
          没有可画的轴：缺少章节正文（或轴数 &lt; 3）→ 不画 0 分雷达。
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-border p-2" data-testid="style-radar-target">
          <p className="text-xs font-medium text-foreground">目标节奏（章纲定位 · 不同量纲）</p>
          <p className="text-xs text-muted-foreground">
            章节：<b className="text-foreground">{resolved.target.chapterLabel ?? "暂无"}</b> · 压力级：
            <b className="text-foreground">{resolved.target.pressureLevel ?? "暂无"}</b> · 情绪强度：
            <b className="text-foreground">{resolved.target.emotionIntensity ?? "暂无"}</b>
          </p>
        </div>
        <div className="rounded border border-border p-2" data-testid="style-radar-target-style">
          <p className="text-xs font-medium text-foreground">目标风格（无数值，不进半径）</p>
          {resolved.targetStyleText.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无：未选定作品库风格画像</p>
          ) : (
            <ul className="text-xs text-muted-foreground">
              {resolved.targetStyleText.map((item) => (
                <li key={item.label}>
                  {item.label}：{item.value}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="style-radar-na">
        <li className="font-medium text-foreground">明确不适用（防造假）</li>
        {resolved.notApplicable.map((item) => (
          <li key={item.id} data-testid={`style-radar-na-${item.id}`}>
            {item.label}：{item.reason}
          </li>
        ))}
      </ul>

      {resolved.missingSources.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400" data-testid="style-radar-missing">
          {resolved.missingSources.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
