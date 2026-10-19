/**
 * market-radar-view.tsx — 市场雷达视图（诚实空态）。
 *
 * ## 职责
 *   - 市场榜单/销量/热度数据的预留展示位。经核查：仓库内无任何榜单、销量、
 *     热度真数据源（trend-radar 是写作内生的题材信号资产，与外部市场榜单无关；
 *     误用它冒充市场数据属于伪造），因此本视图只做诚实空态。
 *
 * ## 数据源
 *   - 无真数据源。`loadMarketRadarSnapshot` 为预留装载函数签名，恒返回空结构
 *     `{ connected: false, signals: [] }`；数据源接入后应在本函数内实现装载，
 *     并更新下方缺口记录。
 *
 * ## 缺口记录（2026-10-19）
 *   - 未伪造任何榜单条目、排名、销量数字；空态文案明确说明「数据未接入」。
 *
 * 中文 UI；只读。
 *
 * @license MIT © Niko Buddy
 */

import { useEffect, useState } from "react"
import { Loader2, Radar } from "lucide-react"

/** 市场信号（预留形状；数据源接入前恒为空数组）。 */
export interface MarketRadarSignal {
  readonly id: string
  readonly title: string
  readonly source: string
  readonly rank: number
}

/** 市场雷达快照（预留形状；未接入前 connected 恒为 false）。 */
export interface MarketRadarSnapshot {
  readonly projectPath: string
  readonly connected: boolean
  readonly signals: readonly MarketRadarSignal[]
  readonly reason: string
}

/**
 * 预留装载函数：当前无真数据源，恒返回空结构，不伪造榜单数据。
 * 数据源接入后在此实现装载并更新缺口记录。
 */
export async function loadMarketRadarSnapshot(projectPath: string): Promise<MarketRadarSnapshot> {
  return {
    projectPath,
    connected: false,
    signals: [],
    reason: "市场榜单数据源未接入：仓库内无榜单/销量/热度真源，本页不伪造任何榜单数据。",
  }
}

export interface MarketRadarViewProps {
  /** 项目根路径（统一签名；未指定时显示空态）。 */
  readonly projectPath: string
}

export function MarketRadarView({ projectPath }: MarketRadarViewProps) {
  const [snapshot, setSnapshot] = useState<MarketRadarSnapshot | null>(null)
  const [loading, setLoading] = useState(projectPath !== "")

  useEffect(() => {
    if (projectPath === "") {
      setSnapshot(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void loadMarketRadarSnapshot(projectPath)
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  return (
    <section data-testid="market-radar-view" className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Radar className="h-4 w-4" />
        市场雷达
      </h2>
      <p className="text-xs text-muted-foreground">
        外部市场榜单/热度数据的预留展示位；数据源接入前本页保持诚实空态。
      </p>

      {loading ? (
        <p data-testid="market-radar-loading" className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在读取市场雷达数据…
        </p>
      ) : snapshot === null ? (
        <p data-testid="market-radar-empty" className="text-xs text-muted-foreground">
          未指定项目路径
        </p>
      ) : snapshot.connected && snapshot.signals.length > 0 ? (
        <ul data-testid="market-radar-list" className="flex flex-col gap-1">
          {snapshot.signals.map((signal) => (
            <li
              key={signal.id}
              data-testid={`market-radar-signal-${signal.id}`}
              className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
            >
              <span className="font-medium text-foreground">#{signal.rank}</span>
              <span>{signal.title}</span>
              <span>{signal.source}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="market-radar-empty" className="text-xs text-muted-foreground">
          市场数据未接入：{snapshot.reason}
        </p>
      )}
    </section>
  )
}
