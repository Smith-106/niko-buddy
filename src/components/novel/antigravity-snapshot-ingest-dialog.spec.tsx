// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { FileNode } from "@/types/wiki"
import type {
  CommitInteractiveSnapshotResult,
  PreparedInteractiveChapterSnapshot,
  PrepareInteractiveSnapshotResult,
} from "@/lib/novel"
import {
  AntigravitySnapshotIngestDialog,
  collectFormalChapterCandidates,
} from "./antigravity-snapshot-ingest-dialog"

const mocks = vi.hoisted(() => ({
  prepareInteractiveChapterSnapshot: vi.fn(),
  commitInteractiveChapterSnapshot: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    prepareInteractiveChapterSnapshot: (...args: unknown[]) =>
      mocks.prepareInteractiveChapterSnapshot(...args),
    commitInteractiveChapterSnapshot: (...args: unknown[]) =>
      mocks.commitInteractiveChapterSnapshot(...args),
  }
})

const SAMPLE_FILE_TREE: FileNode[] = [
  {
    name: "wiki",
    path: "wiki",
    is_dir: true,
    children: [
      {
        name: "characters",
        path: "wiki/characters",
        is_dir: true,
        children: [{ name: "linchuan.md", path: "wiki/characters/linchuan.md", is_dir: false }],
      },
      {
        name: "chapters",
        path: "wiki/chapters",
        is_dir: true,
        children: [
          { name: "第十二章 风雨欲来.md", path: "wiki/chapters/第十二章 风雨欲来.md", is_dir: false },
          { name: "ch01.md", path: "wiki/chapters/ch01.md", is_dir: false },
          { name: "chapter-002-去AI味稿.md", path: "wiki/chapters/chapter-002-去AI味稿.md", is_dir: false },
          { name: "chapter-002.draft.md", path: "wiki/chapters/chapter-002.draft.md", is_dir: false },
          { name: "chapter-002.tmp", path: "wiki/chapters/chapter-002.tmp", is_dir: false },
          { name: "第3章 暗流.md", path: "wiki/chapters/第3章 暗流.md", is_dir: false },
        ],
      },
    ],
  },
]

function makePreparedSnapshot(chapterNumber = 3, chapterPath = "wiki/chapters/第3章 暗流.md"): PreparedInteractiveChapterSnapshot {
  const snapshot = {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    summary: "林川潜入旧库房，发现暗账。<script>alert(1)</script>",
    characters: ["林川", "沈砚"],
    locations: ["旧库房"],
    organizations: [],
    items: ["暗账"],
    events: ["夜探旧库房"],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: ["新增伏笔：暗账末尾的朱砂印"],
    newCanonFacts: ["旧库房地下藏有十年前的盐引记录"],
    timelineEvents: ["崇祯三年秋夜·旧库房失火前夕"],
    conflicts: [],
    endingHook: "门外响起沉重脚步声",
    graphNodes: [],
    graphEdges: [],
  }
  return {
    prepared: {
      snapshot,
      source: {
        readPath: chapterPath,
        chapterNumber,
        bodySha256: "a".repeat(64),
        contentSha256: "b".repeat(64),
      },
    },
    snapshot,
    preview: "preview text",
    validationWarnings: [
      { type: "entity_new", message: "发现新角色：沈砚" },
    ],
    warnings: [],
    chapterPath,
    chapterNumber,
  }
}

