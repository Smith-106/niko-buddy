// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest"
import * as jestDomMatchers from "@testing-library/jest-dom/matchers"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import type { AcpRoleSlotId } from "@/lib/antigravity-acp-client"
import type { AcpRoleSlotState } from "@/stores/antigravity-acp-store"
import { AntigravityAcpSlotBar } from "./antigravity-acp-slot-bar"

expect.extend(jestDomMatchers)

function makeSlot(
  slot: AcpRoleSlotId,
  overrides: Partial<AcpRoleSlotState> = {},
): AcpRoleSlotState {
  return {
    slot,
    sessionId: null,
    cwd: null,
    transcript: [],
    composerText: "",
    prompting: false,
    pendingPermissions: [],
    configOptions: [],
    lastStopReason: null,
    hasRecentDraftWrite: false,
    recentDraftWriteSummary: null,
    lastLocalMcpSkipReason: null,
    activeAssistantId: null,
    mcpProfile: slot === "reviewer" ? "reviewer" : slot === "architect" ? "architect" : "writer-sub",
    localMcpProfile: null,
    attachedLocalMcp: false,
    localMcpScope: null,
    effectiveMcpScope: null,
    readOnly: slot === "reviewer",
    localMcpStale: false,
    localMcpStaleReason: null,
    parentCodeRepoWarning: null,
    ...overrides,
  }
}

function makeSlots(
  overrides: Partial<Record<AcpRoleSlotId, Partial<AcpRoleSlotState>>> = {},
): Record<AcpRoleSlotId, AcpRoleSlotState> {
  return {
    writer: makeSlot("writer", overrides.writer),
    reviewer: makeSlot("reviewer", overrides.reviewer),
    architect: makeSlot("architect", overrides.architect),
  }
}

