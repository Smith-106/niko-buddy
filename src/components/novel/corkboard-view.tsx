import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, FileText, LayoutGrid, Plus, Trash2, X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { listSnapshots, loadSnapshot } from "@/lib/novel/chapter-ingest"
import { loadEmotionalArcs } from "@/lib/novel/emotional-arcs"
import { countChapterBodyWords } from "@/lib/chapter-word-count"
import { deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import { findChapterFileByNumber, getNextChapterNumber, invalidateChapterCache } from "@/lib/novel/chapter-utils"

/**
 * CorkboardView — 场景卡片墙（F-010，审查/记忆面板可选可视化子面板）。
 *
 * 数据真源复用（不建第二份真源）：卡片从 `.novel/snapshots` 只读派生
 * （chapter-ingest 的 listSnapshots/loadSnapshot —— 与 TimelineView
 * getTimelineEvents 同一派生源，ingest 时 mergeSnapshotTimeline 亦从快照写入）；
 * 字数从 wiki/chapters 章节文件按既有 chapter_number frontmatter 约定计数；
 * 情绪标签复用 emotional-arcs 投影。全部只读，无写入路径。
 */

/** 单张场景卡片（一章一卡，从快照派生）。 */
export interface CorkboardCard {
  chapterNumber: number
  /** 章节标题（快照缺省时由渲染层回退到「第 N 章」）。 */
  title?: string
  summary: string
  /** 正文字数（章节文件缺失/解析失败时为 undefined，卡片不显示字数徽标）。 */
  wordCount?: number
  /** 本章情绪标签（emotional-arcs 派生，去重后截断）。 */
  emotions: string[]
}

const MAX_CARD_EMOTIONS = 3

/** 与 knowledge-tree 相同的 chapter_number frontmatter 约定。 */
function extractChapterNumberFromFrontmatter(content: string): number | null {
  const match = content.match(/^chapter_number:\s*(\d+)\s*$/m)
  if (!match?.[1]) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 从 wiki/chapters 章节文件计字数；目录缺失或单文件失败均优雅降级。 */
async function loadChapterWordCounts(projectPath: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  try {
    const files = await listDirectory(`${projectPath}/wiki/chapters`)
    await Promise.all(
      files
        .filter((f) => !f.is_dir && f.name.endsWith(".md"))
        .map(async (f) => {
          try {
            const content = await readFile(f.path)
            const num = extractChapterNumberFromFrontmatter(content)
            if (num !== null && !counts.has(num)) counts.set(num, countChapterBodyWords(content))
          } catch {
            /* 单个章节文件读取失败不影响其余卡片 */
          }
        }),
    )
  } catch {
    /* 章节目录不存在 → 全部卡片无字数徽标 */
  }
  return counts
}

/** 情绪投影 → 章节 → 去重情绪标签列表。 */
async function loadEmotionsByChapter(projectPath: string): Promise<Map<number, string[]>> {
  const byChapter = new Map<number, string[]>()
  try {
    const arcs = await loadEmotionalArcs(projectPath)
    for (const beat of arcs.beats) {
      const emotion = beat.emotion.trim()
      if (!emotion) continue
      const list = byChapter.get(beat.chapterNumber) ?? []
      if (!list.includes(emotion)) list.push(emotion)
      byChapter.set(beat.chapterNumber, list)
    }
  } catch {
    /* emotional-arcs 缺失 → 卡片无情绪标签 */
  }
  return byChapter
}

/** 从 snapshots 派生场景卡片（正文章节，排除 outline 负号快照）。 */
export async function loadCorkboardCards(projectPath: string): Promise<CorkboardCard[]> {
  const numbers = (await listSnapshots(projectPath)).filter((n) => n > 0)
  if (numbers.length === 0) return []

  const [snapshots, wordCounts, emotionsByChapter] = await Promise.all([
    Promise.all(numbers.map((n) => loadSnapshot(projectPath, n))),
    loadChapterWordCounts(projectPath),
    loadEmotionsByChapter(projectPath),
  ])

  const cards: CorkboardCard[] = []
  snapshots.forEach((snapshot, i) => {
    if (!snapshot) return
    const chapterNumber = numbers[i]
    cards.push({
      chapterNumber,
      title: snapshot.chapterTitle || undefined,
      summary: snapshot.summary,
      wordCount: wordCounts.get(chapterNumber),
      emotions: (emotionsByChapter.get(chapterNumber) ?? []).slice(0, MAX_CARD_EMOTIONS),
    })
  })
  return cards.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export function CorkboardView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [cards, setCards] = useState<CorkboardCard[]>([])
  const [loading, setLoading] = useState(true)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const [busyChapter, setBusyChapter] = useState<number | null>(null)
  const [localVersion, setLocalVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  // dataVersion 监听与 TimelineView 同款：ingest bumpDataVersion 后重取，
  // cancelled flag 防旧 fetch 的 setCards 覆盖最新。
  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const derived = await loadCorkboardCards(project.path)
        if (!cancelled) setCards(derived)
      } catch {
        if (!cancelled) setCards([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [project, dataVersion, localVersion])

  const refresh = useCallback(() => setLocalVersion((v) => v + 1), [])

  const handleOpenChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    const path = await findChapterFileByNumber(project.path, chapterNumber)
    if (path) setSelectedFile(path)
  }, [project, setSelectedFile])

  const handleCreateScene = useCallback(async () => {
    if (!project) return
    setBusyChapter(-1)
    setNotice(null)
    try {
      const next = await getNextChapterNumber(project.path)
      const fileName = `chapter-${String(next).padStart(3, "0")}.md`
      const chapterPath = `${project.path}/wiki/chapters/${fileName}`
      const title = t("novel.corkboard.newSceneTitle", { num: next, defaultValue: `第${next}章` })
      const content = [
        "---",
        "type: chapter",
        `title: "${title}"`,
        `chapter_number: ${next}`,
        "chapter_status: draft",
        "---",
        "",
        `# ${title}`,
        "",
      ].join("\n")
      await writeFile(chapterPath, content)
      invalidateChapterCache(project.path)
      setNotice(t("novel.corkboard.created", { num: next, defaultValue: `已创建 ${title}` }))
      refresh()
    } catch (err) {
      setNotice(t("novel.corkboard.createFailed", { defaultValue: "新建场景卡片失败" }))
      console.error("[corkboard] create scene failed", err)
    } finally {
      setBusyChapter(null)
    }
  }, [project, refresh, t])

  const handleDeleteChapter = useCallback(async (chapterNumber: number) => {
    if (!project) return
    setBusyChapter(chapterNumber)
    setNotice(null)
    try {
      const path = await findChapterFileByNumber(project.path, chapterNumber)
      if (!path) {
        setNotice(t("novel.corkboard.chapterNotFound", { num: chapterNumber, defaultValue: `未找到第${chapterNumber}章文件` }))
        return
      }
      await deleteFile(path)
      invalidateChapterCache(project.path)
      setNotice(t("novel.corkboard.deleted", { num: chapterNumber, defaultValue: `已删除第${chapterNumber}章文件` }))
      setPendingDelete(null)
      refresh()
    } catch (err) {
      setNotice(t("novel.corkboard.deleteFailed", { num: chapterNumber, defaultValue: `删除第${chapterNumber}章失败` }))
      console.error("[corkboard] delete chapter failed", err)
    } finally {
      setBusyChapter(null)
    }
  }, [project, refresh, t])

  if (!project) return null

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("novel.corkboard.title")}</h2>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateScene()}
            disabled={busyChapter === -1}
            title={t("novel.corkboard.createScene", { defaultValue: "新建场景卡片" })}
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {t("novel.corkboard.createScene", { defaultValue: "新建场景卡片" })}
          </button>
        </div>
        {notice && (
          <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{notice}</div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto scroll-fade-y p-3">
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" role="status" aria-label={t("novel.corkboard.loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton-bar h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <LayoutGrid className="h-8 w-8 text-muted-foreground/40" />
            <p>{t("novel.corkboard.noData")}</p>
            <p className="text-xs italic">{t("novel.corkboard.noDataHint")}</p>
            <button
              type="button"
              onClick={() => void handleCreateScene()}
              disabled={busyChapter === -1}
              className="mt-1 flex items-center gap-1 rounded border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("novel.corkboard.createScene", { defaultValue: "新建场景卡片" })}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {cards.map((card) => (
              <div
                key={card.chapterNumber}
                data-corkboard-card={card.chapterNumber}
                className="group relative flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-primary/40"
              >
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {pendingDelete === card.chapterNumber ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleDeleteChapter(card.chapterNumber)}
                        disabled={busyChapter === card.chapterNumber}
                        title={t("novel.corkboard.confirmDelete", { defaultValue: "确认删除" })}
                        className="rounded bg-destructive p-1 text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        title={t("novel.corkboard.cancelDelete", { defaultValue: "取消" })}
                        className="rounded bg-muted p-1 text-foreground hover:opacity-80"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleOpenChapter(card.chapterNumber)}
                        title={t("novel.corkboard.openChapter", { defaultValue: "打开章节" })}
                        className="rounded bg-muted p-1 text-foreground hover:bg-accent hover:text-foreground"
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(card.chapterNumber)}
                        title={t("novel.corkboard.deleteChapter", { defaultValue: "删除" })}
                        className="rounded bg-muted p-1 text-foreground hover:bg-destructive/20 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 pr-12">
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                    {t("novel.corkboard.chapter", { num: card.chapterNumber })}
                  </span>
                  {typeof card.wordCount === "number" && (
                    <span className="text-xs text-muted-foreground">{t("novel.corkboard.words", { count: card.wordCount })}</span>
                  )}
                </div>
                {card.title && <h3 className="truncate text-sm font-semibold">{card.title}</h3>}
                <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">{card.summary || t("novel.corkboard.noSummary")}</p>
                {card.emotions.length > 0 && (
                  <div className="mt-auto flex flex-wrap gap-1 pt-1" data-corkboard-emotions={card.chapterNumber}>
                    {card.emotions.map((emotion) => (
                      <span key={emotion} className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground">
                        {emotion}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
