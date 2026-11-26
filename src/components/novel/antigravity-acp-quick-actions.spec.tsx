// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import {
  AntigravityAcpQuickActions,
  buildWriterQuickActionPrompt,
  inferChapterContext,
  type InferredChapterContext,
} from "./antigravity-acp-quick-actions"

const SAMPLE_CTX: InferredChapterContext = {
  currentChapter: 2,
  nextChapter: 3,
  currentChapterPath: "wiki/chapters/ch02.md",
  latestChapter: 2,
  chapterCount: 2,
}

afterEach(() => {
  cleanup()
})

describe("AntigravityAcpQuickActions", () => {
  it("renders all 5 writer quick actions and pre-fills composer only on click", () => {
    const onSelectPrompt = vi.fn()
    render(
      <AntigravityAcpQuickActions
        chapterContext={SAMPLE_CTX}
        disabled={false}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    const actionIds = [
      "draft_next",
      "review_current",
      "polish_draft",
      "canon_audit",
      "book_setup",
    ] as const
    for (const id of actionIds) {
      expect(screen.getByTestId(`acp-quick-action-${id}`)).toBeInTheDocument()
    }

    // draft_next instructs context.prepare_write + rules.get + chapter.write + gate.check_mechanical
    fireEvent.click(screen.getByTestId("acp-quick-action-draft_next"))
    expect(onSelectPrompt).toHaveBeenCalledTimes(1)
    const draftPrompt = onSelectPrompt.mock.calls[0]![0] as string
    expect(draftPrompt).toContain("context.prepare_write")
    expect(draftPrompt).toContain("rules.get")
    expect(draftPrompt).toContain("chapter.write")
    expect(draftPrompt).toContain("gate.check_mechanical")
    expect(draftPrompt).toContain("3")

    // book_setup instructs director.check + rules.get + outline.write
    fireEvent.click(screen.getByTestId("acp-quick-action-book_setup"))
    expect(onSelectPrompt).toHaveBeenCalledTimes(2)
    const setupPrompt = onSelectPrompt.mock.calls[1]![0] as string
    expect(setupPrompt).toContain("director.check")
    expect(setupPrompt).toContain("rules.get")
    expect(setupPrompt).toContain("outline.write")

    // review_current, polish_draft, canon_audit also pre-fill cleanly
    fireEvent.click(screen.getByTestId("acp-quick-action-review_current"))
    fireEvent.click(screen.getByTestId("acp-quick-action-polish_draft"))
    fireEvent.click(screen.getByTestId("acp-quick-action-canon_audit"))
    expect(onSelectPrompt).toHaveBeenCalledTimes(5)
    expect(onSelectPrompt.mock.calls[2]![0]).toContain("gate.check_mechanical")
    expect(onSelectPrompt.mock.calls[3]![0]).toContain("chapter.write")
    expect(onSelectPrompt.mock.calls[4]![0]).toContain("canon.query")
  })

  it("disables all 5 buttons and emits zero callbacks when disabled", () => {
    const onSelectPrompt = vi.fn()
    render(
      <AntigravityAcpQuickActions
        chapterContext={SAMPLE_CTX}
        disabled={true}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    for (const id of [
      "draft_next",
      "review_current",
      "polish_draft",
      "canon_audit",
      "book_setup",
    ]) {
      const btn = screen.getByTestId(`acp-quick-action-${id}`)
      expect(btn).toBeDisabled()
      fireEvent.click(btn)
    }
    expect(onSelectPrompt).not.toHaveBeenCalled()
  })

  it("builds grounded bilingual templates for draft_next and book_setup", () => {
    const emptyCtx = inferChapterContext([], null)

    const enDraft = buildWriterQuickActionPrompt("draft_next", SAMPLE_CTX, "en")
    expect(enDraft).toContain("context.prepare_write")
    expect(enDraft).toContain("rules.get")
    expect(enDraft).toContain("chapter.write")
    expect(enDraft).toContain("Chapter 3")

    const zhDraftEmpty = buildWriterQuickActionPrompt("draft_next", emptyCtx, "zh")
    expect(zhDraftEmpty).toContain("context.prepare_write")
    expect(zhDraftEmpty).toContain("rules.get")
    expect(zhDraftEmpty).toContain("chapter.write")
    expect(zhDraftEmpty).toContain("第 1 章")

    const enSetup = buildWriterQuickActionPrompt("book_setup", SAMPLE_CTX, "en")
    expect(enSetup).toContain("director.check")
    expect(enSetup).toContain("rules.get")
    expect(enSetup).toContain("outline.write")
    expect(enSetup).toContain("Chapter 3")

    const zhSetup = buildWriterQuickActionPrompt("book_setup", emptyCtx, "zh")
    expect(zhSetup).toContain("director.check")
    expect(zhSetup).toContain("rules.get")
    expect(zhSetup).toContain("outline.write")
  })

  it("enforces compact MCP schema args across all 5 templates (targetChapter, bookRules compact, draftId / quoted string chapter) and renders editorial role badges", () => {
    const onSelectPrompt = vi.fn()
    render(
      <AntigravityAcpQuickActions
        chapterContext={SAMPLE_CTX}
        disabled={false}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    // Compact editorial role badges on all 5 buttons
    expect(screen.getByTestId("acp-quick-action-role-draft_next")).toHaveTextContent(/主笔|Writer/)
    expect(screen.getByTestId("acp-quick-action-role-review_current")).toHaveTextContent(/责编|Editor/)
    expect(screen.getByTestId("acp-quick-action-role-polish_draft")).toHaveTextContent(/润色师|Polish/)
    expect(screen.getByTestId("acp-quick-action-role-canon_audit")).toHaveTextContent(/考据官|Canon/)
    expect(screen.getByTestId("acp-quick-action-role-book_setup")).toHaveTextContent(/策划|Architect/)

    for (const lang of ["zh", "en"]) {
      const draft = buildWriterQuickActionPrompt("draft_next", SAMPLE_CTX, lang)
      expect(draft).toContain('context.prepare_write({ targetChapter: 3, retrievalMode: "local_only" })')
      expect(draft).toContain('rules.get({ sections: ["bookRules"], compact: true })')
      expect(draft).toContain("chapter.write")
      expect(draft).toContain('detailLevel: "compact"')
      expect(draft).toContain("gate.check_mechanical({ draftId:")
      expect(draft).not.toMatch(/\bchapter\s*:/i)

      const polish = buildWriterQuickActionPrompt("polish_draft", SAMPLE_CTX, lang)
      expect(polish).toContain('rules.get({ sections: ["bookRules"], compact: true })')
      expect(polish).toContain("gate.check_mechanical({ draftId:")
      expect(polish).toContain('detailLevel: "compact"')
      expect(polish).not.toMatch(/\bchapter\s*:\s*\d+/)

      const review = buildWriterQuickActionPrompt("review_current", SAMPLE_CTX, lang)
      expect(review).toContain('rules.get({ sections: ["bookRules"], compact: true })')
      expect(review).toContain("gate.check_mechanical({ draftId:")
      expect(review).toContain('gate.check_mechanical({ chapter: "2", detailLevel: "compact" })')
      expect(review).not.toMatch(/\bchapter\s*:\s*\d+/)

      const canon = buildWriterQuickActionPrompt("canon_audit", SAMPLE_CTX, lang)
      expect(canon).toContain('rules.get({ sections: ["bookRules"], compact: true })')

      const setup = buildWriterQuickActionPrompt("book_setup", SAMPLE_CTX, lang)
      expect(setup).toContain('rules.get({ sections: ["bookRules"], compact: true })')
    }

    // Specific ZH placeholder text in draft_next
    const zhDraft = buildWriterQuickActionPrompt("draft_next", SAMPLE_CTX, "zh")
    expect(zhDraft).toContain(
      'gate.check_mechanical({ draftId: "<chapter.write 返回的 draftId>", detailLevel: "compact" })',
    )
  })
})
