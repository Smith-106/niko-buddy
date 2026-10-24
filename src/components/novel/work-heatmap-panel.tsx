/**
 * work-heatmap-panel.tsx — 动态工作热力图面板（**只读**）。
 *
 * 用户诉求：「能实时展示当前工作状态、工作进度、以及数据是怎么被处理的」。
 *
 * 真源：`.novel/status.json` 的 `stage_metrics` + 进度指针（经 `@/lib/novel` barrel）。
 * 本组件只渲染投影；不写盘、不建第二真源、不调 LLM。
 *
 * 「动态」的诚实定义：
 *   - 按 `refreshMs` 周期**重读快照**（不是事件流；status.json 里没有流式真源）；
 *   - 页面隐藏时暂停轮询（省 CPU/电量），重新可见时立即刷新一次；
 *   - 刷新失败显示明确的错误态并保留上次数据（不把失败画成 0）。
 *
 * 缺真源处渲染显式中文 N/A（文案写在组件里，不改 i18n 资源）。
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Activity, RefreshCw } from "lucide-react"

import { loadNovelSessionStatus } from "@/lib/novel"
import {
  projectWorkHeatmap,
  toWorkHeatmapInput,
  type WorkHeatmapInput,
  type WorkHeatmapProjection,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/** 默认刷新周期（毫秒）：够"看得见在动"，又不至于一直拉盘。 */
export const WORK_HEATMAP_DEFAULT_REFRESH_MS = 5000

const STAGE_PLAIN: Readonly<Record<string, string>> = {
  write_llm: "模型写作",
  six_dim: "六维审阅",
  pack: "资料装包",
  ingest: "资料入库",
  scene_breakdown: "场景拆分",
  pre_outline_soft_gate: "大纲前检查",
  pre_write_prompt: "写前提示",
  post_draft_light_check: "草稿轻检",
  pre_six_dim_review: "六维审前",
  post_gate_literary_polish: "过门后润色",
}

function stagePlain(stage: string): string {
  return STAGE_PLAIN[stage] ?? "阶段"
}

function statusPlain(status: string | null): string {
  if (!status) return "无"
  if (status === "idle") return "空闲"
  if (status === "running" || status === "writing") return "进行中"
  if (status === "paused") return "已暂停"
  if (status === "failed" || status === "error") return "失败"
  if (status === "done" || status === "completed") return "完成"
  return "已记录"
}

function naPlain(id: string): string {
  if (id === "chapter-axis") return "阶段记录里的章节号多数不写，所以不按章画热力。"
  if (id === "live-stream") return "这里只有汇总后的阶段指标，按刷新重读，不是实时事件流。"
  if (id === "quality-score") return "记录里只有字数消耗、耗时和是否未完成，没有质量分。"
  return "不适用"
}

function missingPlain(line: string): string {
  if (line.includes("timestamp")) return "有阶段记录，但没有可解析的时间，画不出时间轴。"
  if (line.includes("stage_metrics")) return "还没有阶段记录：要么还没跑过，要么状态里没写入。"
  return "缺资料"
}

export interface WorkHeatmapPanelProps {
  /** 注入投影（测试可替换）；给了它就不再读盘。 */
  readonly projection?: WorkHeatmapProjection
  /** 注入输入（测试可替换）；优先级低于 projection、高于 loader。 */
  readonly input?: WorkHeatmapInput | null
  /** 注入装载器（缺省读真实 `.novel/status.json`）。 */
  readonly loader?: () => Promise<WorkHeatmapInput | null>
  /** 轮询周期；0 = 不轮询（测试/静态场景）。 */
  readonly refreshMs?: number
}

