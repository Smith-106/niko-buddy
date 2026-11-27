// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Inline Draft-first drawer embedded inside `AntigravityAcpView`.
 *
 * Strict Draft-first & Google Antigravity ToS safety invariants:
 * - Renders `null` when closed so mounting `AntigravityAcpView` performs zero extra I/O.
 * - Reuses `ChapterDraftDock` + `acceptDraftAndIngest` + `createMainControlAcceptSeam`,
 *   passing `confirmed: true` STRICTLY inside `ChapterDraftDock`'s post-Step-2 callback
 *   (matching `writing-workspace.tsx:199-205`).
 * - Keeps `activeView` on `"antigravityAcp"` after adoption while syncing `selectedFile`
 *   and bumping `dataVersion`.
 */

import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink, FileText, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ChapterDraftDock,
  type ChapterDraftDockAdoptAndIngest,
} from "@/components/layout/chapter-draft-dock"
import { getChapterWriteCoordinator } from "@/components/layout/preview-panel-helpers"
import { acceptDraftAndIngest, createMainControlAcceptSeam } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"

export interface AntigravityAcpDraftDrawerProps {
  open: boolean
  onClose: () => void
  projectPath: string
  selectedFile: string | null
  onOpenMainControlDrafts?: () => void
  onOpenGateRerun?: () => void
  onOpenMemory?: () => void
  onAdopted?: (formalChapterPath: string) => void
}

export function AntigravityAcpDraftDrawer({
  open,
  onClose,
  projectPath,
  selectedFile,
  onOpenMainControlDrafts,
  onOpenGateRerun,
  onOpenMemory,
  onAdopted,
}: AntigravityAcpDraftDrawerProps) {
  const { t } = useTranslation()
  const novelConfig = useWikiStore((s) => s.novelConfig)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const adoptionOwnerRef = useRef<object>({})
  const adoptionCoordinator = getChapterWriteCoordinator()

  useEffect(() => {
    const owner = adoptionOwnerRef.current
    return () => {
      adoptionCoordinator.releaseOwnedAdoptions(owner)
    }
  }, [adoptionCoordinator])

  // Matches writing-workspace.tsx:173-225: `confirmed: true` is passed STRICTLY
  // inside ChapterDraftDock's post-Step-2 `adoptAndIngest` callback.
  const adoptDraftAndIngest = useCallback<ChapterDraftDockAdoptAndIngest>(
    async (input) =>
      acceptDraftAndIngest({
        projectPath: input.projectPath,
        formalChapterPath: input.formalChapterPath,
        draftId: input.draftId,
        accept: async (formalChapterPath) => {
          const begin = adoptionCoordinator.beginAdoption(
            formalChapterPath,
            adoptionOwnerRef.current,
          )
          if (!begin.ok || !begin.lease) {
            throw new Error(t("mainControl.draftAdoptBusy"))
          }
          const lease = begin.lease
          await begin.admittedTail
          try {
            const accepted = adoptionCoordinator.runAdoption(lease, () =>
              createMainControlAcceptSeam({
                projectPath: input.projectPath,
                draftId: input.draftId,
                confirmed: true,
                expectedDraftContent: input.expectedDraftContent,
              })(formalChapterPath),
            )
            adoptionCoordinator.releaseAdoption(lease)
            await accepted
          } catch (error) {
            adoptionCoordinator.releaseAdoption(lease)
            throw error
          }
          input.onAcceptSettled?.()
        },
        novelConfig,
        llmConfig,
      }),
    [adoptionCoordinator, llmConfig, novelConfig, t],
  )

  const handleAdopted = useCallback(
    (formalChapterPath: string) => {
      // Keep `activeView` on `antigravityAcp` while keeping selected file and dataVersion synced.
      setSelectedFile?.(formalChapterPath)
      bumpDataVersion?.()
      onAdopted?.(formalChapterPath)
    },
    [bumpDataVersion, onAdopted, setSelectedFile],
  )

  if (!open) return null

  return (
    <aside
      aria-label={t("antigravityAcp.draftDrawer.title")}
      data-testid="acp-draft-drawer"
      className="flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/95 lg:w-96"
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t("antigravityAcp.draftDrawer.title")}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("antigravityAcp.draftDrawer.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenMainControlDrafts && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground"
              onClick={onOpenMainControlDrafts}
              title={t("antigravityAcp.draftDrawer.openMainControl")}
              aria-label={t("antigravityAcp.draftDrawer.openMainControl")}
              data-testid="acp-draft-drawer-open-main-control"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground"
            onClick={onClose}
            aria-label={t("antigravityAcp.draftDrawer.close")}
            data-testid="acp-draft-drawer-close"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <ChapterDraftDock
          projectPath={projectPath}
          selectedFile={selectedFile}
          adoptAndIngest={adoptDraftAndIngest}
          onAdopted={handleAdopted}
          onOpenGateRerun={onOpenGateRerun}
          onOpenMemory={onOpenMemory}
        />
      </div>
    </aside>
  )
}
