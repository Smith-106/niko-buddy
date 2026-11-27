// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Accessible multi-role ACP slot switcher bar (`Writer`, `Reviewer [RO]`,
 * `Architect`) with non-destructive Reviewer-slot handoff trigger.
 *
 * Strictly presentational & keyboard-accessible — never invokes Tauri IPC or
 * sends prompts directly.
 */

import { useCallback, useRef, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Eye, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ACP_ROLE_SLOTS, type AcpRoleSlotId } from "@/lib/antigravity-acp-client"
import type { AcpRoleSlotState } from "@/stores/antigravity-acp-store"

export interface AntigravityAcpSlotBarProps {
  activeSlot: AcpRoleSlotId
  slots: Record<AcpRoleSlotId, AcpRoleSlotState>
  connected: boolean
  busy: boolean
  workspaceReady: boolean
  hasRecentDraftWrite: boolean
  onSwitchSlot: (slot: AcpRoleSlotId) => void
  onHandOffToReviewer: () => void
}

export function AntigravityAcpSlotBar({
  activeSlot,
  slots,
  connected,
  busy,
  workspaceReady,
  hasRecentDraftWrite,
  onSwitchSlot,
  onHandOffToReviewer,
}: AntigravityAcpSlotBarProps) {
  const { t } = useTranslation()
  const tabRefs = useRef<Partial<Record<AcpRoleSlotId, HTMLButtonElement | null>>>({})

  const handleTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      if (busy) return
      let nextIndex: number | null = null
      if (e.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % ACP_ROLE_SLOTS.length
      } else if (e.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + ACP_ROLE_SLOTS.length) % ACP_ROLE_SLOTS.length
      } else if (e.key === "Home") {
        nextIndex = 0
      } else if (e.key === "End") {
        nextIndex = ACP_ROLE_SLOTS.length - 1
      }
      if (nextIndex === null) return
      e.preventDefault()
      const nextSlot = ACP_ROLE_SLOTS[nextIndex]!
      tabRefs.current[nextSlot]?.focus()
      if (nextSlot !== activeSlot) {
        onSwitchSlot(nextSlot)
      }
    },
    [activeSlot, busy, onSwitchSlot],
  )

  const reviewerPrompting = slots.reviewer.prompting
  const handoffDisabled = !connected || busy || !workspaceReady || reviewerPrompting

  return (
    <div
      data-testid="acp-slot-bar"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs"
    >
      <div
        role="tablist"
        aria-label={t("antigravityAcp.slots.tablistLabel")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {ACP_ROLE_SLOTS.map((slot, index) => {
          const slotState = slots[slot]
          const isSelected = slot === activeSlot
          const isConnectedSlot = connected && Boolean(slotState.sessionId)
          const pendingCount = slotState.pendingPermissions.length
          const isReviewer = slot === "reviewer"

          return (
            <button
              key={slot}
              ref={(el) => {
                tabRefs.current[slot] = el
              }}
              type="button"
              role="tab"
              id={`acp-slot-tab-${slot}`}
              aria-controls="acp-slot-tabpanel"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              disabled={busy}
              data-testid={`acp-slot-tab-${slot}`}
              onClick={() => {
                if (slot !== activeSlot) {
                  onSwitchSlot(slot)
                }
              }}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
                isSelected
                  ? "border-primary/60 bg-primary/15 text-foreground shadow-sm"
                  : "border-border/60 bg-background/80 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              {isConnectedSlot && (
                <span
                  data-testid={`acp-slot-connected-${slot}`}
                  className="h-2 w-2 shrink-0 rounded-full bg-success"
                  title={t("antigravityAcp.slots.connectedHint", {
                    sessionId: slotState.sessionId!.slice(0, 8),
                  })}
                  aria-label={t("antigravityAcp.slots.connectedBadge")}
                />
              )}
              <span>{t(`antigravityAcp.slots.${slot}`)}</span>
              {isReviewer ? (
                <span
                  data-testid="acp-slot-ro-badge"
                  className="rounded bg-warning/20 px-1 py-0.2 font-mono text-[10px] font-semibold text-warning-foreground"
                >
                  {t("antigravityAcp.slots.roBadge")}
                </span>
              ) : (
                <span className="font-mono text-[10px] text-muted-foreground">
                  [{slotState.mcpProfile}]
                </span>
              )}
              {slotState.prompting && (
                <span
                  data-testid={`acp-slot-prompting-${slot}`}
                  className="inline-flex items-center text-primary"
                  aria-label={t("antigravityAcp.slots.promptingBadge")}
                >
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                </span>
              )}
              {pendingCount > 0 && (
                <span
                  data-testid={`acp-slot-perm-badge-${slot}`}
                  className="inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-warning-foreground"
                  aria-label={t("antigravityAcp.slots.pendingPermissionsBadge", {
                    count: pendingCount,
                  })}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <Button
        type="button"
        variant={hasRecentDraftWrite ? "default" : "outline"}
        size="sm"
        className={`h-7 px-2.5 text-xs ${
          hasRecentDraftWrite ? "ring-1 ring-success/50" : ""
        }`}
        disabled={handoffDisabled}
        onClick={onHandOffToReviewer}
        data-testid="acp-handoff-reviewer-slot-btn"
        data-highlighted={hasRecentDraftWrite ? "true" : "false"}
      >
        <Eye className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {t("antigravityAcp.handoff.toReviewerBtn")}
      </Button>
    </div>
  )
}
