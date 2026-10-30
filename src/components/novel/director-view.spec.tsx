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
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
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
  mocks.writeFileAtomic.mockReset()
  mocks.createDirectory.mockReset()
  mocks.setActiveView.mockReset()
  mocks.setSelectedFile.mockReset()
  advanceMock.fn.mockReset()
  // 默认恢复可用 LLM
  mocks.llmConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" }
  mocks.project = { id: "p1", name: "测试之书", path: "C:/proj/book" }
}

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string) => k }),
}))

const advanceMock = vi.hoisted(() => ({ fn: vi.fn() }))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    advanceDirectorAutomatically: (...args: unknown[]) => advanceMock.fn(...args),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      fileExists: mocks.fileExists,
      readFile: mocks.readFile,
      writeFileAtomic: mocks.writeFileAtomic,
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
    advanceMock.fn.mockResolvedValue({
      state: createDirectorPipeline(),
      advanced: false,
      completed: false,
      generated: true,
      stage: "idea",
      blockedReason: "书名缺失",
      gap: "请先填写书名",
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    // 批次二·9：必填项为空时不跑管线，直接告诉作者缺哪几项。
    expect(screen.getByTestId("director-gap").textContent).toContain("directorPanel.ideaMissing")
    expect(advanceMock.fn).not.toHaveBeenCalled()
  })

  it("填立意后推进 idea → 走自动生成链路，状态前移 world running 且展示产物摘要", async () => {
    mocks.fileExists.mockResolvedValue(true)
    const file = makeFile()
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("director-stage-artifacts")) {
        return JSON.stringify({
          version: "1.0",
          stages: {
            idea: { title: "雾都", genre: "悬疑", coreConflict: "C", logline: "l", hooks: ["h1", "h2"] },
          },
        })
      }
      return JSON.stringify(file)
    })
    advanceMock.fn.mockImplementation(async (_projectPath: string, state: DirectorPipelineState) => {
      const { advanceDirectorPhase } = await import("@/lib/novel")
      const result = advanceDirectorPhase(state, {
        idea: { title: "雾都", genre: "悬疑", coreConflict: "C" },
        worldComplete: false,
        protagonistNamed: false,
        antagonistNamed: false,
        frameworkChosen: false,
        volumesPlanned: false,
        firstChapterReady: false,
      })
      return { state: result.state, advanced: true, completed: false, generated: true, stage: "idea", cached: false }
    })
    mocks.writeFileAtomic.mockImplementation(async (_path: string, content: string) => {
      mocks.readFile.mockImplementation(async (path: string) =>
        path.includes("director-stage-artifacts")
          ? JSON.stringify({ version: "1.0", stages: { idea: { title: "雾都", genre: "悬疑", coreConflict: "C", logline: "l", hooks: ["h1", "h2"] } } })
          : content,
      )
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() =>
      expect(screen.getByTestId("director-phase-world")).toHaveAttribute("data-status", "running"),
    )
    expect(advanceMock.fn).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "advanced")
    await waitFor(() => expect(screen.getByTestId("director-artifact-idea")).toBeInTheDocument())
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
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
        "C:/proj/book/QM/chapters/chapter-001.md",
        expect.stringContaining("chapter: 1"),
      )
      expect(mocks.setSelectedFile).toHaveBeenCalledWith("C:/proj/book/QM/chapters/chapter-001.md")
      expect(mocks.setActiveView).toHaveBeenCalledWith("wiki")
    })
  })

  it("推进中可终止：signal 中断 → 缺口提示终止且恢复空闲", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockImplementation(
      (_p: string, _s: unknown, _i: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          opts?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")))
        }),
    )
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    // 在途：推进按钮 busy 禁用 + loading，终止按钮出现
    await waitFor(() => expect(screen.getByTestId("director-terminate")).toBeInTheDocument())
    expect(screen.getByTestId("director-advance")).toBeDisabled()
    fireEvent.click(screen.getByTestId("director-terminate"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("directorPanel.terminated")
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "idle")
    expect(screen.getByTestId("director-advance")).not.toBeDisabled()
    expect(screen.queryByTestId("director-terminate")).not.toBeInTheDocument()
  })

  it("调度运行记录：成功记 success，级别筛选可折叠过滤", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockResolvedValue({
      state: createDirectorPipeline(),
      advanced: true,
      completed: false,
      generated: true,
      stage: "idea",
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() =>
      expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "advanced"),
    )
    // 默认折叠：无条目渲染
    expect(screen.queryByTestId("director-runlog-item")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("开始推进当前阶段")).toBeInTheDocument()
    expect(screen.getByText("推进成功，进入下一阶段")).toBeInTheDocument()
    // 切到失败级别 → 两条都被滤掉，显示空态
    fireEvent.click(screen.getByTestId("director-runlog-filter-error"))
    expect(screen.queryByTestId("director-runlog-item")).not.toBeInTheDocument()
    expect(screen.getByTestId("director-runlog-empty")).toBeInTheDocument()
    // 切回全部 → 恢复
    fireEvent.click(screen.getByTestId("director-runlog-filter-all"))
    expect(screen.getAllByTestId("director-runlog-item")).toHaveLength(2)
  })
})
