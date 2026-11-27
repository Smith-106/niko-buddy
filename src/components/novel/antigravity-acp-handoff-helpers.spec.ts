// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest"
import type { ChapterDraft } from "@/lib/novel"
import type { AcpTranscriptItem } from "@/stores/antigravity-acp-store"
import {
  buildReviewerHandoffContextFromDrafts,
  buildReviewerHandoffPrompt,
  extractLatestPrepareId,
  pruneSavedDraftMapForTranscript,
  resolveEffectiveSlotProfileArg,
  resolveSessionSlotArg,
  summarizeDraftGateStatus,
} from "./antigravity-acp-handoff-helpers"

const FORBIDDEN_WRITE_AND_LEGACY_TOOLS = [
  "chapter.write",
  "chapter.write_direct",
  "draft.patch",
  "draft.accept",
  "outline.write",
  "character.upsert",
  "character.list",
  "timeline.list",
  "snapshot.read",
]

describe("antigravity-acp-handoff-helpers", () => {
  it("extractLatestPrepareId extracts the latest valid prepareId from assistant text or tool titles and ignores user/placeholder entries", () => {
    const transcript: AcpTranscriptItem[] = [
      { id: "sys-1", role: "system", text: "Started" },
      { id: "usr-1", role: "user", text: "prepareId: user-ignored-999" },
      {
        id: "asst-1",
        role: "assistant",
        text: 'context.prepare_write returned {"prepareId": "prep-ch02-old"}',
      },
      {
        id: "asst-2",
        role: "assistant",
        text: "Draft ready. prepareId=prep_ch03_first then refined with prepare_id: `prep-ch03-latest`.",
      },
      {
        id: "asst-3",
        role: "assistant",
        text: "Placeholder prepareId: <prepareId> and prepareId: null should be ignored.",
      },
    ]
    expect(extractLatestPrepareId(transcript)).toBe("prep-ch03-latest")

    const toolTranscript: AcpTranscriptItem[] = [
      {
        id: "asst-t",
        role: "assistant",
        text: "Completed draft without inline id.",
        tools: [
          {
            id: "tc-1",
            title: "context.prepare_write (prepareId=prep-tool-77)",
            status: "completed",
          },
        ],
      },
    ]
    expect(extractLatestPrepareId(toolTranscript)).toBe("prep-tool-77")
    expect(extractLatestPrepareId([])).toBeNull()
  })

  it("summarizeDraftGateStatus maps all DraftGateStatus values, partial flag, and revisionRound in zh and en", () => {
    expect(summarizeDraftGateStatus(null, "zh")).toBeNull()

    const passedDraft = {
      adoptionGate: { status: "passed" as const },
      partial: false,
      revisionRound: 2,
    }
    expect(summarizeDraftGateStatus(passedDraft, "zh")).toContain("passed")
    expect(summarizeDraftGateStatus(passedDraft, "zh")).toContain("第 2 轮修订")
    expect(summarizeDraftGateStatus(passedDraft, "en")).toContain("passed")
    expect(summarizeDraftGateStatus(passedDraft, "en")).toContain("revision round 2")

    const blockedPartial = {
      adoptionGate: { status: "blocked" as const },
      partial: true,
      revisionRound: 1,
    }
    expect(summarizeDraftGateStatus(blockedPartial, "zh")).toContain("blocked")
    expect(summarizeDraftGateStatus(blockedPartial, "zh")).toContain("partial")
    expect(summarizeDraftGateStatus(blockedPartial, "en")).toContain("blocked")
    expect(summarizeDraftGateStatus(blockedPartial, "en")).toContain("partial")

    const unassessed = { adoptionGate: undefined, partial: undefined, revisionRound: undefined }
    expect(summarizeDraftGateStatus(unassessed, "zh")).toContain("unassessed")
    expect(summarizeDraftGateStatus(unassessed, "en")).toContain("unassessed")
  })

  it("buildReviewerHandoffPrompt produces deterministic zh/en read-only prompts with full context, fallback, skills guidance, gate priority, and zero write tools", () => {
    for (const lang of ["zh", "en"]) {
      const fullPrompt = buildReviewerHandoffPrompt(
        {
          draftId: "draft-ch05-abc",
          chapterName: "第5章 暗潮",
          prepareId: "prep-ch05-99",
          mechanicalGateSummary:
            lang === "zh" ? "机械门控阻断 (blocked)；第 1 轮修订" : "Mechanical gate blocked (blocked); revision round 1",
          attachedLocalMcp: true,
        },
        lang,
      )

      expect(fullPrompt).toContain("[RO]")
      expect(fullPrompt).toContain("draft-ch05-abc")
      expect(fullPrompt).toContain("第5章 暗潮")
      expect(fullPrompt).toContain("prep-ch05-99")
      expect(fullPrompt).toContain("blocked")
      expect(fullPrompt).toContain('draft.read({ draftId: "draft-ch05-abc" })')
      expect(fullPrompt).toContain(
        'gate.check_mechanical({ draftId: "draft-ch05-abc", detailLevel: "compact" })',
      )
      expect(fullPrompt).toContain('rules.get({ sections: ["bookRules"], compact: true })')
      expect(fullPrompt).toContain("canon.query")
      expect(fullPrompt).toContain("foreshadowing.list")
      expect(fullPrompt).toContain("character.read")
      expect(fullPrompt).toContain("outline.read")
      expect(fullPrompt).toContain("style.exemplars")
      expect(fullPrompt).toContain("chapter.search")
      expect(fullPrompt).toContain("skills.list")
      expect(fullPrompt).toContain("skills.get")
      expect(fullPrompt).toContain("Consistency(P0) > Anti-AI(P1) > Quality(P2)")

      for (const bad of FORBIDDEN_WRITE_AND_LEGACY_TOOLS) {
        expect(fullPrompt).not.toContain(bad)
      }

      // Minimal / no-draft + no-MCP fallback
      const minimalPrompt = buildReviewerHandoffPrompt({ attachedLocalMcp: false }, lang)
      expect(minimalPrompt).toContain("draft.list")
      expect(minimalPrompt).toContain("draft.read")
      expect(minimalPrompt).toContain('gate.check_mechanical({ draftId: "<draftId>", detailLevel: "compact" })')
      expect(minimalPrompt).toContain("Consistency(P0) > Anti-AI(P1) > Quality(P2)")
      expect(minimalPrompt).toMatch(/未挂载本地 MCP|Local MCP is not attached/)
      for (const bad of FORBIDDEN_WRITE_AND_LEGACY_TOOLS) {
        expect(minimalPrompt).not.toContain(bad)
      }
    }
  })

  it("supports slot arg resolution, profile resolution, selective saved-draft pruning, and latest pending draft selection", () => {
    expect(resolveSessionSlotArg("writer", undefined)).toBeUndefined()
    expect(resolveSessionSlotArg("writer", "writer")).toBeUndefined()
    expect(resolveSessionSlotArg("writer", "reviewer")).toBe("writer")
    expect(resolveSessionSlotArg("reviewer", "reviewer")).toBe("reviewer")
    expect(resolveSessionSlotArg("architect", "writer")).toBe("architect")

    expect(resolveEffectiveSlotProfileArg("writer", "writer-sub")).toBeUndefined()
    expect(resolveEffectiveSlotProfileArg("writer", "architect")).toBe("architect")
    expect(resolveEffectiveSlotProfileArg("reviewer", "writer-sub")).toBe("reviewer")
    expect(resolveEffectiveSlotProfileArg("architect", "writer-sub")).toBe("architect")

    const map = { "msg-w1": "ch01", "msg-r1": "ch02" }
    expect(pruneSavedDraftMapForTranscript(map, [{ id: "msg-r1" }])).toEqual({ "msg-w1": "ch01" })
    expect(pruneSavedDraftMapForTranscript(map, [])).toBe(map)

    const drafts: ChapterDraft[] = [
      { id: "d-old", chapterName: "第1章", content: "a", createdAt: 100, status: "draft" },
      { id: "d-saved", chapterName: "第2章", content: "b", createdAt: 300, status: "saved" },
      {
        id: "d-latest",
        chapterName: "第3章",
        content: "c",
        createdAt: 200,
        status: "draft",
        revisionRound: 2,
        adoptionGate: { status: "manual_review" },
      },
    ]
    const ctx = buildReviewerHandoffContextFromDrafts(
      drafts,
      [{ id: "a1", role: "assistant", text: "prepareId: prep-33" }],
      true,
      "zh",
    )
    expect(ctx.draftId).toBe("d-latest")
    expect(ctx.chapterName).toBe("第3章")
    expect(ctx.prepareId).toBe("prep-33")
    expect(ctx.mechanicalGateSummary).toContain("manual_review")
  })
})
