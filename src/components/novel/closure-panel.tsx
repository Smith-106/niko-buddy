import { useEffect, useState } from "react"
import { Network } from "lucide-react"

import { normalizePath } from "@/lib/path-utils"
import {
  loadClosureProjection,
  projectClosureState,
  type ClosureKind,
  type ClosureProjection,
  type ClosureProjectionLoader,
  type ClosureRow,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/**
 * Closure 级叙事结构面板（**只读**）。三个结构面：信息差 / 世界事件 / 涟漪。
 *
 * 真源（经 `@/lib/novel` barrel 进入 —— boundaries 门禁禁止深导入）：
 * `.novel/narrative-state.json`（信息差 + 故事时间级世界事件 + 涟漪）与
 * `.novel/timeline.json`（章级世界事件）。**零新真源**：本组件不写盘、不建状态、
 * 不调 LLM；所有行与计数都来自 projection（不硬编码）。
 *
 * 缺真源处渲染显式中文 N/A（文案写在组件里，不改 `src/i18n/*`）。
 */
export interface ClosurePanelProps {
  /** 注入投影（测试可替换）；给了它就不再读盘。 */
  readonly projection?: ClosureProjection
  /** 装载器（缺省走真实 loader：读既有 `.novel/` 真源）。 */
  readonly loader?: ClosureProjectionLoader
}

const KIND_LABEL: Record<ClosureKind, string> = {
  "info-gap": "信息差",
  "world-event": "世界事件",
  ripple: "涟漪",
}

/** 结构面区块（内部组件，不导出：公开面只留 ClosurePanel）。 */
function ClosureSection({
  kind,
  rows,
  emptyText,
}: {
  readonly kind: ClosureKind
  readonly rows: readonly ClosureRow[]
  readonly emptyText: string
}) {
  return (
    <div data-testid={`closure-panel-section-${kind}`} className="flex flex-col gap-1">
      <p className="text-[10px] font-medium text-muted-foreground">
        {`${KIND_LABEL[kind]} · ${rows.length} 行`}
      </p>
      {rows.length === 0 ? (
        <p data-testid={`closure-panel-empty-${kind}`} className="text-xs text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid={`closure-row-${row.id}`}
              className="rounded border border-border px-2 py-1"
            >
              <p className="text-xs font-medium text-foreground">{row.label}</p>
              <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                <li data-testid={`closure-na-detail-${row.id}`}>
                  {row.detail === null ? "N/A：详情（该真源无详情文本，不编造）" : row.detail}
                </li>
                <li data-testid={`closure-na-chapter-${row.id}`}>
                  {row.chapterNumber === null
                    ? "N/A：章号（该真源不含章号字段，不写 0）"
                    : `第 ${row.chapterNumber} 章`}
                </li>
                <li data-testid={`closure-na-storytime-${row.id}`}>
                  {row.storyTime === null
                    ? "N/A：故事时间（该真源不含故事时间字段）"
                    : `故事时间 ${row.storyTime}`}
                </li>
                <li data-testid={`closure-na-modality-${row.id}`}>
                  {row.modality === null
                    ? "N/A：模态（该真源不含 fact/belief/hypothesis）"
                    : `模态 ${row.modality}`}
                </li>
                <li>{`来源 ${row.source}`}</li>
                {row.knownCount !== null && row.unknownCount !== null ? (
                  <li>{`已知 ${row.knownCount} 人 · 未知 ${row.unknownCount} 人 · 关联 id ${row.relatedIds.length} 个`}</li>
                ) : null}
                {row.consequenceCount !== null ? (
                  <li>
                    {`下游 ${row.consequenceCount} 个事件${
                      row.relatedIds.length > 0 ? `：${row.relatedIds.join(" ")}` : ""
                    }`}
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ClosurePanel({ projection, loader = loadClosureProjection }: ClosurePanelProps) {
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [loaded, setLoaded] = useState<ClosureProjection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 注入投影优先：不读盘，也不被 loader/项目切换打扰。
    if (projection) return
    if (!project) {
      // 无项目 = 空真源：不触发 loader，直接投影空态（下面逐条 N/A）。
      setLoaded(projectClosureState())
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    // 换项目先清空：否则旧项目的行会挂在新项目下面（陈旧数据 = 撒谎）。
    setLoaded(null)
    setLoading(true)
    setError(null)
    void loader(normalizePath(project.path))
      .then((next) => {
        if (!cancelled) setLoaded(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 读失败按空真源渲染 + 显式错误，不把「读不到」说成「没有数据」。
        setLoaded(projectClosureState())
        setError(toErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projection, loader, project, dataVersion])

  const resolved = projection ?? loaded ?? projectClosureState()
  const pending = !projection && project !== null && loading && loaded === null
  const total = resolved.infoGaps.length + resolved.worldEvents.length + resolved.ripples.length

  return (
    <section data-testid="closure-panel" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-foreground">
        <Network className="h-4 w-4" />
        Closure 级叙事结构面（只读）
      </h3>
      <p className="text-[10px] text-muted-foreground" data-testid="closure-panel-scope">
        {`信息差 ${resolved.infoGaps.length} 行 · 世界事件 ${resolved.worldEvents.length} 行 · 涟漪 ${resolved.ripples.length} 行 · 合计 ${total} 行`}
      </p>
      <p className="text-[10px] text-muted-foreground" data-testid="closure-panel-boundary">
        零新真源：只读 .novel/narrative-state.json 与 .novel/timeline.json，不写盘、不造字段；涟漪沿 events[].causedBy
        派生直接下游，不做传递闭包。缺真源处显式中文 N/A。
      </p>

      {!projection && project === null ? (
        <p className="text-xs text-muted-foreground" data-testid="closure-panel-no-project">
          当前没有打开的项目：按空真源渲染（计数为 0，缺真源逐条 N/A）。
        </p>
      ) : null}

      {error !== null ? (
        <p className="text-xs text-destructive" data-testid="closure-panel-error">
          {`读取真源失败：${error}（按空真源渲染，不伪装成有数据）`}
        </p>
      ) : null}

      {pending ? (
        <p className="text-xs text-muted-foreground" data-testid="closure-panel-loading">
          正在读取真源…（未拿到数据前不预填 0 行）
        </p>
      ) : (
        <>
          {total === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="closure-panel-empty">
              三个结构面都没有行：真源为空或无数据（不造 0 行假装统计过）。
            </p>
          ) : null}

          <ClosureSection
            kind="info-gap"
            rows={resolved.infoGaps}
            emptyText="没有信息差行：narrative-state 的 declarations 为空（无人知道什么可言）。"
          />
          <ClosureSection
            kind="world-event"
            rows={resolved.worldEvents}
            emptyText="没有世界事件行：timeline 的 entries 与 narrative-state 的 events 都为空。"
          />
          <ClosureSection
            kind="ripple"
            rows={resolved.ripples}
            emptyText="没有涟漪行：事件日志里没有任何 causedBy 因果链（无下游后果可派生）。"
          />

          <div className="flex flex-col gap-0.5">
            <p className="text-[10px] font-medium text-muted-foreground">
              以下真源缺失或无数据，故显式 N/A：
            </p>
            {resolved.missingSources.length === 0 ? (
              <p className="text-[10px] text-muted-foreground" data-testid="closure-na-source-none">
                无缺失真源：三个结构面都有真源。
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                {resolved.missingSources.map((reason, index) => (
                  <li key={reason} data-testid={`closure-na-source-${index}`}>
                    {`N/A：${reason}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
