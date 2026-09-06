/**
 * kb-health-view.tsx — KB 健康面板（P2-IMP-13 / P2-M4，只读展示）。
 *
 * ## 职责
 *   - 只读展示 KbMetrics 6 项核心指标（GOV-OBS-01）：值 / N/A（含 unavailableReason）。
 *   - truth_fold_drift > 0 → 行级高亮 + 告警横幅（不静默降级）+「建议重建」按钮。
 *   - N/A 与真实值分色：N/A 用 muted 徽章 + 原因小字（agentmemory 诚实降级模式，
 *     绝不伪造数值）；真实值用前景色常规渲染。
 *
 * ## 边界与纪律
 *   - 纯展示组件（props 驱动）：metrics 由调用方注入（生产源 =
 *     buildContextPackUnlocked 尾部装配的 pack.kbMetrics，或独立 collectKbMetrics
 *     采样；promotion_replay_success 真实源 = kb-observability.collectKbMetricsLive
 *     接 promotion-bridge 凭证层，P2-IMP-15）；本组件不做任何 IO、零新真源。
 *   - onRebuild 可选：缺省时按钮禁用（重建动作属调用方接线）。P2-IMP-15 自愈段：
 *     drift 自动修复（autoRepairTruthFoldDrift）成功时告警不升级，宿主传入
 *     selfHealedFiles → 展示「漂移已自动修复」信息横幅（与告警横幅互斥）。
 *
 * 遵循 QMAI/CLAUDE.md 锚点：新增组件落 `src/components/novel/`（与 snapshot-viewer
 * 同目录约定），中文标签直书（与 snapshot-viewer 历史版本/POV 区块同款约定）。
 */
import type { KbMetrics, MetricSample } from "@/lib/novel/kb-observability"

export interface KbHealthViewProps {
  /** 6 指标快照（生产源 = pack.kbMetrics；缺源项 value=null + unavailableReason）。 */
  metrics: KbMetrics
  /** 建议重建回调（drift>0 告警横幅内展示按钮）；缺省 → 按钮禁用（只读降级）。 */
  onRebuild?: () => void
  /** 重建进行中标记（按钮转 spinner 文案并禁用，防重复触发）。 */
  rebuilding?: boolean
  /**
   * P2-IMP-15：drift 自愈成功的文件列表（宿主从 autoRepairTruthFoldDrift 结果
   * 注入）。非空且当前无漂移告警 → 展示「漂移已自动修复」信息横幅；
   * 缺省/空 → 零渲染变化（向后兼容）。
   */
  selfHealedFiles?: string[]
}

/** 6 行指标渲染配置（kind：rate=0~1 比例按百分比渲染；count=计数直读）。 */
const METRIC_ROWS: ReadonlyArray<{
  key: keyof KbMetrics
  label: string
  target: string
  kind: "rate" | "count"
}> = [
  { key: "canon_violation_rate", label: "正史违反率", target: "目标 <1%", kind: "rate" },
  { key: "obligation_coverage", label: "义务覆盖率", target: "目标 >95%", kind: "rate" },
  { key: "hard_injection_budget_usage", label: "硬注入预算占用", target: "", kind: "rate" },
  { key: "promotion_replay_success", label: "晋升重放成功率", target: "", kind: "rate" },
  { key: "truth_fold_drift", label: "真相文件漂移", target: "目标 =0", kind: "count" },
  { key: "gap_report_rate", label: "检索缺口报告数", target: "", kind: "count" },
]

function formatMetricValue(kind: "rate" | "count", value: number): string {
  return kind === "rate" ? `${(value * 100).toFixed(1)}%` : String(value)
}

function isDriftAlarm(sample: MetricSample): boolean {
  return sample.value !== null && sample.value > 0
}

export function KbHealthView({ metrics, onRebuild, rebuilding = false, selfHealedFiles }: KbHealthViewProps) {
  const drift = metrics.truth_fold_drift
  const driftAlarmed = isDriftAlarm(drift)
  const selfHealed = !driftAlarmed && Array.isArray(selfHealedFiles) && selfHealedFiles.length > 0
  return (
    <div data-testid="kb-health-view" className="rounded-md border border-border bg-background px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">KB 健康面板</h3>
        <span className="text-xs text-muted-foreground">6 项核心指标（只读）</span>
      </div>
      <div className="space-y-1.5">
        {METRIC_ROWS.map((row) => {
          const sample: MetricSample = metrics[row.key]
          const isNa = sample.value === null
          const rowAlarmed = row.key === "truth_fold_drift" && !isNa && isDriftAlarm(sample)
          return (
            <div
              key={row.key}
              data-testid={`kb-metric-${row.key}`}
              className={
                "flex items-center justify-between gap-2 rounded border px-2 py-1.5 " +
                (rowAlarmed
                  ? "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40"
                  : "border-transparent")
              }
            >
              <div className="min-w-0">
                <div className="text-sm text-foreground">
                  {row.label}
                  {row.target ? <span className="ml-1 text-xs text-muted-foreground">（{row.target}）</span> : null}
                </div>
                {isNa && sample.unavailableReason ? (
                  <div className="text-xs text-muted-foreground">{sample.unavailableReason}</div>
                ) : null}
              </div>
              {isNa ? (
                <span
                  data-testid={`kb-metric-${row.key}-na`}
                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  N/A
                </span>
              ) : (
                <span className="shrink-0 text-sm font-medium text-foreground">
                  {formatMetricValue(row.kind, sample.value ?? 0)}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {driftAlarmed ? (
        <div
          data-testid="kb-health-drift-alarm"
          className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40"
        >
          <p className="text-sm text-amber-900 dark:text-amber-200">
            记忆漂移：truth_fold_drift={drift.value} &gt; 0，真相文件与快照重放不一致，建议执行全量重建。
          </p>
          <button
            type="button"
            onClick={onRebuild}
            disabled={!onRebuild || rebuilding}
            title="重建过程库（按快照重放重建漂移的真相文件）"
            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rebuilding ? "重建中…" : "建议重建"}
          </button>
        </div>
      ) : null}
      {selfHealed ? (
        <div
          data-testid="kb-health-drift-selfhealed"
          className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900/60 dark:bg-emerald-950/40"
        >
          <p className="text-sm text-emerald-900 dark:text-emerald-200">
            漂移已自动修复：{selfHealedFiles!.length} 类真相文件经投影注册表重建，复测 drift=0。
          </p>
        </div>
      ) : null}
    </div>
  )
}
