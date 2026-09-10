/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@testing-library/react"
import { DoctorPanel } from "./doctor-panel"

const mocks = vi.hoisted(() => ({
  t: vi.fn((k: string) => k),
  projectPath: "/p/book" as string | null,
  runDoctor: vi.fn(async () => ({
    verdict: "ok",
    findings: [
      { severity: "ok", name: "status.json", message: "存在" },
      { severity: "warn", name: "fts", message: "索引未就绪" },
    ],
  })),
}))

vi.mock("react-i18next", () => ({  initReactI18next: { type: "3rdParty", init: () => {} },  useTranslation: () => ({ t: mocks.t }) }))
vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: { project: { path: string | null } | null }) => unknown) =>
        selector({ project: { path: mocks.projectPath } }),
    
  }
})
vi.mock("@/lib/novel/doctor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/doctor")>()
  return { ...actual, runProjectDoctor: mocks.runDoctor }
})

describe("DoctorPanel", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("挂载自动跑诊断并渲染报告（formatDoctorReport 契约）", async () => {
    render(<DoctorPanel />)
    expect(await screen.findByTestId("doctor-panel")).toBeTruthy()
    expect(mocks.runDoctor).toHaveBeenCalled()
    expect(await screen.findByText(/status\.json/)).toBeTruthy()
  })

  it("无项目时优雅降级", async () => {
    mocks.projectPath = null
    render(<DoctorPanel />)
    expect(await screen.findByTestId("doctor-panel")).toBeTruthy()
  })
})
