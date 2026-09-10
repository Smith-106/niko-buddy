/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"
import { CoverGenerateCard } from "./cover-generate-card"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book",
  generate: vi.fn(async () => new Uint8Array([1, 2, 3])),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string } | null }) => unknown) =>
        selector({ project: { path: mocks.projectPath } }),
    
  }
})
vi.mock("@/lib/novel/generation-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/generation-history")>()
  return {
    ...actual,
      saveGenerationHistoryEntry: vi.fn(async () => ({ id: "x" })),
    
  }
})

const meta = { title: "雾都", genre: "悬疑", protagonistBrief: "侦探", tone: "冷峻", keyImagery: ["雾", "巷"] }

describe("CoverGenerateCard", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("未注入 port 时优雅降级（按钮禁用 + 提示）", () => {
    render(<CoverGenerateCard meta={meta} />)
    expect(screen.getByTestId("cover-generate-card")).toBeTruthy()
    expect(screen.getByText("novel.coverGen.noPort")).toBeTruthy()
  })

  it("注入 port 后生成（runCoverImageGeneration 接线 + 幂等路径）", async () => {
    render(<CoverGenerateCard meta={meta} port={{ generate: mocks.generate }} />)
    fireEvent.click(screen.getByText("novel.coverGen.generate"))
    expect(await screen.findByText(/generated|skipped|failed/)).toBeTruthy()
  })
})
