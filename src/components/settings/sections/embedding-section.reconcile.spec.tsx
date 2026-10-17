// @vitest-environment jsdom
/**
 * EmbeddingSection 对账展示专项（B4）：
 *   重索引完成后必须把 `getLastReconcileOutcome()` 的结果渲染出来——
 *   成功（计数）、失败页（destructive）、命令失败（destructive）、
 *   跳过（清单不完整），且无结果时不渲染任何对账行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { EmbeddingSection } from "./embedding-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const DEFAULT_PROJECT = { id: "p1", name: "MyBook", path: "/p/mybook" }

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    embeddingEnabled: false,
    embeddingEndpoint: "",
    embeddingApiKey: "",
    embeddingModel: "",
    embeddingOutputDimensionality: undefined,
    embeddingMaxChunkChars: undefined,
    embeddingOverlapChunkChars: undefined,
    ...overrides,
  } as SettingsDraft
}

const mocks = vi.hoisted(() => {
  const state: {
    project: { id: string; name: string; path: string } | null
    embeddingConfig: Record<string, unknown>
    offlineMode: boolean
    setOfflineMode: ReturnType<typeof vi.fn>
  } = {
    project: null,
    embeddingConfig: {},
    offlineMode: false,
    setOfflineMode: vi.fn(),
  }
  return {
    state,
    setDraft: vi.fn() as DraftSetter,
    t: vi.fn((key: string) => key),
    getEmbeddingCount: vi.fn(async () => 0),
    legacyVectorRowCount: vi.fn(async () => 0),
    getLastEmbeddingError: vi.fn<() => string | null>(() => null),
    getLastReconcileOutcome: vi.fn<() => unknown>(() => null),
    embedAllPages: vi.fn(async () => 3),
    dropLegacyVectorTable: vi.fn(async () => {}),
    testSettingsEmbeddingModel: vi.fn(async () => ({ model: "bge-m3", dimensions: 1024 })),
    fetchEmbeddingModelList: vi.fn(async () => ({ models: ["bge-m3"] })),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
  }
})

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
    dropLegacyVectorTable: mocks.dropLegacyVectorTable,
    embedAllPages: mocks.embedAllPages,
    getEmbeddingCount: mocks.getEmbeddingCount,
    getLastEmbeddingError: mocks.getLastEmbeddingError,
    getLastReconcileOutcome: mocks.getLastReconcileOutcome,
    legacyVectorRowCount: mocks.legacyVectorRowCount,
  }
})

vi.mock("@/lib/settings-model-list", () => ({
  fetchEmbeddingModelList: mocks.fetchEmbeddingModelList,
}))

vi.mock("@/lib/settings-model-test", () => ({
  testSettingsEmbeddingModel: mocks.testSettingsEmbeddingModel,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    type = "button",
    children,
    ...props
  }: {
    variant?: string
    size?: string
    type?: "button" | "submit" | "reset"
    children?: ReactNode
    [key: string]: unknown
  }) => (
    <button type={type} {...props}>
      {children}
    </button>
  ),
}))

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function expandPanel(): void {
  fireEvent.click(screen.getByTitle("settings.sections.llm.expand"))
}

async function runReindex(): Promise<void> {
  expandPanel()
  fireEvent.click(screen.getByText("settings.sections.embedding.reindexAll"))
  await flushAsync()
}

describe("EmbeddingSection 对账展示（B4）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.project = DEFAULT_PROJECT
    mocks.state.embeddingConfig = {}
    mocks.getEmbeddingCount.mockResolvedValue(0)
    mocks.legacyVectorRowCount.mockResolvedValue(0)
    mocks.getLastEmbeddingError.mockReturnValue(null)
    mocks.getLastReconcileOutcome.mockReturnValue(null)
    mocks.embedAllPages.mockResolvedValue(3)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("对账成功：渲染清理/重建/未变更/漂移计数行", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue({
      status: "ran",
      report: {
        upserted_pages: ["alpha"],
        deleted_pages: ["gone-1", "gone-2"],
        unchanged_pages: ["beta"],
        failed_pages: [],
        drifted: 0,
        pending_consumed: 1,
        skipped: false,
      },
    })
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.getByText(/settings.sections.embedding.reconcileDone/)).toBeTruthy()
    expect(screen.queryByText(/settings.sections.embedding.reconcileFailed/)).toBeNull()
    expect(screen.queryByText(/settings.sections.embedding.reconcileSkipped/)).toBeNull()
  })

  it("对账有失败页：destructive 计数行（仍漂移）", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue({
      status: "ran",
      report: {
        upserted_pages: [],
        deleted_pages: ["gone-1"],
        unchanged_pages: [],
        failed_pages: ["beta"],
        drifted: 1,
        pending_consumed: 0,
        skipped: false,
      },
    })
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.getByText(/settings.sections.embedding.reconcileFailedPages/)).toBeTruthy()
  })

  it("对账命令失败：错误行可见（不静默）", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue({ status: "failed", error: "reconcile down" })
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.getByText(/settings.sections.embedding.reconcileFailed/)).toBeTruthy()
  })

  it("清单不完整跳过：提示含失败页数", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue({
      status: "skipped",
      failedPageIds: ["alpha", "beta"],
    })
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.getByText(/settings.sections.embedding.reconcileSkipped/)).toBeTruthy()
  })

  it("Rust 空清单安全分支：渲染 skippedEmpty 提示", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue({
      status: "ran",
      report: {
        upserted_pages: [],
        deleted_pages: [],
        unchanged_pages: [],
        failed_pages: [],
        drifted: 0,
        pending_consumed: 0,
        skipped: true,
      },
    })
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.getByText("settings.sections.embedding.reconcileSkippedEmpty")).toBeTruthy()
  })

  it("无对账结果：不渲染任何对账行", async () => {
    mocks.getLastReconcileOutcome.mockReturnValue(null)
    render(<EmbeddingSection draft={makeDraft()} setDraft={mocks.setDraft} />)
    await flushAsync()

    await runReindex()

    expect(screen.queryByText(/settings.sections.embedding.reconcile/)).toBeNull()
  })
})
