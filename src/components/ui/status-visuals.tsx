/**
 * 门禁链共用的局部视觉：芯片与刻度。
 * 只展示调用方已经算好的标签和数值，不新增依赖，不用颜色单独表意。
 */

function formatMeterValue(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

const CHIP_TONE = {
  neutral: "border-border bg-muted text-foreground",
  warning: "border-warning/40 bg-warning/15 text-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-foreground",
  info: "border-info/40 bg-info/10 text-foreground",
  ok: "border-success/40 bg-success/10 text-foreground",
} as const

export type StatusChipTone = keyof typeof CHIP_TONE

export function StatusChip({
  label,
  tone = "neutral",
}: {
  label: string
  tone?: StatusChipTone
}) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${CHIP_TONE[tone]}`}>
      {label}
    </span>
  )
}

export function MeterBar({
  label,
  value,
  max,
}: {
  label: string
  value: number
  max: number
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0
  const text = `${formatMeterValue(safeValue)}/${formatMeterValue(safeMax)}`
  const caption = `${label} ${text}`
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className="truncate tabular-nums">{caption}</span>
      <meter
        min={0}
        max={safeMax}
        value={safeValue}
        aria-label={caption}
        className="h-2 w-16"
      />
    </div>
  )
}
