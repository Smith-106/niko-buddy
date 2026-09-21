// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { DirectorView } from "./director-view"
import { createDirectorPipeline } from "@/lib/novel"
import type { DirectorPipelineState, DirectorPersistedFile } from "@/lib/novel"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeFile: vi.fn(async () => {}),
  createDirectory: vi.fn(),
  setActiveView: vi.fn(),
  setSelectedFile: vi.fn(),
  // J05：可用 LLM 配置（usable 态）——默认让原有用例走 LLM 可用路径
  llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" } as Record<string, unknown>,
  project: { id: "p1", name: "测试之书", path: "C:/proj/book" } as Record<string, unknown> | null,
}))

function resetMocks() {
  mocks.fileExists.mockReset()
  mocks.readFile.mockReset()
  mocks.writeFileAtomic.mockReset()
  mocks.writeFile.mockReset()
  mocks.createDirectory.mockReset()
  mocks.setActiveView.mockReset()
  mocks.setSelectedFile.mockReset()
  // 默认恢复可用 LLM
  mocks.llmConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" }
  mocks.project = { id: "p1", name: "测试之书", path: "C:/proj/book" }
}

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      fileExists: mocks.fileExists,
      readFile: mocks.readFile,
      writeFileAtomic: mocks.writeFileAtomic,
      writeFile: mocks.writeFile,
      createDirectory: mocks.createDirectory,
    
  }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (sel: (s: Record<string, unknown>) => unknown) =>
        sel({
          setActiveView: mocks.setActiveView,
          setSelectedFile: mocks.setSelectedFile,
          llmConfig: mocks.llmConfig,
          project: mocks.project,
        }),
    
  }
})

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
    resetMocks()
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

  it("LLM 未配置（F-010）→ 显示本地写作分流而非开书启动", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" } // unconfigured → llmBlocked
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-llm-blocked")).toBeInTheDocument())
    // 不再渲染 LLM 开书启动 CTA，改显本地写作 + 立即配置
    expect(screen.queryByTestId("director-start")).not.toBeInTheDocument()
    expect(screen.getByTestId("director-local-write")).toBeInTheDocument()
    expect(screen.getByTestId("director-configure-llm")).toBeInTheDocument()
  })

  it("LLM 未配置点「继续本地写作」→ 建 chapter-001 + 跳写作工作区", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-local-write")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-local-write"))
    await waitFor(() => {
      expect(mocks.createDirectory).toHaveBeenCalledWith("C:/proj/book/QM/chapters")
      expect(mocks.writeFile).toHaveBeenCalledWith(
        "C:/proj/book/QM/chapters/chapter-001.md",
        expect.stringContaining("chapter: 1"),
      )
      expect(mocks.setSelectedFile).toHaveBeenCalledWith("C:/proj/book/QM/chapters/chapter-001.md")
      expect(mocks.setActiveView).toHaveBeenCalledWith("wiki")
    })
  })
})
