import type { TFunction } from "i18next"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChapterMeta } from "@/lib/novel/chapter-meta"
import { reviewChapter } from "@/lib/novel/review-adapter"
import {
  checkReviewCompletionGate,
  computeChapterHash,
} from "@/lib/novel/review-completion-gate"
import { persistRevisionFeedbackForChapter, pickRevisionFeedbackFromReviewResults } from "@/lib/novel/revision-feedback"
import { saveGenerationHistoryEntry } from "@/lib/novel/generation-history"
import { getFileStem } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"
import { createReviewThinkingPublisher } from "./review-thinking-publisher"
import { yieldToBrowserFrame } from "./yield-to-browser"

interface StartNovelReviewRunArgs {
  fileContent: string
  projectPath: string
  selectedFile: string
  t: TFunction
  onHistorySaved?: () => Promise<void> | void
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 状态 API 注入。传入时直接使用,
   * 缺省回退 useWikiStore.getState() 保持向后兼容。逐步消除 lib 层对
   * useWikiStore 的直接耦合, 使编排函数可脱离 UI store 独立测试。
   */
  storeActions?: {
    setReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "setReviewRun">["setReviewRun"]
    finishReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "finishReviewRun">["finishReviewRun"]
    getReviewRun: () => ReturnType<typeof useWikiStore.getState>["reviewRun"]
  }
}

export interface ReviewChapterTarget {
  chapterNumber?: number
}

function parseChapterNumberFromSelectedFile(selectedFile: string): number | undefined {
  const stem = getFileStem(selectedFile).trim()
  const chineseChapter = stem.match(/第\s*0*(\d+)\s*章/)
  if (chineseChapter) return Number(chineseChapter[1])

  const slugChapter = stem.match(/chapter[-_\s]*0*(\d+)/i)
  if (slugChapter) return Number(slugChapter[1])

  const numericStem = stem.match(/^0*(\d+)$/)
  if (numericStem) return Number(numericStem[1])

  return undefined
}

export function resolveReviewChapterTarget(fileContent: string, selectedFile: string): ReviewChapterTarget {
  const parsed = parseFrontmatter(fileContent)
  const meta = parsed.frontmatter ? parseChapterMeta(parsed.frontmatter as Record<string, unknown>) : null
  const selectedChapterNumber = parseChapterNumberFromSelectedFile(selectedFile)

  return {
    chapterNumber: selectedChapterNumber ?? meta?.chapterNumber,
  }
}

export async function startNovelReviewRun({
  fileContent,
  projectPath,
  selectedFile,
  t,
  onHistorySaved,
  storeActions,
}: StartNovelReviewRunArgs): Promise<void> {
  if (!selectedFile || !fileContent.trim()) return

  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const setReviewRun = storeActions?.setReviewRun ?? ((r) => useWikiStore.getState().setReviewRun(r))
  const finishReviewRun = storeActions?.finishReviewRun ?? ((id, r) => useWikiStore.getState().finishReviewRun(id, r))
  const getReviewRun = storeActions?.getReviewRun ?? (() => useWikiStore.getState().reviewRun)

  const target = resolveReviewChapterTarget(fileContent, selectedFile)
  const runId = `${Date.now()}-${Math.random()}`
  setReviewRun({ runId, projectPath, filePath: selectedFile, running: true, results: [] })
  await yieldToBrowserFrame()
  const thinkingPublisher = createReviewThinkingPublisher({
    publish: (thinking) => {
      finishReviewRun(runId, { running: true, thinking })
    },
  })

  try {
    const results = await reviewChapter(projectPath, fileContent, target.chapterNumber, {
      onThinking: (thinking) => {
        thinkingPublisher.publish(thinking)
      },
    })
    thinkingPublisher.flush()
    // 53 号报告 P1-3: critic 防伪完成门 (open-write-studio 模式)。gate 失败
    // → history 条目 gateStatus=incomplete (不宣称完成态), 审查结果仍展示
    // (Draft-first: 审查可看, 完成态不可宣称)。新字段 additive。
    const chapterHash = await computeChapterHash(fileContent)
    const gateResult = checkReviewCompletionGate({
      chapterHash,
      chapterBody: fileContent,
      results,
    })
    const gateStatus: "completed" | "incomplete" | "suspect" = gateResult.passed
      ? "completed"
      : gateResult.failures.includes("STALE_ARTIFACT") || gateResult.failures.includes("HOLLOW_PASS")
        ? "suspect"
        : "incomplete"
    finishReviewRun(runId, { running: true, results, error: undefined, gateStatus })
    await saveGenerationHistoryEntry(projectPath, {
      kind: "review",
      title: target.chapterNumber ? t("novel.review.historyEntryTitle", { chapter: target.chapterNumber }) : t("novel.review.historyEntryTitleNoChapter"),
      chapterNumber: target.chapterNumber,
      sourcePath: selectedFile,
      results,
      chapterHash,
      gateStatus,
    })
    await onHistorySaved?.()

    if (target.chapterNumber) {
      await persistRevisionFeedbackForChapter(
        projectPath,
        target.chapterNumber,
        "review",
        pickRevisionFeedbackFromReviewResults(results),
      )
    }
  } catch (error) {
    // F-16 (CWE-532): message-only to avoid leaking provider request details.
    logger.error("Novel Review", "审查失败", { error: error instanceof Error ? error.message : String(error) })
    thinkingPublisher.flush()
    finishReviewRun(runId, { running: false, error: t("novel.review.runFailed") })
  } finally {
    thinkingPublisher.flush()
    const current = getReviewRun()
    if (current?.runId === runId) {
      finishReviewRun(runId, { running: false, results: current.results })
    }
  }
}
