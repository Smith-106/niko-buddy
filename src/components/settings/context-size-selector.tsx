// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/** Preset context window sizes for the slider. */
const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

/**
 * Format a token count into a human-readable size label.
 *
 * 单位是 token 而不是字符：`maxContextSize` 是模型窗口，模型窗口本身就是
 * token 计数的（预设的 suggestedContextSize 同样是 token）。这里曾渲染成
 * "characters"，与 runner 侧按 token 裁剪的读法直接矛盾。
 */
function formatSize(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tokens`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tokens`
  return `${tokens} tokens`
}

/**
 * Context size selector with a range slider and preset buttons.
 * Maps discrete slider steps to predefined context window sizes.
 */
export function ContextSizeSelector({
  value,
  onChange,
  id,
}: {
  value: number
  onChange: (v: number) => void
  /** 滑块 id，供外部 <Label htmlFor> 关联可访问名。 */
  id?: string
}) {
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, i) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value)
      ? i
      : best
  }, 0)
  const pct = (closestIndex / (CONTEXT_PRESETS.length - 1)) * 100

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor((value * 0.6) / 1000)}K chars for wiki content
        </span>
      </div>
      <input
        id={id}
        type="range"
        aria-valuetext={formatSize(value)}
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value)].value)}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-primary"
        style={{
          background: `linear-gradient(to right, #4f46e5 ${pct}%, #e5e7eb ${pct}%)`,
        }}
      />
      <div className="flex justify-between mt-1">
        {CONTEXT_PRESETS.map((preset, i) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            aria-pressed={i === closestIndex}
            className={`inline-flex min-h-6 min-w-6 items-center justify-center rounded text-xs px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              i === closestIndex ? "text-primary font-bold" : "text-muted-foreground"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}
