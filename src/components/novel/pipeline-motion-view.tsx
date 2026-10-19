// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-view.tsx — 「管線動態」視圖（只讀接線層）。
 *
 * 只做一件事：只讀裝載運行事件賬本（run-events.jsonl）與主控軌跡快照，
 * 交給 PipelineMotionPanel 做純投影渲染。本視圖不寫任何文件。
 *
 * 失敗口徑：裝載失敗保留舊數據並顯式報錯（不彈空、不重試刷屏）；
 * 輪詢間隔 10 秒，讀到新事件才重渲染（投影層是純函數，同輸入同輸出）。
 */

import { useEffect, useRef, useState } from "react"

import {
  createFsRunEventLedgerStoreDeps,
  loadRunEventLedgerStore,
  loadTraceSnapshot,
  type RunEvent,
  type RunEventLedgerStoreDeps,
  type TraceEntry,
} from "@/lib/novel"

import { PipelineMotionPanel } from "./pipeline-motion-panel"

export interface PipelineMotionViewProps {
  /** 項目磁盤路徑（content-area 傳 project.path，不是 UUID；UUID 讀不到賬本）。 */
  readonly projectPath: string
  /** 顯式注入賬本（測試；優先於磁盤裝載）。 */
  readonly ledgerEvents?: readonly RunEvent[] | null
  /** 顯式注入軌跡條目（測試；優先於磁盤裝載）。 */
  readonly traceEntries?: readonly TraceEntry[] | null
  /** deps 注入（jsdom 測試；缺省生產 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
  /** 輪詢間隔毫秒（測試可調小；預設 10 秒）。 */
  readonly pollMs?: number
}

const DEFAULT_POLL_MS = 10_000

export function PipelineMotionView({
  projectPath,
  ledgerEvents,
  traceEntries,
  deps,
  pollMs = DEFAULT_POLL_MS,
}: PipelineMotionViewProps) {
  const [events, setEvents] = useState<readonly RunEvent[] | null>(ledgerEvents ?? null)
  const [entries, setEntries] = useState<readonly TraceEntry[] | null>(traceEntries ?? null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 有無成功寫入過數據 / 連續失敗輪數（跨輪詢累積，切項目重置）。
  // ready 的誠實規則：只在「新鮮成功寫入」或「失敗已成定局」（首輪新鮮失敗、
  // 連敗且無數據）時離開 loading；過期響應結算永不碰 ready（否則會把
  // 「尚無運行事件」提前畫出來，而勝出輪的數據還在途中）。
  const hasDataRef = useRef(false)
  const failStreakRef = useRef(0)

  useEffect(() => {
    if (ledgerEvents !== undefined || traceEntries !== undefined) {
      // 測試注入路徑：prop 變更即同步，不走磁盤。
      if (ledgerEvents !== undefined) setEvents(ledgerEvents)
      if (traceEntries !== undefined) setEntries(traceEntries)
      setReady(true)
      return
    }
    // 切項目即重置：舊項目的管線不許殘留，新一輪裝載前回到 loading。
    setEvents(null)
    setEntries(null)
    setLoadError(null)
    setReady(false)
    hasDataRef.current = false
    failStreakRef.current = 0
    let cancelled = false
    let generation = 0
    const storeDeps = deps ?? createFsRunEventLedgerStoreDeps()
    const loadOnce = async (first: boolean): Promise<void> => {
      generation += 1
      const current = generation
      try {
        const [ledger, snapshot] = await Promise.all([
          loadRunEventLedgerStore(storeDeps, projectPath),
          loadTraceSnapshot(projectPath),
        ])
        // 在途的舊請求不許覆蓋新項目的數據（連 ready 也不碰）。
        if (cancelled || current !== generation) return
        hasDataRef.current = true
        failStreakRef.current = 0
        setEvents(ledger.events)
        setEntries(snapshot?.entries ?? [])
        setLoadError(null)
        setReady(true)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        failStreakRef.current += 1
        const streak = failStreakRef.current
        // 錯誤文案只在「看的人能理解」時出現：在途輪詢的單次失敗保持靜默
        // loading（否則 error＋loading 並存自相矛盾）；有舊數據或失敗已成
        // 定局（首輪新鮮失敗/連敗）才顯式報錯。
        const showError = first || hasDataRef.current || streak >= 2
        if (showError) setLoadError(message)
        if (current !== generation) {
          // 過期請求的失敗：勝出輪在途，不離開 loading；
          // 連敗且從無數據，失敗已成定局才報。
          if (streak >= 2 && !hasDataRef.current) setReady(true)
          return
        }
        // 失敗保留舊數據：只記錯誤文案，不清空已渲染的管線。
        if (first || hasDataRef.current || streak >= 2) setReady(true)
      }
    }
    void loadOnce(true)
    const timer = setInterval(() => {
      void loadOnce(false)
    }, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectPath, ledgerEvents, traceEntries, deps, pollMs])

  return (
    <div data-testid="pipeline-motion-view" className="space-y-2">
      {loadError ? (
        <p data-testid="motion-load-error" className="text-[11px] text-destructive">
          事件裝載失敗（保留上次數據）：{loadError}
        </p>
      ) : null}
      {!ready ? (
        <p data-testid="motion-view-loading" className="text-xs text-muted-foreground">
          管線事件裝載中…
        </p>
      ) : (
        <PipelineMotionPanel
          input={{ events: events ?? [], traceEntries: entries ?? [] }}
        />
      )}
    </div>
  )
}
