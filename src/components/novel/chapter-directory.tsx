import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookText, CircleAlert, Loader2 } from "lucide-react"
import { fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { countChapterBodyWords } from "@/lib/chapter-word-count"
import {
  findChapterFileByNumber,
  listSnapshots,
  loadSnapshot,

  type ChapterSnapshot,
} from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { cn } from "@/lib/utils"

/**
 * 章节目录条目的三列来源（grok 计划审查要求：多源只读拼接，缺列写 N/A，禁止另建章节索引）：
 * - 章号：`.novel/snapshots/*.snapshot.json` 的文件名（listSnapshots）
 * - 标题：快照 `chapterTitle`（可选字段，旧数据可能没有 → N/A）
 * - 字数：正文文件按 countChapterBodyWords 现算（读不到 → N/A）
 * 本组件不写任何文件，不新增真源。
 */
export interface ChapterDirectoryRow {
  chapterNumber: number
  /** 负数条目 = 大纲快照（outline-00N），与正文章节区分展示。 */
  isOutline: boolean
  title: string | null
  wordCount: number | null
  /** 能定位到正文文件时才可点开。 */
  filePath: string | null
}

export type ChapterDirectoryLoader = (projectPath: string) => Promise<ChapterDirectoryRow[]>

/** 默认装载：快照目录 + 正文文件，全部只读，逐行容错（单条失败只影响该行）。 */
export const loadChapterDirectory: ChapterDirectoryLoader = async (projectPath) => {
  // failLoud：目录不存在 → 空态；权限/IO 失败必须进错误态，不得伪装成「暂无章节」。
  const numbers = await listSnapshots(projectPath, { failLoud: true })
  const rows = await Promise.all(
    numbers.map(async (chapterNumber): Promise<ChapterDirectoryRow> => {
      const isOutline = chapterNumber < 0
      let title: string | null = null
      let snapshot: ChapterSnapshot | null = null
      try {
        snapshot = await loadSnapshot(projectPath, chapterNumber)
      } catch {
        snapshot = null
      }
      if (snapshot?.chapterTitle && snapshot.chapterTitle.trim().length > 0) {
        title = snapshot.chapterTitle.trim()
      }
      let wordCount: number | null = null
      let filePath: string | null = null
      try {
        filePath = await findChapterFileByNumber(projectPath, chapterNumber)
      } catch {
        filePath = null
      }
      if (filePath) {
        try {
          const exists = await fileExists(filePath)
          if (exists) {
            const body = await readFile(filePath)
            wordCount = countChapterBodyWords(body)
          }
        } catch {
          wordCount = null
        }
      }
      return { chapterNumber, isOutline, title, wordCount, filePath }
    }),
  )
  return rows
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
  const [rows, setRows] = useState<ChapterDirectoryRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const projectPath = project ? normalizePath(project.path) : null

  useEffect(() => {
    if (!projectPath) {
      setRows(null)
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
        setRows(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRows(null)
        setError(err instanceof Error ? err.message : String(err))
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

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3" data-testid="chapter-directory">
      <div className="flex items-center gap-2">
        <BookText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("novel.chapterDirectory.title")}</h2>
      </div>

      {!projectPath ? (
        <p className="text-[11px] text-muted-foreground" data-testid="chapter-directory-no-project">
          {t("novel.chapterDirectory.noProject")}
        </p>
      ) : loading ? (
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="chapter-directory-loading">
          <Loader2 className="h-3 w-3 animate-spin" />
          …
        </p>
      ) : error ? (
        <p className="flex items-center gap-1 text-[11px] text-destructive" data-testid="chapter-directory-error">
          <CircleAlert className="h-3 w-3 shrink-0" />
          {t("novel.chapterDirectory.loadFailed")}: {error}
        </p>
      ) : !rows || rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="chapter-directory-empty">
          {t("novel.chapterDirectory.empty")}
        </p>
      ) : (
        <>
          <p className="text-[10px] text-muted-foreground" data-testid="chapter-directory-total">
            {t("novel.chapterDirectory.total", { count: rows.length })}
          </p>
          <table className="w-full text-left text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colChapter")}</th>
                <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colTitle")}</th>
                <th className="py-1 pr-2 font-normal">{t("novel.chapterDirectory.colWords")}</th>
              </tr>
            </thead>
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
                  <td className="py-1 pr-2" data-testid={`chapter-directory-title-${row.chapterNumber}`}>
                    {row.title ?? t("novel.chapterDirectory.na")}
                  </td>
                  <td className="py-1 pr-2 tabular-nums" data-testid={`chapter-directory-words-${row.chapterNumber}`}>
                    {row.wordCount === null ? t("novel.chapterDirectory.na") : row.wordCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-muted-foreground" data-testid="chapter-directory-hint">
            {t("novel.chapterDirectory.hint")}
          </p>
        </>
      )}
    </div>
  )
}
