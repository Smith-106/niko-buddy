import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookText, CircleAlert, Loader2 } from "lucide-react"
import { fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { countChapterBodyWords } from "@/lib/chapter-word-count"
import {
  findChapterFileByNumber,
  isRichChapterTitle,
  listSnapshots,
  loadSnapshot,
  resolveChapterTitle,
  type ChapterSnapshot,
} from "@/lib/novel"
import { parseVolumeMeta, type VolumeMeta } from "@/lib/novel/volume"
import { searchWiki } from "@/lib/search"
import { parseFrontmatter } from "@/lib/frontmatter"
import { useWikiStore } from "@/stores/wiki-store"
import { cn, toErrorMessage } from "@/lib/utils"

/**
 * 章节目录条目的三列来源（grok 计划审查要求：多源只读拼接，缺列显式标注暂无，禁止另建章节索引）：
 * - 章号：`.novel/snapshots/*.snapshot.json` 的文件名（listSnapshots）
 * - 标题：快照里的富标题优先；没有则用正文 frontmatter / H1（resolveChapterTitle）。两边都没有才标暂无
 * - 字数：正文文件按 countChapterBodyWords 现算（读不到 → 暂无）
 * 本组件不写任何文件，不新增真源，不支持拖拽排序（只读表）。
 */

function filenameTitle(filePath: string | null | undefined): string {
  if (!filePath) return ""
  const stem = (filePath.split(/[/\\]/).pop() ?? "").replace(/\.md$/i, "").trim()
  return stem && isRichChapterTitle(stem) ? stem : ""
}

/** 目录标题：快照富标题优先，否则从已读正文解析，再不行用带章名的文件名。 */
export function chapterDirectoryTitle(
  snapshotTitle: string | null | undefined,
  fileContent: string | null | undefined,
  filePath: string | null | undefined,
): string | null {
  const snapshot = snapshotTitle?.trim() ?? ""
  if (snapshot && isRichChapterTitle(snapshot)) return snapshot
  const fallback = filenameTitle(filePath)
  if (fileContent && fileContent.trim()) {
    const resolved = resolveChapterTitle(fileContent, snapshot || fallback).trim()
    if (resolved) return resolved
  }
  if (snapshot) return snapshot
  return fallback || null
}

export interface ChapterDirectoryRow {
  chapterNumber: number
  /** 负数条目 = 大纲快照（outline-00N），与正文章节区分展示。 */
  isOutline: boolean
  title: string | null
  wordCount: number | null
  /** 能定位到正文文件时才可点开。 */
  filePath: string | null
}

export interface VolumeGroup {
  /** null = 未落入任何卷区间。 */
  meta: VolumeMeta | null
  rows: ChapterDirectoryRow[]
}

export interface ChapterDirectoryData {
  outlines: ChapterDirectoryRow[]
  volumes: VolumeGroup[]
}

export type ChapterDirectoryLoader = (projectPath: string) => Promise<ChapterDirectoryData>

/** 一次搜索捞取全部分卷页（失败 → 空数组降级为未分组平铺）。 */
async function loadVolumeMetas(projectPath: string): Promise<VolumeMeta[]> {
  try {
    const hits = await searchWiki(projectPath, "volume 第 卷 chapter_range")
    // PAT-IM: 独立项并行 —— 并发 readFile（Promise.all 保序回填），再按 hits 切片原序串行解析/排序。
    const volumeSlice = hits.slice(0, 24)
    const volumeContents = await Promise.all(
      volumeSlice.map((h) => readFile(h.path).then(
        (content) => ({ ok: true as const, content }),
        () => ({ ok: false as const, content: "" }),
      )),
    )
    const metas: VolumeMeta[] = []
    for (let volumeIndex = 0; volumeIndex < volumeSlice.length; volumeIndex += 1) {
      const read = volumeContents[volumeIndex]
      if (!read.ok) continue
      try {
        const { frontmatter } = parseFrontmatter(read.content)
        const meta = frontmatter ? parseVolumeMeta(frontmatter as Record<string, unknown>) : null
        if (meta) metas.push(meta)
      } catch {
        // 单卷失败不影响其他卷
      }
    }
    return metas.sort((a, b) => a.volumeNumber - b.volumeNumber)
  } catch {
    return []
  }
}

/** 纯函数：大纲轨分离 + 正文按卷区间分组（区间外 → 未分卷组）。 */
export function groupRowsByVolume(rows: ChapterDirectoryRow[], volumes: VolumeMeta[]): ChapterDirectoryData {
  const outlines = rows.filter((r) => r.isOutline)
  const groups: VolumeGroup[] = volumes.map((meta) => ({ meta, rows: [] }))
  const ungrouped: ChapterDirectoryRow[] = []
  for (const row of rows) {
    if (row.isOutline) continue
    const hit = volumes.findIndex(
      (m) =>
        m.chapterRangeStart !== undefined &&
        m.chapterRangeEnd !== undefined &&
        row.chapterNumber >= m.chapterRangeStart &&
        row.chapterNumber <= m.chapterRangeEnd,
    )
    if (hit >= 0) groups[hit].rows.push(row)
    else ungrouped.push(row)
  }
  const volumesOut = groups.filter((g) => g.rows.length > 0)
  if (ungrouped.length > 0) volumesOut.push({ meta: null, rows: ungrouped })
  return { outlines, volumes: volumesOut }
}

/** 默认装载：快照目录 + 正文文件 + 卷元数据，全部只读，逐行容错。 */
export const loadChapterDirectory: ChapterDirectoryLoader = async (projectPath) => {
  // failLoud：目录不存在 → 空态；权限/IO 失败必须进错误态，不得伪装成「暂无章节」。
  const numbers = await listSnapshots(projectPath, { failLoud: true })
  const rows = await Promise.all(
    numbers.map(async (chapterNumber): Promise<ChapterDirectoryRow> => {
      const isOutline = chapterNumber < 0
      let snapshot: ChapterSnapshot | null = null
      try {
        snapshot = await loadSnapshot(projectPath, chapterNumber)
      } catch {
        snapshot = null
      }
      let wordCount: number | null = null
      let filePath: string | null = null
      let fileContent: string | null = null
      try {
        filePath = await findChapterFileByNumber(projectPath, chapterNumber)
      } catch {
        filePath = null
      }
      if (filePath) {
        try {
          const exists = await fileExists(filePath)
          if (exists) {
            fileContent = await readFile(filePath)
            wordCount = countChapterBodyWords(fileContent)
          }
        } catch {
          wordCount = null
          fileContent = null
        }
      }
      const title = chapterDirectoryTitle(snapshot?.chapterTitle, fileContent, filePath)
      return { chapterNumber, isOutline, title, wordCount, filePath }
    }),
  )
  const metas = await loadVolumeMetas(projectPath)
  return groupRowsByVolume(rows, metas)
}

export interface ChapterDirectoryProps {
  /** 测试注入（缺省走真实快照读取）。路径一律取 store 里的 project.path。 */
  loader?: ChapterDirectoryLoader
}

export function ChapterDirectory({ loader = loadChapterDirectory }: ChapterDirectoryProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const [data, setData] = useState<ChapterDirectoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const projectPath = project ? normalizePath(project.path) : null
  const total = data ? data.outlines.length + data.volumes.reduce((n, g) => n + g.rows.length, 0) : 0

  useEffect(() => {
    if (!projectPath) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void loader(projectPath)
      .then((next) => {
        if (cancelled) return
        setData(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setData(null)
        setError(toErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loader, projectPath, dataVersion])

  const handleOpen = useCallback(
    (filePath: string | null) => {
      if (!filePath) return
      setSelectedFile(filePath)
    },
    [setSelectedFile],
  )

  const renderRows = (rows: ChapterDirectoryRow[]) => (
    <tbody>
      {rows.map((row) => (
        <tr
          key={`${row.isOutline ? "outline" : "chapter"}-${row.chapterNumber}`}
          data-testid={`chapter-directory-row-${row.chapterNumber}`}
          className={cn("border-t border-border/50", row.filePath ? "hover:bg-muted/40" : "opacity-60")}
          onClick={() => handleOpen(row.filePath)}
        >
          <td className="py-1 pr-2 tabular-nums">
            {row.isOutline ? t("novel.chapterDirectory.outline") : Math.abs(row.chapterNumber)}
          </td>
          <td
            className="max-w-40 truncate py-1 pr-2"
            title={row.title ?? undefined}
            data-testid={`chapter-directory-title-${row.chapterNumber}`}
          >
            {row.title ?? t("novel.chapterDirectory.na")}
          </td>
          <td className="py-1 pr-2 tabular-nums" data-testid={`chapter-directory-words-${row.chapterNumber}`}>
            {row.wordCount === null ? t("novel.chapterDirectory.na") : row.wordCount}
          </td>
        </tr>
      ))}
    </tbody>
  )

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3" data-testid="chapter-directory">
      <div className="flex items-center gap-2">
        <BookText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("novel.chapterDirectory.title")}</h2>
      </div>

      {!projectPath ? (
        <p className="text-xs text-muted-foreground" data-testid="chapter-directory-no-project">
          {t("novel.chapterDirectory.noProject")}
        </p>
      ) : loading ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="chapter-directory-loading">
          <Loader2 className="h-3 w-3 animate-spin" />
          …
        </p>
      ) : error ? (
        <p className="flex items-center gap-1 text-xs text-destructive" data-testid="chapter-directory-error">
          <CircleAlert className="h-3 w-3 shrink-0" />
          {t("novel.chapterDirectory.loadFailed")}: {error}
        </p>
      ) : !data || total === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="chapter-directory-empty">
          {t("novel.chapterDirectory.empty")}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="chapter-directory-total">
            {t("novel.chapterDirectory.total", { count: total })}
          </p>
          {data.outlines.length > 0 && (
            <details open data-testid="chapter-directory-outline-track">
              <summary className="cursor-pointer text-xs font-medium">大纲轨（{data.outlines.length}）</summary>
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colChapter")}</th>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colTitle")}</th>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colWords")}</th>
                  </tr>
                </thead>
                {renderRows(data.outlines)}
              </table>
            </details>
          )}
          {data.volumes.map((g) => (
            <details
              key={g.meta ? `volume-${g.meta.volumeNumber}` : "volume-ungrouped"}
              data-testid={
                g.meta ? `chapter-directory-volume-${g.meta.volumeNumber}` : "chapter-directory-volume-ungrouped"
              }
            >
              <summary className="cursor-pointer text-xs font-medium">
                {g.meta ? `第${g.meta.volumeNumber}卷 ${g.meta.title}（${g.rows.length}章）` : `未分卷（${g.rows.length}章）`}
              </summary>
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colChapter")}</th>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colTitle")}</th>
                    <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colWords")}</th>
                  </tr>
                </thead>
                {renderRows(g.rows)}
              </table>
            </details>
          ))}
          <p className="text-xs text-muted-foreground" data-testid="chapter-directory-hint">
            {t("novel.chapterDirectory.hint")}
          </p>
        </>
      )}
    </div>
  )
}
