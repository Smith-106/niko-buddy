// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * live-execution-view.tsx — 「AI实况」视图（只读接线层）。
 *
 * 只做一件事：只读装载三路实况信号并做诚实投影——
 *   1. 内存活动（activity-store，status running 为运行中）；
 *   2. 运行事件账本（run-events.jsonl，最近 30 条）；
 *   3. 主控轨迹快照（main-control-trace.json 条目）。
 * 本视图不写任何文件，不编造运行状态：三路全空时只显空态。
 *
 * 失败口径（仿 pipeline-motion-view）：装载失败保留旧数据并显式报错
 * （不弹空、不重试刷屏）；轮询间隔 10 秒；轮询是串行的（上一轮结算才排
 * 下一轮），从构造上杜绝重叠请求——没有 stale 响应，就没有「丢弃谁/提前
 * 报谁」的一整类诚实性问题；世代号不需要。
 */

import { useEffect, useRef, useState } from "react"
import { ReportCallout, ReportPage, ReportSection } from "./report-page"

import {
  createFsRunEventLedgerStoreDeps,
  loadRunEventLedgerStore,
  loadTraceSnapshot,
  type RunEvent,
  type RunEventLedgerStoreDeps,
  type TraceEntry,
} from "@/lib/novel"
import { useActivityStore, type ActivityItem } from "@/stores/activity-store"
import { toErrorMessage } from "@/lib/utils"

export interface LiveExecutionViewProps {
  /** 项目磁盘路径（content-area 传 project.path，不是 UUID；UUID 读不到账本）。 */
  readonly projectPath: string
  /** 显式注入账本事件（测试；优先于磁盘装载）。 */
  readonly ledgerEvents?: readonly RunEvent[] | null
  /** 显式注入轨迹条目（测试；优先于磁盘装载）。 */
  readonly traceEntries?: readonly TraceEntry[] | null
  /** 显式注入内存活动（测试；缺省订阅 activity-store 实时活动）。 */
  readonly activities?: readonly ActivityItem[] | null
  /** deps 注入（jsdom 测试；缺省生产 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
  /** 轮询间隔毫秒（测试可调小；预设 10 秒）。 */
  readonly pollMs?: number
}

const DEFAULT_POLL_MS = 10_000

/** 最近事件流上限（账本 seq 升序，取尾部 30 条）。 */
const MAX_RECENT_EVENTS = 30

