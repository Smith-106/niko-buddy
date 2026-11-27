// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as jestDomMatchers from "@testing-library/jest-dom/matchers"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

expect.extend(jestDomMatchers)
import type { ChapterDraft } from "@/lib/novel"
import { AntigravityAcpDraftDrawer } from "./antigravity-acp-draft-drawer"

const mocks = vi.hoisted(() => ({
  listChapterDrafts: vi.fn<() => Promise<ChapterDraft[]>>(),
  resolveChapterDraftAdoptionTarget: vi.fn<() => Promise<string>>(),
  acceptDraftAndIngest: vi.fn(),
  createMainControlAcceptSeam: vi.fn(),
  fileExists: vi.fn(async () => false),
  setSelectedFile: vi.fn(),
  setActiveView: vi.fn(),
  bumpDataVersion: vi.fn(),
  storeState: {
    dataVersion: 1,
    novelConfig: { autoIngestOnSave: true } as Record<string, unknown>,
    llmConfig: { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" } as Record<string, unknown>,
  },
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    fileExists: (...args: unknown[]) => mocks.fileExists(...(args as [])),
  }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listChapterDrafts: (...args: unknown[]) => mocks.listChapterDrafts(...(args as [])),
    resolveChapterDraftAdoptionTarget: (...args: unknown[]) =>
      mocks.resolveChapterDraftAdoptionTarget(...(args as [])),
    acceptDraftAndIngest: (...args: unknown[]) => mocks.acceptDraftAndIngest(...args),
    createMainControlAcceptSeam: (...args: unknown[]) => mocks.createMainControlAcceptSeam(...args),
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const stateProxy = () => ({
    ...mocks.storeState,
    setSelectedFile: mocks.setSelectedFile,
    setActiveView: mocks.setActiveView,
    bumpDataVersion: mocks.bumpDataVersion,
  })
  return {
    ...actual,
    useWikiStore: Object.assign(
      (selector: (s: ReturnType<typeof stateProxy>) => unknown) => selector(stateProxy()),
      { getState: stateProxy },
    ),
  }
})

const SAMPLE_DRAFT: ChapterDraft = {
  id: "draft_acp_1",
  chapterName: "第4章",
  content: "# 第四章 夜雨\n\n林川站在屋檐下听雨。",
  createdAt: 1_700_000_000_000,
  status: "draft",
}

beforeEach(() => {
  mocks.listChapterDrafts.mockReset()
  mocks.listChapterDrafts.mockResolvedValue([SAMPLE_DRAFT])
  mocks.resolveChapterDraftAdoptionTarget.mockReset()
  mocks.resolveChapterDraftAdoptionTarget.mockResolvedValue("C:/books/demo/wiki/chapters/第4章.md")
  mocks.fileExists.mockReset()
  mocks.fileExists.mockResolvedValue(false)
  mocks.setSelectedFile.mockReset()
  mocks.setActiveView.mockReset()
  mocks.bumpDataVersion.mockReset()

  const innerAccept = vi.fn(async (_path: string) => {})
  mocks.createMainControlAcceptSeam.mockReset()
  mocks.createMainControlAcceptSeam.mockReturnValue(innerAccept)
  mocks.acceptDraftAndIngest.mockReset()
  mocks.acceptDraftAndIngest.mockImplementation(
    async (input: { formalChapterPath: string; accept: (path: string) => Promise<void> }) => {
      await input.accept(input.formalChapterPath)
      return {
        formalChapterPath: input.formalChapterPath,
        ingest: "ok" as const,
      }
    },
  )
})

afterEach(() => {
  cleanup()
})

describe("AntigravityAcpDraftDrawer", () => {
  it("returns null when closed and triggers zero draft listing I/O", () => {
    render(
      <AntigravityAcpDraftDrawer
        open={false}
        onClose={vi.fn()}
        projectPath="C:/books/demo"
        selectedFile="C:/books/demo/wiki/chapters/ch01.md"
      />,
    )

    expect(screen.queryByTestId("acp-draft-drawer")).toBeNull()
    expect(mocks.listChapterDrafts).not.toHaveBeenCalled()
  })

  it("enforces two-step adoption via acceptDraftAndIngest + createMainControlAcceptSeam(confirmed:true) and keeps activeView on antigravityAcp", async () => {
    const onClose = vi.fn()
    const onOpenMainControlDrafts = vi.fn()
    const onAdopted = vi.fn()

    render(
      <AntigravityAcpDraftDrawer
        open={true}
        onClose={onClose}
        projectPath="C:/books/demo"
        selectedFile="C:/books/demo/wiki/chapters/ch01.md"
        onOpenMainControlDrafts={onOpenMainControlDrafts}
        onAdopted={onAdopted}
      />,
    )

    expect(screen.getByTestId("acp-draft-drawer")).toBeInTheDocument()
    const adoptStep1Btn = await screen.findByTestId("chapter-draft-adopt-draft_acp_1")

    // Step 1: clicking Adopt ONLY opens confirmation panel — zero write/accept calls
    fireEvent.click(adoptStep1Btn)
    expect(await screen.findByTestId("chapter-draft-confirm")).toBeInTheDocument()
    expect(mocks.acceptDraftAndIngest).not.toHaveBeenCalled()
    expect(mocks.createMainControlAcceptSeam).not.toHaveBeenCalled()

    // Step 2: clicking Confirm Adopt invokes acceptDraftAndIngest + createMainControlAcceptSeam({ confirmed: true })
    fireEvent.click(screen.getByTestId("chapter-draft-confirm-accept"))
    await waitFor(() => {
      expect(mocks.acceptDraftAndIngest).toHaveBeenCalledTimes(1)
    })
    expect(mocks.createMainControlAcceptSeam).toHaveBeenCalledWith({
      projectPath: "C:/books/demo",
      draftId: "draft_acp_1",
      confirmed: true,
      expectedDraftContent: SAMPLE_DRAFT.content,
    })
    expect(mocks.acceptDraftAndIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "C:/books/demo",
        formalChapterPath: "C:/books/demo/wiki/chapters/第4章.md",
        draftId: "draft_acp_1",
      }),
    )

    // Keeps activeView on antigravityAcp (never calls setActiveView), syncs selectedFile & dataVersion
    await waitFor(() => {
      expect(mocks.setSelectedFile).toHaveBeenCalledWith("C:/books/demo/wiki/chapters/第4章.md")
    })
    expect(mocks.bumpDataVersion).toHaveBeenCalled()
    expect(onAdopted).toHaveBeenCalledWith("C:/books/demo/wiki/chapters/第4章.md")
    expect(mocks.setActiveView).not.toHaveBeenCalled()

    // Header actions & accessibility label (REV2-LOW-02)
    const openMainControlBtn = screen.getByTestId("acp-draft-drawer-open-main-control")
    expect(openMainControlBtn).toHaveAttribute("aria-label")
    expect(openMainControlBtn.getAttribute("aria-label")).toBe(openMainControlBtn.getAttribute("title"))
    fireEvent.click(openMainControlBtn)
    expect(onOpenMainControlDrafts).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("acp-draft-drawer-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
