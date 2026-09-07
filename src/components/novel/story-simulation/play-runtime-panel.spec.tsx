/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@testing-library/react"
import { PlayRuntimePanel } from "./play-runtime-panel"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book",
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: { project: { id: string; name: string; path: string | null } | null }) => unknown) =>
    selector({ project: { id: "book", name: "book", path: mocks.projectPath } }),
}))
vi.mock("@/lib/novel/interactive-io", () => ({
  loadInteractiveGraph: vi.fn(async () => null),
  loadPlaySession: vi.fn(async () => null),
  savePlaySession: vi.fn(async () => undefined),
}))
vi.mock("@/lib/novel/export", () => ({
  exportInteractiveStory: vi.fn(async () => ({ success: true, exportedPath: "/p/.novel/play-graph", chapterCount: 4, message: "ok" })),
}))
vi.mock("@/lib/novel/generation-history", () => ({
  saveGenerationHistoryEntry: vi.fn(async () => ({ id: "x" })),
}))

describe("PlayRuntimePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => cleanup())

  it("渲染面板并降级为示例图（无项目图时优雅降级）", async () => {
    render(<PlayRuntimePanel />)
    expect(await screen.findByTestId("play-runtime-panel")).toBeTruthy()
    // 示例图首帧文本
    expect(await screen.findByText(/示例开场/)).toBeTruthy()
  })

  it("选择分支推进状态（stepPlay 接线）", async () => {
    render(<PlayRuntimePanel />)
    const choice = await screen.findByRole("button", { name: /走光亮的小径/ })
    fireEvent.click(choice)
    expect(await screen.findByText(/你选择了光亮的小径/)).toBeTruthy()
  })

  it("重开回到开头（restart 接线）", async () => {
    render(<PlayRuntimePanel />)
    fireEvent.click(await screen.findByRole("button", { name: /走幽暗的密林/ }))
    fireEvent.click((await screen.findAllByText("novel.play.restart"))[0])
    expect((await screen.findAllByText(/示例开场/)).length).toBeGreaterThan(0)
  })
})
