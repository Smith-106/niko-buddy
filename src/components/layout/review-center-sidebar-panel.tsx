// Copyright © 2024-2099 QAHUI (https://qmai.qimai-im.com/)
// SPDX-License-Identifier: MIT

import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { ClipboardCheck, Sparkles, Users } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { listDirectory, readFile } from "@/commands/fs"
import { flattenMdFiles } from "@/lib/novel/chapter-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { PanelHeaderWithHelp } from "@/components/layout/panel-header-with-help"
import { SIX_REVIEW_DIMENSIONS, SIX_REVIEW_DIMENSION_ORDER } from "@/lib/novel/dimension-review-adapter"
import {
  isThrillSoftGateAcknowledged,
  thrilAckChapterKey,
  THRILL_CHECKPOINT_LABELS,
  THRILL_CHECKPOINT_ORDER,
} from "@/lib/novel/outline-thrill-checkpoints"

const SIX_DIMENSIONS = SIX_REVIEW_DIMENSION_ORDER.map((key) => ({
  key,
  labelKey: `reviewCenter.dimension.${key}`,
}))

/** Track A = product gate-related dims; Track B = optional literary dims (split acceptance). */
const TRACK_A_KEYS = new Set(["consistency", "character", "continuity"])
const TRACK_B_KEYS = new Set(["thrill", "pacing", "pull"])
const TRACK_A_DIMENSIONS = SIX_DIMENSIONS.filter((d) => TRACK_A_KEYS.has(d.key))
const TRACK_B_DIMENSIONS = SIX_DIMENSIONS.filter((d) => TRACK_B_KEYS.has(d.key))

