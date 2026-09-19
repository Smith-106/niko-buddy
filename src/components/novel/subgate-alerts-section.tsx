/**
 * subgate-alerts-section.tsx — 波2-E：子门/告警可见区（G-14 修复）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2-E + GLM 第 2 轮 G-14）：
 *   - 跨形态子门（kind=stage payload.subGate）、同质化/声音漂移告警
 *     （payload.alert）、反事实重放（payload.counterfactual）此前"算得到但
 *     看不见"——本组件经 deriveSubGateAlerts 只读派生并展示；
 *   - 数据源 = 运行事件账本（与 evidence-dashboard-section 同一账本，零写路径）；
 *   - 零子门/零告警 → 显式"暂无记录"（零候选是合法结果，不制造噪声）。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import {
  createFsRunEventLedgerStoreDeps,
  deriveSubGateAlerts,
  loadRunEventLedgerStore,
  type RunEventLedger,
  type RunEventLedgerStoreDeps,
  type SubGateAlertItem,
} from "@/lib/novel"

export interface SubgateAlertsSectionProps {
  readonly projectId: string
  /** 显式注入账本（测试/预览；优先于磁盘装载）。 */
  readonly ledger?: RunEventLedger | null
  /** deps 注入（jsdom 测试；缺省生产 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
}

const CATEGORY_LABELS: Record<SubGateAlertItem["category"], string> = {
  subgate: "子门",
  alert: "告警",
  counterfactual: "反事实",
}

export function SubgateAlertsSection({ projectId, ledger, deps }: SubgateAlertsSectionProps) {
  const [loaded, setLoaded] = useState<RunEventLedger | null>(ledger ?? null)
  const [loadedDeps, setLoadedDeps] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (ledger !== undefined && ledger !== null) {
      setLoaded(ledger)
      setLoadedDeps(true)
      return
    }
    if (ledger !== undefined) {
      setLoaded(null)
      setLoadedDeps(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const file = await loadRunEventLedgerStore(deps ?? createFsRunEventLedgerStoreDeps(), projectId)
        if (cancelled) return
        setLoaded(file)
      } catch {
        if (!cancelled) {
          setFailed(true)
          setLoaded(null)
        }
      } finally {
        if (!cancelled) setLoadedDeps(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, ledger, deps])

  const items: readonly SubGateAlertItem[] = loaded === null ? [] : deriveSubGateAlerts(loaded)

  return (
    <section className="rounded-lg border p-4" data-testid="subgate-alerts-section">
      <h3 className="mb-2 text-sm font-semibold">子门与告警</h3>
      {loadedDeps ? (
        failed ? (
          <p className="text-xs text-muted-foreground" data-testid="subgate-alerts-failed">
            记录装载失败（断网/账本不可读）
          </p>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="subgate-alerts-empty">
            暂无子门/告警记录（未触发即无记录）
          </p>
        ) : (
          <ul className="space-y-1.5" data-testid="subgate-alerts-list">
            {items.map((item) => (
              <li
                key={item.eventId}
                data-testid={`subgate-item-${item.eventId}`}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
              >
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {CATEGORY_LABELS[item.category]}
                </span>
                <span className="font-medium">{item.name}</span>
                {item.summary.length > 0 ? <span className="text-neutral-500 dark:text-neutral-400">{item.summary}</span> : null}
                <span className="text-[10px] text-neutral-400">{item.ts}</span>
                {item.evidenceRefs.length > 0 ? (
                  <span className="ml-auto text-[10px] text-neutral-400" title={item.evidenceRefs.join(", ")}>
                    证据 {item.evidenceRefs.length}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="subgate-alerts-loading">
          记录装载中…
        </p>
      )}
    </section>
  )
}