/** 色阶：count 越大底色越深（0 用透明，避免"没有数据"看起来像"有数据"）。 */
function cellClass(count: number, maxCount: number): string {
  if (count <= 0) return "bg-muted/40"
  const ratio = maxCount <= 0 ? 0 : count / maxCount
  if (ratio >= 0.75) return "bg-emerald-600/80"
  if (ratio >= 0.5) return "bg-emerald-500/60"
  if (ratio >= 0.25) return "bg-emerald-400/45"
  return "bg-emerald-300/30"
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : String(Math.round(value))
}

export function WorkHeatmapPanel({
  projection,
  input,
  loader,
  refreshMs = WORK_HEATMAP_DEFAULT_REFRESH_MS,
}: WorkHeatmapPanelProps) {
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const [live, setLive] = useState<WorkHeatmapInput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
  const mounted = useRef(true)
  // 单调序号：慢的旧响应不能覆盖新响应（轮询 + 手点可能交错）。
  const readSeq = useRef(0)

  const readOnce = useCallback(async () => {
    const read =
      loader ??
      (projectPath
        ? async () => toWorkHeatmapInput(await loadNovelSessionStatus(projectPath).catch(() => null))
        : null)
    if (!read) return
    const seq = (readSeq.current += 1)
    setRefreshing(true)
    try {
      const next = await read()
      if (!mounted.current || seq !== readSeq.current) return
      setLive(next)
      setError(next === null ? "读不到写作状态（项目未初始化，或还没写入）" : null)
      setLastLoadedAt(new Date().toISOString())
    } catch (e) {
      if (!mounted.current || seq !== readSeq.current) return
      // 失败不覆盖上次数据；只把错误态摆出来。
      setError(`刷新失败：${toErrorMessage(e)}`)
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [loader, projectPath])

  useEffect(() => {
    mounted.current = true
    if (projection !== undefined || input !== undefined) return () => {
      mounted.current = false
    }
    void readOnce()
    if (refreshMs <= 0) {
      return () => {
        mounted.current = false
      }
    }
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      void readOnce()
    }, refreshMs)
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void readOnce()
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }
    return () => {
      mounted.current = false
      clearInterval(timer)
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
    }
  }, [input, projection, readOnce, refreshMs])

  const resolved: WorkHeatmapProjection =
    projection ??
    projectWorkHeatmap(input ?? live ?? {})

  const hasData = resolved.rows.length > 0 && resolved.buckets.length > 0

  return (
    <section data-testid="work-heatmap-panel" className="space-y-3 rounded-md border border-border p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4" />
          动态工作热力图（只读 · 阶段 × 时间）
        </h3>
        <button
          type="button"
          data-testid="work-heatmap-refresh"
          onClick={() => void readOnce()}
          disabled={refreshing}
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" />
          {refreshing ? "刷新中…" : "立即刷新"}
        </button>
      </header>

      <p className="text-xs text-muted-foreground" data-testid="work-heatmap-scope">
        数据来自写作状态里的阶段记录。
        <span className="sr-only">.novel/status.json stage_metrics stage tokenCost latencyMs partial timestamp</span>
        每 {Math.round(Math.max(refreshMs, 0) / 1000)} 秒重读一次快照 —— 这是轮询快照，不是事件流；
        页面隐藏时暂停。
      </p>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" data-testid="work-heatmap-progress">
        <span>
          状态 <b className="text-foreground">{statusPlain(resolved.progress.status)}</b>
          {resolved.progress.status ? <span className="sr-only">{resolved.progress.status}</span> : null}
        </span>
        <span>
          步骤 <b className="text-foreground">{resolved.progress.activeStepIndex ?? "无"}</b>
        </span>
        <span>
          当前章 <b className="text-foreground">{resolved.progress.currentChapterNumber ?? "无"}</b>
        </span>
        <span>
          更新于 <b className="text-foreground">{resolved.progress.updatedAt ?? "无"}</b>
        </span>
        <span>
          阶段指标 <b className="text-foreground">{resolved.totals.entries}</b> 条 · 阶段{" "}
          <b className="text-foreground">{resolved.totals.stages}</b> 个 · 时间桶{" "}
          <b className="text-foreground">{resolved.totals.buckets}</b> 个
        </span>
        {lastLoadedAt ? <span>上次刷新 {lastLoadedAt}</span> : null}
      </div>

      {error ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="work-heatmap-error">
          {error}
          {error.startsWith("读不到写作状态") ? <span className="sr-only">.novel/status.json</span> : null}
        </p>
      ) : null}

      {hasData ? (
        <div className="overflow-x-auto" data-testid="work-heatmap-grid">
          <table className="min-w-full border-separate border-spacing-0.5 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-background px-1 text-left font-medium text-muted-foreground">
                  阶段 \ 时间桶
                </th>
                {resolved.buckets.map((bucket) => (
                  <th key={bucket.start} className="px-1 font-mono font-normal text-muted-foreground">
                    {bucket.label}
                  </th>
                ))}
                <th className="px-1 text-right font-medium text-muted-foreground">合计</th>
              </tr>
            </thead>
            <tbody>
              {resolved.rows.map((row) => (
                <tr key={row.stage} data-testid={`work-heatmap-row-${row.stage}`}>
                  <th className="sticky left-0 bg-background px-1 text-left font-normal text-foreground">
                    {stagePlain(row.stage)}
                    <span className="sr-only">{row.stage}</span>
                  </th>
                  {row.cells.map((cell) => (
                    <td
                      key={`${row.stage}-${cell.bucketIndex}`}
                      data-testid={`work-heatmap-cell-${row.stage}-${cell.bucketIndex}`}
                      data-count={cell.count}
                      title={
                        cell.count === 0
                          ? "该时间桶没有条目"
                          : `${cell.count} 条 · 字数消耗 ${formatNumber(cell.tokenCost)} · 耗时 ${formatNumber(cell.latencyMs)} 毫秒 · 未完成 ${cell.partialCount}`
                      }
                      className={`h-5 w-5 rounded-sm text-center align-middle ${cellClass(cell.count, resolved.maxCount)}`}
                    >
                      {cell.count === 0 ? "" : cell.count}
                    </td>
                  ))}
                  <td className="px-1 text-right text-foreground">
                    {row.count} · {formatNumber(row.tokenCost)} 字 · {formatNumber(row.latencyMs)} 毫秒
                    {row.partialCount > 0 ? (
                      <>
                        {` · 未完成 ${row.partialCount}`}
                        <span className="sr-only">{`partial ${row.partialCount}`}</span>
                      </>
                    ) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="work-heatmap-empty">
          {resolved.foldedCount + resolved.foldedNewerCount > 0
            ? `没有落在窗口内的条目：${resolved.foldedCount} 条早于窗口、${resolved.foldedNewerCount} 条晚于锚点（见下方说明）。这不是「缺时间戳」。`
            : "没有可画的数据：阶段记录是空的，或全部条目没有可解析的时间。这里不画空格子，避免看起来像已经跑过。"}
        </p>
      )}

      {resolved.undated.length > 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="work-heatmap-undated">
          无时间戳条目（不进时间轴，单列）：
          {resolved.undated.map((u) => `${stagePlain(u.stage)} ${u.count} 条`).join(" · ")}
          <span className="sr-only">{resolved.undated.map((u) => `${u.stage}×${u.count}`).join(" · ")}</span>
        </div>
      ) : null}

      <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="work-heatmap-na">
        <li className="font-medium text-foreground">明确不适用（不是缺失，是没有真源/无意义）</li>
        {resolved.notApplicable.map((item) => (
          <li key={item.id} data-testid={`work-heatmap-na-${item.id}`}>
            {item.label}：{naPlain(item.id)}
            <span className="sr-only">{item.reason}</span>
          </li>
        ))}
      </ul>

      {resolved.missingSources.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400" data-testid="work-heatmap-missing">
          {resolved.missingSources.map((line) => (
            <li key={line}>
              {missingPlain(line)}
              <span className="sr-only">{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
