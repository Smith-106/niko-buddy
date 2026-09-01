import type { TFunction } from "i18next"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChapterMeta } from "@/lib/novel/chapter-meta"
import { saveGenerationHistoryEntry } from "@/lib/novel/generation-history"
import { runSixDimensionReview, type SixReviewDimensionKey } from "@/lib/novel/dimension-review-adapter"
import {
  advanceReviewJobDoneWithDimensionResults,
  advanceReviewJobFailed,
  advanceReviewJobRunning,
} from "@/lib/novel/review-job-lifecycle"
import { runContinuityMechanicalPreflight } from "@/lib/novel/review-adapter"
import { logger } from "@/lib/utils"
import { useWikiStore } from "@/stores/wiki-store"

interface StartSixDimensionReviewRunArgs {
  fileContent: string
  projectPath: string
  selectedFile: string
  t: TFunction
  onHistorySaved?: () => Promise<void> | void
  dimensionKey?: SixReviewDimensionKey
  /** G4 (39 号修复): 用户取消信号, 透传给 runSixDimensionReview。 */
  signal?: AbortSignal
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 状态 API 注入。传入时直接使用,
   * 缺省回退 useWikiStore.getState() 保持向后兼容。
   */
  storeActions?: {
    setReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "setReviewRun">["setReviewRun"]
    finishReviewRun: Pick<ReturnType<typeof useWikiStore.getState>, "finishReviewRun">["finishReviewRun"]
    getReviewRun: () => ReturnType<typeof useWikiStore.getState>["reviewRun"]
  }
}

export async function startSixDimensionReviewRun({
  fileContent,
  projectPath,
  selectedFile,
  t,
  onHistorySaved,
  dimensionKey,
  signal,
  storeActions,
}: StartSixDimensionReviewRunArgs): Promise<void> {
  if (!selectedFile || !fileContent.trim()) return

  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const setReviewRun = storeActions?.setReviewRun ?? ((r) => useWikiStore.getState().setReviewRun(r))
  const finishReviewRun = storeActions?.finishReviewRun ?? ((id, r) => useWikiStore.getState().finishReviewRun(id, r))
  const getReviewRun = storeActions?.getReviewRun ?? (() => useWikiStore.getState().reviewRun)

  const parsed = parseFrontmatter(fileContent)
  const meta = parsed.frontmatter ? parseChapterMeta(parsed.frontmatter as Record<string, unknown>) : null
  const runId = `${Date.now()}-${Math.random()}`
  // G4 (39 号修复): 自建 controller 注册到 store, 供 UI 取消按钮级联 abort。
  const controller = new AbortController()
  const effectiveSignal = signal ?? controller.signal
  useWikiStore.setState({ reviewRunAbortController: controller })
  const currentRun = getReviewRun()
  const preservedDimensionResults = dimensionKey && currentRun?.filePath === selectedFile
    ? currentRun.dimensionResults ?? {}
    : {}
  setReviewRun({
    runId,
    projectPath,
    filePath: selectedFile,
    running: true,
    results: [],
    dimensionResults: preservedDimensionResults,
    dimensionThinking: {},
  })

  try {
    // U2: advance status.review_job (non-blocking; no-op if no QMAI session status)
    void advanceReviewJobRunning(projectPath, meta?.chapterNumber).catch(() => {})
    // G5 (39 号修复): UI 路径注入机械连续性预检结果, 激活 continuity 维度短路
    // (与 deep-chapter fold 同源: runContinuityMechanicalPreflight → priorReviewResults)。
    const priorReviewResults = await runContinuityMechanicalPreflight(
      projectPath,
      meta?.chapterNumber,
    ).catch(() => [])
    const dimensionResults = await runSixDimensionReview({
      projectPath,
      chapterContent: fileContent,
      chapterNumber: meta?.chapterNumber,
      dimensionKeys: dimensionKey ? [dimensionKey] : undefined,
      signal: effectiveSignal,
      priorReviewResults,
      callbacks: {
        onDimensionProgress: (activeDimension, dimensionProgress) => {
          finishReviewRun(runId, {
            running: true,
            activeDimension,
            dimensionProgress,
          })
        },
        onDimensionThinking: (dimensionKey, thinking) => {
          const current = getReviewRun()
          finishReviewRun(runId, {
            running: true,
            activeDimension: dimensionKey,
            dimensionThinking: {
              ...(current?.dimensionThinking ?? {}),
              [dimensionKey]: thinking,
            },
          })
        },
        onDimensionResult: (dimensionKey, result) => {
          const current = getReviewRun()
          finishReviewRun(runId, {
            running: true,
            activeDimension: dimensionKey,
            dimensionResults: {
              ...(current?.dimensionResults ?? {}),
              [dimensionKey]: result,
            },
          })
        },
        onMeasurementFingerprint: (fp) => {
          finishReviewRun(runId, {
            running: true,
            measurementFingerprint: fp,
          })
        },
      },
    })

    const nextDimensionResults = {
      ...preservedDimensionResults,
      ...dimensionResults,
    }

    finishReviewRun(runId, {
      running: true,
      dimensionResults: nextDimensionResults,
      error: undefined,
    })
    await saveGenerationHistoryEntry(projectPath, {
      kind: "review",
      title: meta?.chapterNumber ? t("novel.review.historyEntryTitle", { chapter: meta.chapterNumber }) : t("novel.review.historyEntryTitleNoChapter"),
      chapterNumber: meta?.chapterNumber,
      sourcePath: selectedFile,
      results: [],
      dimensionResults: nextDimensionResults,
    })
    await onHistorySaved?.()
    // G4 (39 号修复): abort 被 streamChat onDone 正常返回 + 逐维 try/catch 吞掉,
    // 不会 reject — 完成后必须显式检查 effectiveSignal.aborted 才能正确标记取消。
    if (effectiveSignal.aborted) {
      finishReviewRun(runId, {
        running: false,
        error: t("novel.review.runFailed"),
      })
      return
    }
    void advanceReviewJobDoneWithDimensionResults(
      projectPath,
      nextDimensionResults,
      "six-dim review finished (non-blocking)",
    ).catch(() => {})
  } catch (error) {
    // F-16 (CWE-532): message-only to avoid leaking provider request details.
    logger.error("Six-Dim Review", "六维审查失败", { error: error instanceof Error ? error.message : String(error) })
    finishReviewRun(runId, { running: false, error: t("novel.review.runFailed") })
    void advanceReviewJobFailed(
      projectPath,
      error instanceof Error ? error.message : String(error),
    ).catch(() => {})
  } finally {
    useWikiStore.setState({ reviewRunAbortController: null })
    const current = getReviewRun()
    if (current?.runId === runId) {
      finishReviewRun(runId, {
        running: false,
        results: current.results,
        dimensionResults: current.dimensionResults,
        activeDimension: undefined,
      })
    }
  }
}
