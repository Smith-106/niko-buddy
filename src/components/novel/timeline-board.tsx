import { useTranslation } from "react-i18next"
import type { TimelineEntry } from "@/lib/novel"

/**
 * 时间线可视化板（只读、零新真源、零新依赖）。
 *
 * 真源约束：`TimelineEntry` 只有 `chapterNumber` + `event`（`lib/novel/timeline.ts`），
 * 没有类型/角色/故事线/时长字段 → 本组件**只做**「章节序刻度 + 每章一条泳道 + 事件点」，
 * 并显式标注做不到的部分（N/A），不做故事线分道、不插值伪造连续时间。
 */
export interface TimelineBoardProps {
  entries: readonly TimelineEntry[]
  /**
   * 是否有**事件被范围筛选隐藏**。筛选后为空 ≠ 没有事件：必须走不同文案，
   * 否则会把「筛掉了」说成「尚未入库」。
   */
  filteredOut?: boolean
  /** 章节轴上的全部刻度（缺章留空位，不补点）。缺省用事件覆盖的章节。 */
  ticks?: readonly number[]
  /** 点击某章（可选；打开正文）。 */
  onOpenChapter?: (chapterNumber: number) => void
}

interface Lane {
  chapterNumber: number
  events: string[]
}

/** 纯函数：按章分组并按章号升序（同章事件保持输入顺序）。 */
export function groupEntriesByChapter(entries: readonly TimelineEntry[]): Lane[] {
  const map = new Map<number, string[]>()
  for (const entry of entries) {
    const list = map.get(entry.chapterNumber)
    if (list) list.push(entry.event)
    else map.set(entry.chapterNumber, [entry.event])
  }
  return [...map.entries()]
    .map(([chapterNumber, events]) => ({ chapterNumber, events }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/**
 * 章节轴刻度：连续覆盖 min..max（缺章留空位）。
 * 跨度 > 400 时退化为「有事件的章号集合」，此时**柱距不再等于章距**，必须显式告知（见 folded）。
 */
export function buildTicks(entries: readonly TimelineEntry[]): number[] {
  const chapters = entries.map((e) => e.chapterNumber).filter((n) => Number.isFinite(n))
  if (chapters.length === 0) return []
  const min = Math.min(...chapters)
  const max = Math.max(...chapters)
  if (max - min > 400) return [...new Set(chapters)].sort((a, b) => a - b)
  const out: number[] = []
  for (let n = min; n <= max; n += 1) out.push(n)
  return out
}

export function TimelineBoard({ entries, ticks, filteredOut = false, onOpenChapter }: TimelineBoardProps) {
  const { t } = useTranslation()
  const lanes = groupEntriesByChapter(entries)
  const axis = ticks ? [...ticks] : buildTicks(entries)
  const laneByChapter = new Map(lanes.map((lane) => [lane.chapterNumber, lane.events]))

  if (entries.length === 0) {
    // 两种空必须分开：①筛掉了 ②本来就没有
    return (
      <div className="rounded-lg border p-3" data-testid="timeline-board">
        <p
          className="text-xs text-muted-foreground"
          data-testid={filteredOut ? "timeline-board-filtered-empty" : "timeline-board-empty"}
        >
          {filteredOut ? t("novel.timelineBoard.filteredEmpty") : t("novel.timelineBoard.empty")}
        </p>
      </div>
    )
  }

  const maxEvents = Math.max(...lanes.map((lane) => lane.events.length))
  // 刻度被折叠（跨度 > 400）时柱距不等于章距，必须标注
  const chapters = entries.map((e) => e.chapterNumber).filter((n) => Number.isFinite(n))
  const folded =
    !ticks && chapters.length > 0 && Math.max(...chapters) - Math.min(...chapters) > 400

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid="timeline-board">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">{t("novel.timelineBoard.title")}</h3>
        <span className="text-xs text-muted-foreground" data-testid="timeline-board-summary">
          {t("novel.timelineBoard.summary", { chapters: lanes.length, events: entries.length })}
        </span>
      </div>

      {/* 章节序刻度：只表示章号先后，不代表真实时间间隔 */}
      <div className="flex items-end gap-0.5 overflow-x-auto pb-1" data-testid="timeline-board-axis">
        {axis.map((chapter) => {
          const count = laneByChapter.get(chapter)?.length ?? 0
          const heightPct = Math.max(20, Math.round((count / maxEvents) * 100))
          return (
            <button
              key={chapter}
              type="button"
              data-testid={`timeline-board-tick-${chapter}`}
              data-count={count}
              title={t("novel.timelineBoard.tickHint", { chapter, count })}
              onClick={() => (count > 0 ? onOpenChapter?.(chapter) : undefined)}
              className="flex w-4 shrink-0 flex-col items-center justify-end gap-0.5"
            >
              {count === 0 ? (
                // 空刻度不画柱：只在可见位置标 N/A，避免被读成「该章有一点时间线」
                <span
                  className="text-xs leading-none text-muted-foreground"
                  data-testid={`timeline-board-tick-na-${chapter}`}
                >
                  {t("novel.timelineBoard.na")}
                </span>
              ) : (
                <span className="w-full rounded-t bg-accent" style={{ height: `${heightPct}%`, minHeight: 4 }} />
              )}
              <span className="text-xs tabular-nums text-muted-foreground">{chapter}</span>
            </button>
          )
        })}
      </div>

      {/* 每章一条泳道（同章事件按输入顺序列点） */}
      <ul className="flex flex-col gap-1" data-testid="timeline-board-lanes">
        {lanes.map((lane) => (
          <li
            key={lane.chapterNumber}
            className="flex items-start gap-2 text-xs"
            data-testid={`timeline-board-lane-${lane.chapterNumber}`}
          >
            <button
              type="button"
              className="w-14 shrink-0 text-left tabular-nums text-muted-foreground hover:underline"
              onClick={() => onOpenChapter?.(lane.chapterNumber)}
            >
              {t("novel.timelineBoard.chapterLabel", { chapter: lane.chapterNumber })}
            </button>
            <span className="mt-1.5 h-px flex-1 bg-border" aria-hidden />
            <span className="flex flex-wrap gap-1">
              {lane.events.map((event, index) => (
                <span
                  key={`${lane.chapterNumber}-${index}`}
                  className="rounded bg-accent/15 px-1 py-0.5 text-xs text-accent-foreground"
                  data-testid={`timeline-board-point-${lane.chapterNumber}-${index}`}
                >
                  {event}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>

      {/* 诚实性声明：真源没有这些字段，所以做不到，不是没做 */}
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="timeline-board-na">
        <li data-testid="timeline-board-na-lanes">{t("novel.timelineBoard.naThreads")}</li>
        <li data-testid="timeline-board-na-granularity">{t("novel.timelineBoard.naGranularity")}</li>
        <li data-testid="timeline-board-na-pacing">{t("novel.timelineBoard.naPacing")}</li>
        {folded ? <li data-testid="timeline-board-na-folded">{t("novel.timelineBoard.naFolded")}</li> : null}
      </ul>
    </div>
  )
}
