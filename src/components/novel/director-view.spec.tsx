// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { DirectorView } from "./director-view"
import { createDirectorPipeline, type DirectorPipelineState } from "@/lib/novel/director-pipeline"
import type { DirectorPersistedFile } from "@/lib/novel/director-pipeline-store"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  setActiveView: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: mocks.fileExists,
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
  createDirectory: mocks.createDirectory,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveView: mocks.setActiveView }),
}))

function makeFile(partial?: Partial<DirectorPersistedFile>): DirectorPersistedFile {
  return {
    fileVersion: 1,
    state: createDirectorPipeline(),
    ideaInput: { title: "雾都", genre: "悬疑", coreConflict: "连环失踪" },
    ...partial,
  }
}

function fullDoneState(): DirectorPipelineState {
  let state = createDirectorPipeline()
  state = {
    ...state,
    currentPhase: "chapters",
    statuses: { idea: "done", world: "done", character: "done", outline: "done", chapters: "done" },
  }
  return state
}

describe("DirectorView（60 号设计：开书导演主视图）", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
  })

  it("无持久化 → 显示开书启动引导态", async () => {
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-start")).toBeInTheDocument())
  })

  it("点击开书启动 → 持久化新管线 → 显示 idea 表单", async () => {
    mocks.writeFileAtomic.mockImplementation(async (_path: string, content: string) => {
      mocks.readFile.mockResolvedValue(content)
      mocks.fileExists.mockResolvedValue(true)
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-start")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-start"))
    await waitFor(() => expect(screen.getByTestId("director-idea-title")).toBeInTheDocument())
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/.novel/director-pipeline.json",
      expect.stringContaining('"currentPhase"'),
    )
  })

  it("有持久化 → 直接显示管线 + 填好立意", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-phase-idea")).toBeInTheDocument())
    expect(screen.getByTestId("director-idea-title")).toHaveValue("雾都")
  })

  it("idea 未填全 → 显示缺口提示", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify(makeFile({ ideaInput: { title: "", genre: "", coreConflict: "" } })),
    )
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-idea-hint")).toBeInTheDocument())
  })

  it("推进未过门 → 显示 gap（书名缺失）", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify(makeFile({ ideaInput: { title: "", genre: "", coreConflict: "" } })),
    )
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
  })

  it("填立意后推进 idea → 状态前移 world running", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    mocks.writeFileAtomic.mockImplementation(async (_path: string, content: string) => {
      mocks.readFile.mockResolvedValue(content)
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() =>
      expect(screen.getByTestId("director-phase-world")).toHaveAttribute("data-status", "running"),
    )
  })

  it("全 done → 完成横幅 + 前往审查中心按钮", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify(makeFile({ state: fullDoneState() })),
    )
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-completed")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-goto-review"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("reviewCenter")
  })
})