export function ReviewCenterSidebarPanel() {
  const { t } = useTranslation()
  const selectedReviewDimension = useWikiStore((s) => s.selectedReviewDimension)
  const setSelectedReviewDimension = useWikiStore((s) => s.setSelectedReviewDimension)
  const reviewRun = useWikiStore((s) => s.reviewRun)
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const selectedReviewFilePath = useWikiStore((s) => s.selectedReviewFilePath)
  const setSelectedReviewFilePath = useWikiStore((s) => s.setSelectedReviewFilePath)
  const thrilSoftGateAcknowledgedByChapter = useWikiStore((s) => s.thrilSoftGateAcknowledgedByChapter)
  const setThrillSoftGateAcknowledged = useWikiStore((s) => s.setThrillSoftGateAcknowledged)
  const [chapterOptions, setChapterOptions] = useState<Array<{ path: string; label: string }>>([])

  const selectedChapterNumber = useMemo(() => {
    const m = selectedReviewFilePath.match(/(?:^|[\\/])(\d+)(?:[\\/]|$)/)
      ?? selectedReviewFilePath.match(/chapter[-_]?(\d+)/i)
      ?? selectedReviewFilePath.match(/(?:^|[^\d])(\d{1,3})(?:\.md)?$/i)
    if (!m?.[1]) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }, [selectedReviewFilePath])

  const thrilAcknowledged = isThrillSoftGateAcknowledged(
    thrilSoftGateAcknowledgedByChapter,
    selectedChapterNumber,
  )

  useEffect(() => {
    if (!project?.path) {
      setChapterOptions([])
      setSelectedReviewFilePath("")
      return
    }

    let cancelled = false

    void listDirectory(`${project.path}/wiki/chapters`)
      .then(async (tree) => {
        if (cancelled) return
        const files = flattenMdFiles(tree)
        const options = await Promise.all(files.map(async (file) => {
          try {
            const content = await readFile(file.path)
            const parsed = parseFrontmatter(content)
            const fmTitle = typeof parsed.frontmatter?.title === "string" ? parsed.frontmatter.title.trim() : ""
            const headingTitle = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ""
            const baseTitle = fmTitle || headingTitle || file.name.replace(/\.md$/i, "")
            const label = baseTitle
            return {
              path: file.path,
              label,
            }
          } catch {
            return {
              path: file.path,
              label: file.name.replace(/\.md$/i, ""),
            }
          }
        }))
        setChapterOptions(options)
        const currentReviewFilePath = useWikiStore.getState().selectedReviewFilePath
        if (selectedFile && options.some((option) => option.path === selectedFile)) {
          setSelectedReviewFilePath(selectedFile)
        } else if (currentReviewFilePath && options.some((option) => option.path === currentReviewFilePath)) {
          setSelectedReviewFilePath(currentReviewFilePath)
        } else {
          setSelectedReviewFilePath(options[0]?.path ?? "")
        }
      })
      .catch(() => {
        if (cancelled) return
        setChapterOptions([])
        setSelectedReviewFilePath("")
      })

    return () => {
      cancelled = true
    }
  }, [project?.path, selectedFile, setSelectedReviewFilePath])

  const dimensionCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const dim of SIX_DIMENSIONS) {
      counts[dim.key] = reviewRun?.dimensionResults?.[dim.key]?.issues.length ?? 0
    }
    return counts
  }, [reviewRun?.dimensionResults])

  const totalBySeverity = useMemo(() => {
    const counts = { blocking: 0, high: 0, medium: 0, low: 0 }
    for (const key of SIX_REVIEW_DIMENSION_ORDER) {
      for (const issue of reviewRun?.dimensionResults?.[key]?.issues ?? []) {
        if (issue.severity === "error") counts.high++
        else if (issue.severity === "warning") counts.medium++
        else counts.low++
      }
    }
    return counts
  }, [reviewRun?.dimensionResults])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center border-b px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          <PanelHeaderWithHelp title={t("reviewCenter.title")} helpKey="review" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="mb-3">
          <div className="px-1 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t("reviewCenter.chapterTarget")}
          </div>
          <select
            value={selectedReviewFilePath}
            onChange={(event) => setSelectedReviewFilePath(event.target.value)}
            disabled={chapterOptions.length === 0 || (reviewRun?.running ?? false)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {chapterOptions.length === 0 ? (
              <option value="">{t("reviewCenter.noChapterAvailable")}</option>
            ) : (
              chapterOptions.map((option) => (
                <option key={option.path} value={option.path}>
                  {option.label}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="mb-3">
          <div className="px-1 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t("reviewCenter.aiReview")}
          </div>
          <button
            type="button"
            onClick={() => setSelectedReviewDimension("ai-review")}
            className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
              selectedReviewDimension === "ai-review" ? "qm-selected" : "text-muted-foreground qm-hover"
            }`}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <span>{t("reviewCenter.aiReview")}</span>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setSelectedReviewDimension("character-report")}
            className={`mt-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
              selectedReviewDimension === "character-report" ? "qm-selected" : "text-muted-foreground qm-hover"
            }`}
          >
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              <span>角色命中报告</span>
            </div>
          </button>
        </div>

        <div className="mb-3">
          <div className="px-1 mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t("novel.settings.outlineThrillChecklistTitle")}
          </div>
          <p className="px-1 mb-2 text-[10px] leading-4 text-muted-foreground">
            {t("novel.settings.outlineThrillChecklistHint")}
          </p>
          <ul className="space-y-1 px-1 text-[11px] leading-4 text-muted-foreground">
            {THRILL_CHECKPOINT_ORDER.map((id) => (
              <li key={id} className="flex gap-1.5">
                <span className="shrink-0 text-muted-foreground/80" aria-hidden>
                  •
                </span>
                <span>{THRILL_CHECKPOINT_LABELS[id]}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 px-1">
            <button
              type="button"
              onClick={() => setThrillSoftGateAcknowledged(selectedChapterNumber, !thrilAcknowledged)}
              className={`w-full rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                thrilAcknowledged
                  ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                  : "border-input bg-background text-muted-foreground qm-hover"
              }`}
              aria-pressed={thrilAcknowledged}
            >
              {thrilAcknowledged
                ? t("novel.settings.outlineThrillAckDone", {
                    chapter: thrilAckChapterKey(selectedChapterNumber),
                  })
                : t("novel.settings.outlineThrillAckButton")}
            </button>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {t("novel.settings.outlineThrillAckHint")}
            </p>
          </div>
        </div>

        <div className="mb-3">
          <div className="px-1 mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t("reviewCenter.sixDimensions")}
          </div>
          <p className="px-1 mb-2 text-[10px] leading-4 text-muted-foreground">
            {t("reviewCenter.splitAcceptanceHint")}
          </p>
          <div className="mb-2">
            <div className="px-1 mb-1 flex items-center gap-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              <span className="rounded border border-emerald-600/40 px-1 py-0.5">{t("reviewCenter.trackABadge")}</span>
              <span className="text-muted-foreground font-normal">{t("reviewCenter.trackAHint")}</span>
            </div>
            <div className="space-y-1">
              {TRACK_A_DIMENSIONS.map((dim) => (
                <button
                  key={dim.key}
                  type="button"
                  onClick={() => setSelectedReviewDimension(dim.key)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    selectedReviewDimension === dim.key ? "qm-selected" : "text-muted-foreground qm-hover"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="truncate">{t(dim.labelKey)}</span>
                    </div>
                    {dimensionCounts[dim.key] > 0 && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{dimensionCounts[dim.key]}</span>
                    )}
                    {(reviewRun?.running && reviewRun.activeDimension === dim.key) && (
                      <span className="text-xs text-primary">{SIX_REVIEW_DIMENSIONS[dim.key].label}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="mb-1">
            <div className="px-1 mb-1 flex items-center gap-1.5 text-[10px] font-medium text-violet-700 dark:text-violet-400">
              <span className="rounded border border-violet-600/40 px-1 py-0.5">{t("reviewCenter.trackBBadge")}</span>
              <span className="text-muted-foreground font-normal">{t("reviewCenter.trackBHint")}</span>
            </div>
            <div className="space-y-1">
              {TRACK_B_DIMENSIONS.map((dim) => (
                <button
                  key={dim.key}
                  type="button"
                  onClick={() => setSelectedReviewDimension(dim.key)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    selectedReviewDimension === dim.key ? "qm-selected" : "text-muted-foreground qm-hover"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="truncate">{t(dim.labelKey)}</span>
                    </div>
                    {dimensionCounts[dim.key] > 0 && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{dimensionCounts[dim.key]}</span>
                    )}
                    {(reviewRun?.running && reviewRun.activeDimension === dim.key) && (
                      <span className="text-xs text-primary">{SIX_REVIEW_DIMENSIONS[dim.key].label}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-1 text-xs text-muted-foreground">
          {t("reviewCenter.stats", totalBySeverity)}
        </div>
      </div>
    </div>
  )
}
