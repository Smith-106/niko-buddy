// @vitest-environment jsdom
// SEQ-49 repro: memory-center-view does not subscribe dataVersion.
// Proves: external bumpDataVersion (e.g. chapter-ingest saveSnapshot +
// bumpDataVersion) does not trigger reload, view stays stale until manual
// refresh. After fix (dataVersion in refresh deps) the second load fires.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { MemoryCenterView } from "./memory-center-view"
import type { MemoryCenterData } from "@/lib/novel"

const tStable = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: tStable.t }),
}))

const wiki = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    project: { id: "p1", name: "Novel", path: "E:/Novel" },
    selectedMemoryCenterEntry: "snapshots",
    setSelectedMemoryCenterEntry: vi.fn(),
    dataVersion: 0,
    bumpDataVersion: vi.fn(() => {
      ;(state as Record<string, unknown>).dataVersion = ((state as Record<string, number>).dataVersion as number) + 1
    }),
  }
  return { state }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: Record<string, unknown>) => unknown) => selector(wiki.state),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(async () => "---\ntitle: t\n---\nbody\n"), writeFile: vi.fn(async () => {}), deleteFile: vi.fn(async () => {}) }
})

vi.mock("@/lib/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontmatter")>()
  return { ...actual, parseFrontmatter: () => ({ frontmatter: { title: "t" }, body: "body\n", rawBlock: "---\ntitle: t\n---\n" }) }
})

vi.mock("@/components/editor/wiki-reader", () => ({
  WikiReader: ({ body }: { body: string }) => <div data-testid="wiki-reader">{body}</div>,
}))

const memoryCenter = vi.hoisted(() => ({
  loadMemoryCenterData: vi.fn(async (): Promise<MemoryCenterData> => ({
    stats: { snapshotCount: 1, syncedSnapshotCount: 1, characterCount: 1, activeForeshadowingCount: 0, memoryFileCount: 1 },
    snapshots: [
      {
        chapterNumber: 1,
        chapterTitle: "第一章",
        summary: "摘要",
        endingHook: "",
        memorySynced: true,
        memorySyncedAt: "2026-07-25T10:00:00.000Z",
        snapshotPath: "E:/Novel/.novel/snapshots/1.snapshot.md",
        characterStateChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        timelineEvents: [],
        hasMoreCharacterStateChanges: false,
        hasMoreKnowledgeChanges: false,
        hasMoreForeshadowingChanges: false,
        hasMoreTimelineEvents: false,
      },
    ],
    files: [],
    dismantlingProjects: [],
  })),
}))

vi.mock("@/lib/novel/memory-center", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/memory-center")>()
  return { ...actual, loadMemoryCenterData: memoryCenter.loadMemoryCenterData }
})

beforeEach(() => {
  setupDomGlobals({ scrollTo: true })
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.selectedMemoryCenterEntry = "snapshots"
  wiki.state.dataVersion = 0
})

afterEach(() => cleanup())

describe("SEQ-49 memory-center subscribes dataVersion (ISS-20260712-012)", () => {
  it("reloads when dataVersion bumps (external writeback visible)", async () => {
    const { rerender } = render(<MemoryCenterView />)
    expect(await screen.findByText("第一章")).toBeInTheDocument()
    const before = memoryCenter.loadMemoryCenterData.mock.calls.length
    expect(before).toBeGreaterThan(0)
    // 模拟外部写入导致的 dataVersion 自增（chapter-ingest saveSnapshot + bump）
    wiki.state.dataVersion = 1
    rerender(<MemoryCenterView />)
    await waitFor(() => {
      expect(memoryCenter.loadMemoryCenterData.mock.calls.length).toBeGreaterThan(before)
    })
  })
})
