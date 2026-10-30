// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * pipeline-motion-view.tsx — 「管线动态」视图（只读接线层）。
 *
 * 只做一件事：只读装载运行事件账本（run-events.jsonl）与主控轨迹快照，
 * 交给 PipelineMotionPanel 做纯投影渲染。本视图不写任何文件。
 *
 * 失败口径：装载失败保留旧数据并显式报错（不弹空、不重试刷屏）；
 * 轮询间隔 10 秒，读到新事件才重渲染（投影层是纯函数，同输入同输出）。
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
  /** 项目磁盘路径（content-area 传 project.path，不是 UUID；UUID 读不到账本）。 */
  readonly projectPath: string
  /** 显式注入账本（测试；优先于磁盘装载）。 */
  readonly ledgerEvents?: readonly RunEvent[] | null
  /** 显式注入轨迹条目（测试；优先于磁盘装载）。 */
  readonly traceEntries?: readonly TraceEntry[] | null
  /** deps 注入（jsdom 测试；缺省生产 deps）。 */
  readonly deps?: RunEventLedgerStoreDeps
  /** 轮询间隔毫秒（测试可调小；预设 10 秒）。 */
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
  // 有无成功写入过数据 / 连续失败轮数（跨轮询累积，切项目重置）。
  // ready 的诚实规则：只在「成功写入」或「失败已成定局」（首轮失败、
  // 连败且无数据）时离开 loading。轮询是串行的（上一轮结算才排下一轮），
  // 从构造上杜绝重叠请求——没有 stale 响应，就没有「丢弃谁/提前报谁」的
  // 一整类诚实性问题；世代号不需要。
  const hasDataRef = useRef(false)
  const failStreakRef = useRef(0)

  useEffect(() => {
    if (ledgerEvents !== undefined || traceEntries !== undefined) {
      // 测试注入路径：prop 变更即同步，不走磁盘。
      if (ledgerEvents !== undefined) setEvents(ledgerEvents)
      if (traceEntries !== undefined) setEntries(traceEntries)
      setReady(true)
      return
    }
    // 切项目即重置：旧项目的管线不许残留，新一轮装载前回到 loading。
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
        // 误同现）；有旧数据时后续失败只添错误条、不清空管线；首轮悬挂
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
  }, [projectPath, ledgerEvents, traceEntries, deps, pollMs])

  return (
    <div data-testid="pipeline-motion-view" className="space-y-2">
      {loadError ? (
        <p data-testid="motion-load-error" className="text-xs text-destructive">
          事件装载失败（保留上次数据）：{loadError}
        </p>
      ) : null}
      {!ready ? (
        <p data-testid="motion-view-loading" className="text-xs text-muted-foreground">
          管线事件装载中…
        </p>
      ) : (
        <PipelineMotionPanel
          input={{ events: events ?? [], traceEntries: entries ?? [] }}
        />
      )}
    </div>
  )
}
