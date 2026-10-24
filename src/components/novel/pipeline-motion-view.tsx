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
import { toErrorMessage } from "@/lib/utils"

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
  // ready 的誠實規則：只在「成功寫入」或「失敗已成定局」（首輪失敗、
  // 連敗且無數據）時離開 loading。輪詢是串行的（上一輪結算才排下一輪），
  // 從構造上杜絕重疊請求——沒有 stale 響應，就沒有「丟棄誰/提前報誰」的
  // 一整類誠實性問題；世代號不需要。
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
    let timer: ReturnType<typeof setTimeout> | null = null
    const storeDeps = deps ?? createFsRunEventLedgerStoreDeps()
    // 串行輪詢：結算後才排下一輪，請求永不重疊（慢讀只會推遲下一輪，
    // 不會被超車作廢——每輪成功都寫入，不存在永久 loading）。
    const tick = async (first: boolean): Promise<void> => {
      if (cancelled) return
      try {
        const [ledger, snapshot] = await Promise.all([
          loadRunEventLedgerStore(storeDeps, projectPath),
          loadTraceSnapshot(projectPath),
        ])
        if (cancelled) return
        hasDataRef.current = true
        failStreakRef.current = 0
        setEvents(ledger.events)
        setEntries(snapshot?.entries ?? [])
        setLoadError(null)
        setReady(true)
      } catch (error) {
        if (cancelled) return
        failStreakRef.current += 1
        const streak = failStreakRef.current
        // 錯誤文案只在失敗已成定局時出現：首輪失敗立刻報（空態＋錯
        // 誤同現）；有舊數據時後續失敗只添錯誤條、不清空管線；首輪懸掛
        // 時無任何失敗可報（串行鏈下後輪尚未開火），保持 loading。
        // 無重疊請求，error 與 loading 不可能並存，也不會有過期錯誤覆蓋新數據。
        if (first || hasDataRef.current || streak >= 2) {
          setLoadError(toErrorMessage(error))
          setReady(true)
        }
      }
      if (cancelled) return
      timer = setTimeout(() => {
        void tick(false)
      }, pollMs)
    }
    void tick(true)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [projectPath, ledgerEvents, traceEntries, deps, pollMs])

  return (
    <div data-testid="pipeline-motion-view" className="space-y-2">
      {loadError ? (
        <p data-testid="motion-load-error" className="text-xs text-destructive">
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
