/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"
import { TranslationWorkbenchView } from "./translation-workbench-view"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book",
  saveGlossary: vi.fn(async () => undefined),
  loadGlossary: vi.fn(async () => ({ entries: [], lastUpdated: "" })),
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { projectPath: string | null }) => unknown) => selector({ projectPath: mocks.projectPath }),
}))
vi.mock("@/lib/novel/translation-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/translation-workbench")>()
  return {
    ...actual,
    saveTranslationGlossary: mocks.saveGlossary,
    loadTranslationGlossary: mocks.loadGlossary,
  }
})
vi.mock("@/lib/novel/generation-history", () => ({
  saveGenerationHistoryEntry: vi.fn(async () => ({ id: "x" })),
}))
vi.mock("@/commands/fs", () => ({}))

describe("TranslationWorkbenchView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => cleanup())

  it("未注入 port 时优雅降级（按钮禁用 + 提示）", () => {
    render(<TranslationWorkbenchView />)
    expect(screen.getByTestId("translation-workbench-view")).toBeTruthy()
    expect(screen.getByText("novel.translation.noPort")).toBeTruthy()
  })

  it("添加术语条目（upsertGlossaryEntry 接线）", async () => {
    render(<TranslationWorkbenchView />)
    const inputs = screen.getAllByPlaceholderText("novel.translation.sourcePh")
    fireEvent.change(inputs[0], { target: { value: "青龙" } })
    fireEvent.change(screen.getByPlaceholderText("novel.translation.targetPh"), { target: { value: "Azure Dragon" } })
    fireEvent.click(screen.getByText("novel.translation.addEntry"))
    await screen.findByText("novel.translation.glossarySaved")
    expect(mocks.saveGlossary).toHaveBeenCalled()
  })
})
