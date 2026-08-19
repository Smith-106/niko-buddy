/**
 * ContextRing — Wave 5 (v2.5.0) 上下文用量圆环（透明度卖点）。
 *
 * 纯 SVG stroke-dasharray 分段圆环，展示一次生成上下文的字符分配：
 * 记忆（实测）/ 检索 / 图谱 / 正文（预算线）/ 其他（剩余）。
 * 受控纯组件：数据全部来自 computeRingSegments(usage) 纯函数输出，
 * 不在组件内计算或 fetch（保证「不重复计算」贯穿到 UI 层）。
 * 无新依赖；jsdom 下可断言 stroke-dasharray / aria-label。
 */
import { computeRingSegments, type ContextUsage } from "@/lib/context-usage"

const SEGMENT_COLORS: Record<import("@/lib/context-usage").RingSegment["key"], string> = {
  memory: "#8b5cf6",
  retrieval: "#3b82f6",
  graph: "#f59e0b",
  body: "#10b981",
  other: "#e5e7eb",
}

const RING_RADIUS = 40
const RING_STROKE = 10
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const GAP_FRACTION = 0.02

export interface ContextRingProps {
  usage: ContextUsage
  /** 展示直径（px），默认 120。 */
  size?: number
}

/**
 * 分段几何 → dasharray/dashoffset（导出纯函数，分段数学可单测）。
 * 每段占 fraction × circumference，段间留 GAP_FRACTION 空隙。
 */
export function computeRingGeometry(usage: ContextUsage): Array<{
  key: string
  label: string
  chars: number
  dasharray: string
  dashoffset: number
}> {
  const segments = computeRingSegments(usage)
  let cursor = 0
  return segments.map((segment) => {
    const dash = Math.max(0, segment.fraction * CIRCUMFERENCE - GAP_FRACTION * CIRCUMFERENCE)
    const gap = Math.max(0, segment.fraction * CIRCUMFERENCE - dash)
    const geometry = {
      key: segment.key,
      label: segment.label,
      chars: segment.chars,
      dasharray: `${dash} ${gap}`,
      dashoffset: -cursor || 0,
    }
    cursor += segment.fraction * CIRCUMFERENCE
    return geometry
  })
}

export function ContextRing({ usage, size = 120 }: ContextRingProps) {
  const geometry = computeRingGeometry(usage)
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-2.5"
      data-testid="context-ring"
      role="img"
      aria-label={`上下文用量：${geometry.map((s) => `${s.label} ${Math.round((s.chars / Math.max(1, usage.maxCtx)) * 100)}%`).join("，")}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className="shrink-0"
        data-testid="context-ring-svg"
      >
        {geometry.map((segment) => (
          <circle
            key={segment.key}
            data-segment={segment.key}
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            stroke={SEGMENT_COLORS[segment.key]}
            strokeWidth={RING_STROKE}
            strokeDasharray={segment.dasharray}
            strokeDashoffset={segment.dashoffset}
            transform="rotate(-90 50 50)"
          >
            <title>{`${segment.label}：${segment.chars} 字符（预算占比 ${Math.round(segment.chars / Math.max(1, usage.maxCtx) * 100)}%）`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex min-w-0 flex-col gap-1 text-xs">
        {geometry.map((segment) => (
          <div key={segment.key} className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: SEGMENT_COLORS[segment.key] }}
            />
            <span>{segment.label}</span>
            <span className="tabular-nums">
              {Math.round((segment.chars / Math.max(1, usage.maxCtx)) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