export function LiveExecutionView({
  projectPath,
  ledgerEvents,
  traceEntries,
  activities,
  deps,
  pollMs = DEFAULT_POLL_MS,
}: LiveExecutionViewProps) {
  const [events, setEvents] = useState<readonly RunEvent[] | null>(ledgerEvents ?? null)
  const [entries, setEntries] = useState<readonly TraceEntry[] | null>(traceEntries ?? null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 有无成功写入过数据 / 连续失败轮数（跨轮询累积，切项目重置）。
  // ready 的诚实规则：只在「成功写入」或「失败已成定局」（首轮失败、
  // 连败且无数据）时离开 loading。轮询是串行的（上一轮结算才排下一轮），
  // 从构造上杜绝重叠请求——没有 stale 响应，就没有「丢弃谁/提前报谁」的
  // 一整类诚实性问题；世代号不需要。
  const hasDataRef = useRef(false)
  const failStreakRef = useRef(0)

  // 内存活动永远实时订阅；显式注入（测试）优先于 store。
  const storeItems = useActivityStore((state) => state.items)
  const liveActivities = activities ?? storeItems

  useEffect(() => {
    if (ledgerEvents !== undefined || traceEntries !== undefined || activities !== undefined) {
      // 测试注入路径：prop 变更即同步，不走磁盘。
      if (ledgerEvents !== undefined) setEvents(ledgerEvents)
      if (traceEntries !== undefined) setEntries(traceEntries)
      setReady(true)
      return
    }
    // 切项目即重置：旧项目的实况不许残留，新一轮装载前回到 loading。
    setEvents(null)
    setEntries(null)
    setLoadError(null)
    setReady(false)
    hasDataRef.current = false
    failStreakRef.current = 0
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const storeDeps = deps ?? createFsRunEventLedgerStoreDeps()
    // 串行轮询：结算后才排下一轮，请求永不重叠（慢读只会推迟下一轮，
    // 不会被超车作废——每轮成功都写入，不存在永久 loading）。
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
        // 错误文案只在失败已成定局时出现：首轮失败立刻报（空态＋错
        // 误同现）；有旧数据时后续失败只添错误条、不清空实况；首轮悬挂
        // 时无任何失败可报（串行链下后轮尚未开火），保持 loading。
        // 无重叠请求，error 与 loading 不可能并存，也不会有过期错误覆盖新数据。
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
  }, [projectPath, ledgerEvents, traceEntries, activities, deps, pollMs])

  const running = liveActivities.filter((item) => item.status === "running")
  const loadedEvents = events ?? []
  const recentEvents =
    loadedEvents.length > MAX_RECENT_EVENTS
      ? loadedEvents.slice(loadedEvents.length - MAX_RECENT_EVENTS)
      : loadedEvents
  const loadedEntries = entries ?? []
  const isEmpty = running.length === 0 && recentEvents.length === 0 && loadedEntries.length === 0

  return (
    <ReportPage
      testId="live-execution-view"
      title="AI 实况"
      description="只读显示运行中的活动、最近事件和轨迹。没有这些记录时保持空态，不编造运行状态。"
    >
      {loadError ? (
        <ReportCallout testId="live-load-error" tone="error">
          实况装载失败（保留上次数据）：{loadError}
        </ReportCallout>
      ) : null}
      {!ready ? (
        <p data-testid="live-view-loading" className="text-sm text-muted-foreground">
          实况装载中…
        </p>
      ) : isEmpty ? (
        <ReportSection title="下一步">
          <p className="text-base font-medium">现在没有正在跑的事。有运行之后，活动、事件和轨迹会出现在这里。</p>
          <ReportCallout testId="live-empty" tone="neutral">
            暂无运行中的活动、事件与轨迹
          </ReportCallout>
        </ReportSection>
      ) : (
        <>
          <ReportSection title="下一步">
            <p className="text-base font-medium text-foreground">
              {running.length > 0 ? `${running.length} 个活动正在运行。先看运行中的，再看最近事件。` : "当前没有正在运行的活动。下面只留已经发生的事件和轨迹。"}
            </p>
          </ReportSection>
          {running.length > 0 ? (
            <ReportSection testId="live-running" title="运行中活动">
              <ul className="space-y-1">
                {running.map((item) => (
                  <li key={item.id} data-testid="live-running-item" className="text-sm">
                    <span className="font-medium">{item.title}</span>
                    <span className="text-muted-foreground">（{item.type}）</span>
                    {item.detail ? <span className="text-muted-foreground">：{item.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </ReportSection>
          ) : null}
          {recentEvents.length > 0 ? (
            <ReportSection testId="live-events" title="最近事件">
              <ul className="space-y-1">
                {recentEvents.map((event) => (
                  <li key={event.eventId} data-testid="live-event-item" className="text-sm">
                    <span className="font-medium">{event.kind}</span>
                    <span className="text-muted-foreground"> / {event.actor} / {event.ts}</span>
                  </li>
                ))}
              </ul>
            </ReportSection>
          ) : null}
          {loadedEntries.length > 0 ? (
            <ReportSection testId="live-trace" title="轨迹">
              <ul className="space-y-1">
                {loadedEntries.map((entry) => (
                  <li key={entry.callId} data-testid="live-trace-item" className="text-sm">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-muted-foreground">
                      {" "}/ {entry.status}
                      {entry.durationMs !== undefined ? ` / ${entry.durationMs}ms` : " / 进行中"}
                    </span>
                    {entry.error ? <span className="text-destructive">：{entry.error}</span> : null}
                  </li>
                ))}
              </ul>
            </ReportSection>
          ) : null}
        </>
      )}
    </ReportPage>
  )
}
