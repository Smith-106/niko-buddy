/**
 * evidence-dashboard-section.tsx — 波2-D：首页仪表盘证据区（真实 UI 接线）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2-D）：
 *   - GLM/DS P0 缺口「证据卡接真实 UI」：EvidenceGateCards（波1-E 纯展示）
 *     接入 director-view 首页仪表盘——数据源 = 运行事件账本（.novel/
 *     run-events.jsonl）只读派生（dashboard-evidence），零写路径、禁第二真源；
 *   - R-04：未落 gate-run 事件的门渲染「未评估」，永不渲染为通过；
 *   - INV-7：账本缺失/读取失败 → 渲染空账本语义（三门未评估），不臆造门状态。
 *
 * 数据装载：props.ledger 显式注入（测试/预览）优先；否则经
 * loadRunEventLedgerStore 只读加载（deps 可注入；缺省生产 deps=Tauri fs）。
 * 断网/读取失败 → 空账本快照（诚实未评估），不阻塞首页其他区块。
 *
 * @license MIT © QMAI
 */

import { useEffect, useState } from "react"
import { EvidenceGateCards } from "@/components/novel/evidence-gate-card"
import {
  buildDashboardEvidenceSnapshot,
  createFsRunEventLedgerStoreDeps,
  createRunEventLedger,
  loadRunEventLedgerStore,
  type EvidenceSnapshot,
  type RunEventLedger,
  type RunEventLedgerStoreDeps,
} from "@/lib/novel"

export interface EvidenceDashboardSectionProps {
  readonly projectId: string
  /** 显式注入账本（测试/预览；优先于磁盘装载）。 */
  readonly ledger?: RunEventLedger | null
  /** deps 注入（jsdom 测试；缺省生产 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
}

export function EvidenceDashboardSection({ projectId, ledger, deps }: EvidenceDashboardSectionProps) {
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
      // 显式 null：跳过磁盘装载（预览态，诚实未评估）
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
        // INV-7 诚实面：装载失败（断网/损坏行上抛由 store 契约）→ 空账本快照
        // （三门未评估，不臆造门状态），不阻塞首页其他区块
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

  const snapshot: EvidenceSnapshot | null = failed
    ? buildDashboardEvidenceSnapshot(createRunEventLedger())
    : loaded === null
      ? null
      : buildDashboardEvidenceSnapshot(loaded)

  return (
    <section className="rounded-lg border p-4" data-testid="evidence-dashboard-section">
      <h3 className="mb-2 text-sm font-semibold">门控证据</h3>
      {loadedDeps ? (
        failed ? (
          <>
            <p className="mb-1 text-[10px] text-muted-foreground" data-testid="evidence-dashboard-failed">
              证据装载失败（断网/账本不可读）：以下为未评估诚实面
            </p>
            <EvidenceGateCards snapshot={snapshot} />
          </>
        ) : (
          <EvidenceGateCards snapshot={snapshot} />
        )
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="evidence-dashboard-loading">
          证据装载中…
        </p>
      )}
    </section>
  )
}