describe("AntigravityAcpSlotBar", () => {
  afterEach(() => {
    cleanup()
  })

  it("renders accessible tablist with 3 role tabs, [RO] badge, live per-slot badges, and ArrowLeft/ArrowRight navigation", () => {
    const onSwitchSlot = vi.fn()
    const onHandOffToReviewer = vi.fn()

    render(
      <AntigravityAcpSlotBar
        activeSlot="writer"
        slots={makeSlots({
          writer: { sessionId: "sess-w1", prompting: true },
          reviewer: {
            sessionId: "sess-r1",
            pendingPermissions: [
              {
                requestId: "perm-1",
                sessionId: "sess-r1",
                slot: "reviewer",
                title: "draft.read",
                options: [{ optionId: "allow_once", name: "Allow" }],
              },
              {
                requestId: "perm-2",
                sessionId: "sess-r1",
                slot: "reviewer",
                title: "rules.get",
                options: [{ optionId: "allow_once", name: "Allow" }],
              },
            ],
          },
        })}
        connected={true}
        busy={false}
        workspaceReady={true}
        hasRecentDraftWrite={true}
        onSwitchSlot={onSwitchSlot}
        onHandOffToReviewer={onHandOffToReviewer}
      />,
    )

    expect(screen.getByTestId("acp-slot-bar")).toBeInTheDocument()
    const tablist = screen.getByRole("tablist")
    expect(tablist).toBeInTheDocument()

    const writerTab = screen.getByTestId("acp-slot-tab-writer")
    const reviewerTab = screen.getByTestId("acp-slot-tab-reviewer")
    const architectTab = screen.getByTestId("acp-slot-tab-architect")

    expect(writerTab).toHaveAttribute("role", "tab")
    expect(writerTab).toHaveAttribute("id", "acp-slot-tab-writer")
    expect(writerTab).toHaveAttribute("aria-controls", "acp-slot-tabpanel")
    expect(writerTab).toHaveAttribute("aria-selected", "true")
    expect(writerTab).toHaveAttribute("tabindex", "0")
    expect(writerTab).toHaveTextContent("[writer-sub]")

    expect(reviewerTab).toHaveAttribute("role", "tab")
    expect(reviewerTab).toHaveAttribute("id", "acp-slot-tab-reviewer")
    expect(reviewerTab).toHaveAttribute("aria-controls", "acp-slot-tabpanel")
    expect(reviewerTab).toHaveAttribute("aria-selected", "false")
    expect(reviewerTab).toHaveAttribute("tabindex", "-1")
    expect(screen.getByTestId("acp-slot-ro-badge")).toHaveTextContent("[RO]")

    expect(architectTab).toHaveAttribute("role", "tab")
    expect(architectTab).toHaveAttribute("id", "acp-slot-tab-architect")
    expect(architectTab).toHaveAttribute("aria-controls", "acp-slot-tabpanel")
    expect(architectTab).toHaveAttribute("aria-selected", "false")
    expect(architectTab).toHaveTextContent("[architect]")

    // Live per-slot indicators: connected dot, active prompt pulse, pending permission count badge
    expect(screen.getByTestId("acp-slot-connected-writer")).toBeInTheDocument()
    expect(screen.getByTestId("acp-slot-connected-reviewer")).toBeInTheDocument()
    expect(screen.queryByTestId("acp-slot-connected-architect")).toBeNull()
    expect(screen.getByTestId("acp-slot-prompting-writer")).toBeInTheDocument()
    expect(screen.queryByTestId("acp-slot-prompting-reviewer")).toBeNull()
    expect(screen.getByTestId("acp-slot-perm-badge-reviewer")).toHaveTextContent("2")
    expect(screen.queryByTestId("acp-slot-perm-badge-writer")).toBeNull()

    // Keyboard ArrowRight / ArrowLeft switches slot and moves focus
    writerTab.focus()
    fireEvent.keyDown(writerTab, { key: "ArrowRight" })
    expect(onSwitchSlot).toHaveBeenCalledWith("reviewer")
    expect(document.activeElement).toBe(reviewerTab)

    fireEvent.keyDown(writerTab, { key: "ArrowLeft" })
    expect(onSwitchSlot).toHaveBeenCalledWith("architect")
    expect(document.activeElement).toBe(architectTab)

    // Clicking active tab does not re-trigger switch; clicking inactive tab does
    onSwitchSlot.mockClear()
    fireEvent.click(writerTab)
    expect(onSwitchSlot).not.toHaveBeenCalled()
    fireEvent.click(reviewerTab)
    expect(onSwitchSlot).toHaveBeenCalledWith("reviewer")

    // Handoff button is highlighted on hasRecentDraftWrite and triggers callback
    const handoffBtn = screen.getByTestId("acp-handoff-reviewer-slot-btn")
    expect(handoffBtn).toHaveAttribute("data-highlighted", "true")
    expect(handoffBtn).toHaveTextContent(/交接至独立审校槽|Hand off to Reviewer Slot/)
    expect(handoffBtn).not.toBeDisabled()
    fireEvent.click(handoffBtn)
    expect(onHandOffToReviewer).toHaveBeenCalledTimes(1)
  })

  it("disables handoff button when disconnected, missing workspace, busy, or reviewer slot is actively prompting", () => {
    const onSwitchSlot = vi.fn()
    const onHandOffToReviewer = vi.fn()

    const { rerender } = render(
      <AntigravityAcpSlotBar
        activeSlot="writer"
        slots={makeSlots()}
        connected={false}
        busy={false}
        workspaceReady={true}
        hasRecentDraftWrite={false}
        onSwitchSlot={onSwitchSlot}
        onHandOffToReviewer={onHandOffToReviewer}
      />,
    )
    expect(screen.getByTestId("acp-handoff-reviewer-slot-btn")).toBeDisabled()
    expect(screen.getByTestId("acp-handoff-reviewer-slot-btn")).toHaveAttribute(
      "data-highlighted",
      "false",
    )

    rerender(
      <AntigravityAcpSlotBar
        activeSlot="writer"
        slots={makeSlots()}
        connected={true}
        busy={false}
        workspaceReady={false}
        hasRecentDraftWrite={false}
        onSwitchSlot={onSwitchSlot}
        onHandOffToReviewer={onHandOffToReviewer}
      />,
    )
    expect(screen.getByTestId("acp-handoff-reviewer-slot-btn")).toBeDisabled()

    rerender(
      <AntigravityAcpSlotBar
        activeSlot="writer"
        slots={makeSlots({ reviewer: { sessionId: "sess-r1", prompting: true } })}
        connected={true}
        busy={false}
        workspaceReady={true}
        hasRecentDraftWrite={true}
        onSwitchSlot={onSwitchSlot}
        onHandOffToReviewer={onHandOffToReviewer}
      />,
    )
    expect(screen.getByTestId("acp-handoff-reviewer-slot-btn")).toBeDisabled()
  })
})