beforeEach(() => {
  mocks.prepareInteractiveChapterSnapshot.mockReset()
  mocks.commitInteractiveChapterSnapshot.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("collectFormalChapterCandidates", () => {
  it("walks wiki/chapters and chapters in-memory, filters drafts, parses ordinals, and sorts ascending", () => {
    const tree: FileNode[] = [
      ...SAMPLE_FILE_TREE,
      {
        name: "chapters",
        path: "chapters",
        is_dir: true,
        children: [
          { name: "chapter-002.md", path: "chapters/chapter-002.md", is_dir: false },
        ],
      },
    ]

    const result = collectFormalChapterCandidates(tree)
    expect(result.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 12])
    expect(result.map((c) => c.path)).toEqual([
      "wiki/chapters/ch01.md",
      "chapters/chapter-002.md",
      "wiki/chapters/第3章 暗流.md",
      "wiki/chapters/第十二章 风雨欲来.md",
    ])
  })
})

describe("AntigravitySnapshotIngestDialog", () => {
  it("returns null when closed and enforces WCAG dialog semantics, Escape/backdrop close, and focus restoration", () => {
    const onOpenChange = vi.fn()
    const trigger = document.createElement("button")
    trigger.textContent = "Open"
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { rerender } = render(
      <AntigravitySnapshotIngestDialog
        open={false}
        onOpenChange={onOpenChange}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        onPrefillPrompt={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("acp-snapshot-ingest-dialog")).toBeNull()

    rerender(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={onOpenChange}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    const dialog = screen.getByTestId("acp-snapshot-ingest-dialog")
    expect(dialog).toHaveAttribute("role", "dialog")
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(dialog).toHaveAttribute("aria-labelledby")
    expect(dialog).toHaveAttribute("aria-describedby")

    // Escape closes dialog
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Backdrop click closes dialog
    onOpenChange.mockReset()
    fireEvent.mouseDown(screen.getByTestId("acp-snapshot-ingest-backdrop"))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Closing restores focus to trigger element
    rerender(
      <AntigravitySnapshotIngestDialog
        open={false}
        onOpenChange={onOpenChange}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        onPrefillPrompt={vi.fn()}
      />,
    )
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it("Step 1 pre-fills read-only extraction prompt into ACP composer and closes dialog without running prepare/commit", () => {
    const onPrefillPrompt = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={onOpenChange}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={onPrefillPrompt}
      />,
    )

    fireEvent.click(screen.getByTestId("snapshot-ingest-prefill-btn"))

    expect(onPrefillPrompt).toHaveBeenCalledTimes(1)
    const prompt = onPrefillPrompt.mock.calls[0]![0] as string
    expect(prompt).toContain("chapter.read")
    expect(prompt).toContain("wiki/chapters/第3章 暗流.md")
    expect(prompt).toContain('"chapterNumber": 3')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.prepareInteractiveChapterSnapshot).not.toHaveBeenCalled()
    expect(mocks.commitInteractiveChapterSnapshot).not.toHaveBeenCalled()
  })

  it("Step 2 validates read-only, renders safe structured preview, detects stale edits, and Step 3 commits with receipt & partial warnings", async () => {
    const prepared = makePreparedSnapshot(3, "wiki/chapters/第3章 暗流.md")
    mocks.prepareInteractiveChapterSnapshot.mockResolvedValue({
      ok: true,
      prepared,
    } satisfies PrepareInteractiveSnapshotResult)

    const commitRes: CommitInteractiveSnapshotResult = {
      ingestResult: {
        snapshot: prepared.snapshot,
        canonOutcome: { status: "skipped", reason: "no_facts" },
        factsStoreFailed: true,
        failedProjections: ["timeline"],
        projectionError: { stage: "projection_runner", message: "disk busy" },
      },
      memoryStatus: {
        ingest: "partial",
        factsStoreFailed: true,
        failedProjections: ["timeline"],
        canonOutcome: { status: "skipped", reason: "no_facts" },
      },
    }
    mocks.commitInteractiveChapterSnapshot.mockResolvedValue(commitRes)

    const onCommitted = vi.fn()
    const { container } = render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
        onCommitted={onCommitted}
      />,
    )

    // Commit button starts disabled until preview is fresh
    const commitBtn = screen.getByTestId("snapshot-ingest-commit-btn")
    expect(commitBtn).toBeDisabled()

    // Paste JSON and validate
    const rawJson = '```json\n{"chapterNumber":3,"summary":"test"}\n```'
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: rawJson },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))

    const preview = await screen.findByTestId("snapshot-ingest-preview")
    expect(preview).toHaveTextContent("林川潜入旧库房")
    expect(preview).toHaveTextContent("林川")
    expect(preview).toHaveTextContent("沈砚")
    expect(preview).toHaveTextContent("旧库房地下藏有十年前的盐引记录")
    expect(preview).toHaveTextContent("新增伏笔：暗账末尾的朱砂印")
    expect(preview).toHaveTextContent("崇祯三年秋夜·旧库房失火前夕")
    expect(preview).toHaveTextContent("发现新角色：沈砚")
    // Zero dangerouslySetInnerHTML: script tag must NOT exist in DOM
    expect(container.querySelector("script")).toBeNull()
    expect(commitBtn).not.toBeDisabled()

    // Editing JSON invalidates preview and disables commit
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: `${rawJson} ` },
    })
    expect(commitBtn).toBeDisabled()
    expect(screen.getByTestId("snapshot-ingest-stale-notice")).toBeInTheDocument()

    // Re-validate to make preview fresh again
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await waitFor(() => {
      expect(screen.queryByTestId("snapshot-ingest-stale-notice")).toBeNull()
      expect(commitBtn).not.toBeDisabled()
    })

    // Changing chapter selection also marks preview stale and disables commit
    fireEvent.change(screen.getByTestId("snapshot-ingest-chapter-select"), {
      target: { value: "wiki/chapters/ch01.md" },
    })
    expect(commitBtn).toBeDisabled()
    expect(screen.getByTestId("snapshot-ingest-stale-notice")).toBeInTheDocument()

    // Switch back to chapter 3 -> fresh again -> click Commit
    fireEvent.change(screen.getByTestId("snapshot-ingest-chapter-select"), {
      target: { value: "wiki/chapters/第3章 暗流.md" },
    })
    expect(commitBtn).not.toBeDisabled()

    fireEvent.click(commitBtn)
    await waitFor(() => {
      expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledWith(
        "C:\\books\\demo",
        prepared,
        { confirmed: true },
      )
    })

    const receipt = await screen.findByTestId("snapshot-ingest-result")
    expect(receipt).toHaveAttribute("role", "status")
    expect(receipt).toHaveTextContent(/skipped|已跳过/)
    expect(receipt).toHaveTextContent("timeline")
    expect(receipt).toHaveTextContent("disk busy")
    expect(onCommitted).toHaveBeenCalledWith(commitRes)
  })

  it("handles validation failure, source_changed commit rejection without calling onCommitted, and locks close while committing", async () => {
    const prepared = makePreparedSnapshot(1, "wiki/chapters/ch01.md")
    mocks.prepareInteractiveChapterSnapshot
      .mockResolvedValueOnce({
        ok: false,
        errorCode: "invalid_json",
        error: "快照 JSON 解析失败",
      } satisfies PrepareInteractiveSnapshotResult)
      .mockResolvedValueOnce({
        ok: true,
        prepared,
      } satisfies PrepareInteractiveSnapshotResult)

    let resolveCommit!: (value: CommitInteractiveSnapshotResult) => void
    mocks.commitInteractiveChapterSnapshot.mockImplementation(
      () =>
        new Promise<CommitInteractiveSnapshotResult>((res) => {
          resolveCommit = res
        }),
    )

    const onOpenChange = vi.fn()
    const onCommitted = vi.fn()
    render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={onOpenChange}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/ch01.md"
        onPrefillPrompt={vi.fn()}
        onCommitted={onCommitted}
      />,
    )

    // First validation fails -> role="alert" shown, preview absent
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: "{bad json" },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    const errEl = await screen.findByTestId("snapshot-ingest-error")
    expect(errEl).toHaveAttribute("role", "alert")
    expect(errEl).toHaveTextContent("快照 JSON 解析失败")
    expect(screen.queryByTestId("snapshot-ingest-preview")).toBeNull()

    // Second validation succeeds
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":1,"summary":"ok"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await screen.findByTestId("snapshot-ingest-preview")

    // Start committing -> Escape & backdrop click must be locked while committing
    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))
    expect(screen.getByTestId("snapshot-ingest-commit-btn")).toBeDisabled()
    fireEvent.keyDown(window, { key: "Escape" })
    fireEvent.mouseDown(screen.getByTestId("acp-snapshot-ingest-backdrop"))
    expect(onOpenChange).not.toHaveBeenCalled()

    // Resolve with source_changed (snapshot === null)
    resolveCommit({
      ingestResult: {
        snapshot: null,
        failReason: "source_changed",
      },
      memoryStatus: {
        ingest: "failed",
        failReason: "source_changed",
      },
    })

    const commitErr = await screen.findByTestId("snapshot-ingest-error")
    expect(commitErr).toHaveAttribute("role", "alert")
    expect(commitErr).toHaveTextContent("source_changed")
    expect(onCommitted).not.toHaveBeenCalled()
    expect(screen.queryByTestId("snapshot-ingest-result")).toBeNull()
  })

  it("ignores stale out-of-order validation response when dialog closes mid-flight", async () => {
    let resolveValidate!: (value: PrepareInteractiveSnapshotResult) => void
    mocks.prepareInteractiveChapterSnapshot.mockImplementation(
      () =>
        new Promise<PrepareInteractiveSnapshotResult>((res) => {
          resolveValidate = res
        }),
    )

    const { rerender } = render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/ch01.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":1,"summary":"pending"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))

    // Close dialog before validation resolves
    rerender(
      <AntigravitySnapshotIngestDialog
        open={false}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/ch01.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    resolveValidate({
      ok: true,
      prepared: makePreparedSnapshot(1, "wiki/chapters/ch01.md"),
    })

    // Reopen dialog -> stale result must NOT appear
    rerender(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/ch01.md"
        onPrefillPrompt={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.queryByTestId("snapshot-ingest-preview")).toBeNull()
    })
  })

  it("surfaces partial commit warnings for ledgerSaveFailed and pendingProjections without masquerading as clean success", async () => {
    const prepared = makePreparedSnapshot(3, "wiki/chapters/第3章 暗流.md")
    mocks.prepareInteractiveChapterSnapshot.mockResolvedValue({
      ok: true,
      prepared,
    } satisfies PrepareInteractiveSnapshotResult)

    mocks.commitInteractiveChapterSnapshot.mockResolvedValue({
      ingestResult: {
        snapshot: prepared.snapshot,
        canonOutcome: { status: "skipped", reason: "no_facts" },
      },
      memoryStatus: {
        ingest: "partial",
        ledgerSaveFailed: true,
        pendingProjections: ["community"],
        canonOutcome: { status: "skipped", reason: "no_facts" },
      },
    } satisfies CommitInteractiveSnapshotResult)

    render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":3,"summary":"ledger+pending"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await screen.findByTestId("snapshot-ingest-preview")

    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))

    const receipt = await screen.findByTestId("snapshot-ingest-result")
    expect(receipt).toHaveAttribute("data-ingest-status", "partial")
    expect(receipt).toHaveAttribute("data-partial-warnings", "true")
    expect(receipt.className).toContain("border-warning")
    expect(receipt.className).not.toContain("border-success")

    const partialBox = screen.getByTestId("snapshot-ingest-partial-warnings")
    expect(partialBox).toHaveTextContent(/投影账本未能保存|Projection ledger could not be saved/)
    expect(partialBox).toHaveTextContent("community")
  })

  it("surfaces partial warnings when canonOutcome is unreconciled or memoryStatus.ingest is non-ok, and shows green success only on ok", async () => {
    const prepared = makePreparedSnapshot(3, "wiki/chapters/第3章 暗流.md")
    mocks.prepareInteractiveChapterSnapshot.mockResolvedValue({
      ok: true,
      prepared,
    } satisfies PrepareInteractiveSnapshotResult)

    mocks.commitInteractiveChapterSnapshot
      .mockResolvedValueOnce({
        ingestResult: {
          snapshot: prepared.snapshot,
          canonOutcome: {
            status: "completed",
            report: {
              written: 1,
              queued: 2,
              results: [],
              reconcile: { consistent: false, divergences: [] },
            },
          },
        },
        memoryStatus: {
          ingest: "partial",
          failReason: "memory_incomplete",
          canonOutcome: {
            status: "completed",
            report: {
              written: 1,
              queued: 2,
              results: [],
              reconcile: { consistent: false, divergences: [] },
            },
          },
        },
      } satisfies CommitInteractiveSnapshotResult)
      .mockResolvedValueOnce({
        ingestResult: {
          snapshot: prepared.snapshot,
        },
        memoryStatus: {
          ingest: "failed",
          failReason: "memory_incomplete",
        },
      } satisfies CommitInteractiveSnapshotResult)
      .mockResolvedValueOnce({
        ingestResult: {
          snapshot: prepared.snapshot,
          canonOutcome: {
            status: "completed",
            report: {
              written: 1,
              queued: 0,
              results: [],
              reconcile: { consistent: true, divergences: [] },
            },
          },
        },
        memoryStatus: {
          ingest: "ok",
          ledgerSaveFailed: false,
          factsStoreFailed: false,
          failedProjections: [],
          pendingProjections: [],
          canonOutcome: {
            status: "completed",
            report: {
              written: 1,
              queued: 0,
              results: [],
              reconcile: { consistent: true, divergences: [] },
            },
          },
        },
      } satisfies CommitInteractiveSnapshotResult)

    render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    // Case 1: unreconciled canonOutcome (queued > 0, consistent === false)
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":3,"summary":"canon-unreconciled"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await screen.findByTestId("snapshot-ingest-preview")
    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))

    let receipt = await screen.findByTestId("snapshot-ingest-result")
    expect(receipt).toHaveAttribute("data-ingest-status", "partial")
    expect(receipt).toHaveAttribute("data-partial-warnings", "true")
    expect(receipt.className).toContain("border-warning")
    expect(screen.getByTestId("snapshot-ingest-partial-warnings")).toHaveTextContent(
      /正史对账未完成（2 项排队）|Canon is not reconciled \(2 operations queued\)/,
    )

    // Case 2: non-ok memoryStatus.ingest without explicit projection flags still shows warning fallback
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":3,"summary":"missing-evidence"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-ingest-commit-btn")).not.toBeDisabled()
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))

    receipt = await screen.findByTestId("snapshot-ingest-result")
    expect(receipt).toHaveAttribute("data-ingest-status", "failed")
    expect(receipt).toHaveAttribute("data-partial-warnings", "true")
    expect(receipt.className).toContain("border-warning")
    expect(screen.getByTestId("snapshot-ingest-partial-warnings")).toHaveTextContent(
      /必要的记忆步骤未报告成功|Required memory steps did not report success/,
    )

    // Case 3: clean ok ingest renders green success without partial warning panel
    fireEvent.change(screen.getByTestId("snapshot-ingest-json-input"), {
      target: { value: '{"chapterNumber":3,"summary":"clean-ok"}' },
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-validate-btn"))
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-ingest-commit-btn")).not.toBeDisabled()
    })
    fireEvent.click(screen.getByTestId("snapshot-ingest-commit-btn"))

    receipt = await screen.findByTestId("snapshot-ingest-result")
    expect(receipt).toHaveAttribute("data-ingest-status", "ok")
    expect(receipt).toHaveAttribute("data-partial-warnings", "false")
    expect(receipt.className).toContain("border-success")
    expect(screen.queryByTestId("snapshot-ingest-partial-warnings")).toBeNull()
  })

  it("disables commit button after Step 3 succeeds to prevent duplicate commits until edited and re-validated", async () => {
    const preparedCh3 = makePreparedSnapshot(3, "wiki/chapters/第3章 暗流.md")
    const preparedCh1 = makePreparedSnapshot(1, "wiki/chapters/ch01.md")
    mocks.prepareInteractiveChapterSnapshot
      .mockResolvedValueOnce({ ok: true, prepared: preparedCh3 } satisfies PrepareInteractiveSnapshotResult)
      .mockResolvedValueOnce({ ok: true, prepared: preparedCh1 } satisfies PrepareInteractiveSnapshotResult)

    mocks.commitInteractiveChapterSnapshot
      .mockResolvedValueOnce({
        ingestResult: {
          snapshot: preparedCh3.snapshot,
          canonOutcome: { status: "skipped", reason: "no_facts" },
        },
        memoryStatus: { ingest: "ok", canonOutcome: { status: "skipped", reason: "no_facts" } },
      } satisfies CommitInteractiveSnapshotResult)
      .mockResolvedValueOnce({
        ingestResult: {
          snapshot: preparedCh1.snapshot,
          canonOutcome: { status: "skipped", reason: "no_facts" },
        },
        memoryStatus: { ingest: "ok", canonOutcome: { status: "skipped", reason: "no_facts" } },
      } satisfies CommitInteractiveSnapshotResult)

    const { rerender } = render(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )

    const commitBtn = screen.getByTestId("snapshot-ingest-commit-btn")
    const jsonInput = screen.getByTestId("snapshot-ingest-json-input")
    const chapterSelect = screen.getByTestId("snapshot-ingest-chapter-select")
    const validateBtn = screen.getByTestId("snapshot-ingest-validate-btn")

    // Validate & commit chapter 3
    const jsonCh3 = '{"chapterNumber":3,"summary":"first commit"}'
    fireEvent.change(jsonInput, { target: { value: jsonCh3 } })
    fireEvent.click(validateBtn)
    await screen.findByTestId("snapshot-ingest-preview")
    expect(commitBtn).not.toBeDisabled()

    fireEvent.click(commitBtn)
    await screen.findByTestId("snapshot-ingest-result")
    expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledTimes(1)

    // Immediately disabled after commit succeeds; clicking again must not trigger duplicate commit
    expect(commitBtn).toBeDisabled()
    fireEvent.click(commitBtn)
    expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledTimes(1)

    // Reverting JSON or chapter back without re-validating must keep commit disabled
    fireEvent.change(jsonInput, { target: { value: `${jsonCh3} ` } })
    expect(commitBtn).toBeDisabled()
    fireEvent.change(jsonInput, { target: { value: jsonCh3 } })
    expect(commitBtn).toBeDisabled()
    fireEvent.change(chapterSelect, { target: { value: "wiki/chapters/ch01.md" } })
    expect(commitBtn).toBeDisabled()
    fireEvent.change(chapterSelect, { target: { value: "wiki/chapters/第3章 暗流.md" } })
    expect(commitBtn).toBeDisabled()
    fireEvent.click(commitBtn)
    expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledTimes(1)

    // Switching chapter + editing JSON + re-validating re-enables commit for the new preview
    fireEvent.change(chapterSelect, { target: { value: "wiki/chapters/ch01.md" } })
    fireEvent.change(jsonInput, { target: { value: '{"chapterNumber":1,"summary":"second commit"}' } })
    fireEvent.click(validateBtn)
    await waitFor(() => {
      expect(commitBtn).not.toBeDisabled()
    })

    fireEvent.click(commitBtn)
    await screen.findByTestId("snapshot-ingest-result")
    expect(mocks.commitInteractiveChapterSnapshot).toHaveBeenCalledTimes(2)
    expect(commitBtn).toBeDisabled()

    // Closing & reopening dialog clears already-committed preview so commit remains disabled until re-validated
    rerender(
      <AntigravitySnapshotIngestDialog
        open={false}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )
    rerender(
      <AntigravitySnapshotIngestDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath={"C:\\books\\demo"}
        fileTree={SAMPLE_FILE_TREE}
        defaultChapterPath="wiki/chapters/第3章 暗流.md"
        onPrefillPrompt={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("snapshot-ingest-preview")).toBeNull()
    expect(screen.getByTestId("snapshot-ingest-commit-btn")).toBeDisabled()
  })
})
