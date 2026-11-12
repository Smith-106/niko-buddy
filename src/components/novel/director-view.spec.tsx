// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest"
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

// W-覆盖增补缝：@tauri-apps/api/core 默认透传真实 invoke（与既有行为一致，
// 仅在骨架非空用例里 mockImplementationOnce 注入 entities 目录树）。
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: vi.fn(actual.invoke),
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

// 用例级所有权：每个用例自行卸载渲染根（本文件未启用 vitest globals，RTL 自动 cleanup 不生效）。
afterEach(() => cleanup())

// 所有权守卫：文件结束时不得残留渲染容器（RTL 自动 cleanup 未安装时的回归探测）。
afterAll(() => {
  const leftovers = [...document.body.children].map((el) => `<${el.tagName.toLowerCase()}>`)
  expect(leftovers, "渲染容器在文件结束后仍残留于 document.body").toEqual([])
  expect(document.body.childElementCount).toBe(0)
})

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

describe("DirectorView 覆盖增补（产物读取降级）", () => {
  beforeEach(() => {
    resetMocks()
    cleanup()
    vi.clearAllMocks()
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
  })

  it("产物清单读取抛错 → 降级为空产物，主界面与阶段面板照常渲染", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile({ state: fullDoneState() })))
    // 产物文件存在但读盘失败的等价形态：loadStageArtifacts 抛错（已在生产侧 try/catch 外的
    // 调用点用 .catch 兑底）。断言降级为空产物而不是空自崩。
    const novel = await import("@/lib/novel")
    const spy = vi.spyOn(novel, "loadStageArtifacts").mockRejectedValue(new Error("EIO: artifacts unreadable"))

    render(<DirectorView projectId="/proj" />)

    await waitFor(() => expect(spy).toHaveBeenCalledWith("/proj"))
    // 降级后不崩：完成横幅与阶段面板仍在，产物区因空产物而缺席
    await waitFor(() => expect(screen.getByTestId("director-completed")).toBeInTheDocument())
    expect(screen.queryByTestId("director-artifact-idea")).toBeNull()
    expect(screen.getByTestId("director-runlog")).toBeInTheDocument()
  })
})

describe("DirectorView 覆盖增补（W-未覆盖分支）", () => {
  // 原文件 beforeEach 挂在第一个 describe 内，此处镜像同一份装配（不改既有用例）。
  beforeEach(() => {
    resetMocks()
    cleanup()
    vi.clearAllMocks()
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
  })

  it("编辑立意字段 → 输入值更新并落盘 ideaInput", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-idea-title")).toBeInTheDocument())
    fireEvent.change(screen.getByTestId("director-idea-title"), { target: { value: "新雾都" } })
    fireEvent.change(screen.getByTestId("director-idea-genre"), { target: { value: "科幻" } })
    fireEvent.change(screen.getByTestId("director-idea-conflict"), { target: { value: "新冲突" } })
    expect(screen.getByTestId("director-idea-title")).toHaveValue("新雾都")
    expect(screen.getByTestId("director-idea-genre")).toHaveValue("科幻")
    expect(screen.getByTestId("director-idea-conflict")).toHaveValue("新冲突")
    await waitFor(() =>
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
        "/proj/.novel/director-pipeline.json",
        expect.stringContaining("新雾都"),
      ),
    )
  })

  it("推进被门挡下 → gap 显示 blockedReason + 运行记录记未过门 + 草稿收据可见", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockResolvedValue({
      state: createDirectorPipeline(),
      advanced: false,
      completed: false,
      generated: true,
      stage: "idea",
      blockedReason: "世界骨架未完备",
      drafts: [{ id: "d1", chapterName: "第一章", chars: 500 }],
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("世界骨架未完备")
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "gating")
    expect(screen.getByTestId("director-draft-receipt")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("未过门：世界骨架未完备")).toBeInTheDocument()
  })

  it("推进返回 error → gap 显示推进失败 + 状态 failed", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockResolvedValue({
      state: createDirectorPipeline(),
      advanced: false,
      completed: false,
      generated: true,
      stage: "idea",
      error: "门炸了",
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("门炸了")
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "failed")
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("推进失败：门炸了")).toBeInTheDocument()
  })

  it("推进抛 Error → gap 显示异常信息 + 状态 failed", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockRejectedValue(new Error("LLM 爆炸"))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("LLM 爆炸")
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "failed")
  })

  it("推进抛非 Error 值 → gap 显示字符串", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockRejectedValue("字符串爆炸")
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("字符串爆炸")
  })

  it("推进无任何原因 → gap 不显示 + 运行记录记原因未知", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    advanceMock.fn.mockResolvedValue({
      state: createDirectorPipeline(),
      advanced: false,
      completed: false,
      generated: true,
      stage: "idea",
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    await waitFor(() => expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "gating"))
    expect(screen.queryByTestId("director-gap")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("未过门：原因未知")).toBeInTheDocument()
  })

  it("失败态点重试 → 状态写回 + 运行记录记重试", async () => {
    const base = createDirectorPipeline()
    const failedState: DirectorPipelineState = {
      ...base,
      currentPhase: "idea",
      statuses: { ...base.statuses, idea: "failed" },
    }
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile({ state: failedState })))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-retry")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-retry"))
    await waitFor(() => expect(mocks.writeFileAtomic).toHaveBeenCalled())
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "idle")
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("重试当前阶段")).toBeInTheDocument()
  })

  it("生成世界骨架（空项目）→ gap 提示未检测到项目实体", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-generate-blueprint")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-generate-blueprint"))
    await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
    expect(screen.getByTestId("director-gap").textContent).toContain("directorPanel.blueprintEmpty")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      expect.stringContaining("world-blueprint.json"),
      expect.any(String),
    )
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getByText("世界骨架为空：未检测到项目实体")).toBeInTheDocument()
  })

  it("生成世界骨架（有角色实体）→ gap 提示已生成草稿", async () => {
    // 挂载期刷新也会调 list_directory，必须常驻注入（finally 恢复透传默认实现）。
    const { invoke } = await import("@tauri-apps/api/core")
    const mocked = vi.mocked(invoke)
    const prevImpl = mocked.getMockImplementation()
    mocked.mockImplementation(async (cmd, args) => {
      const p = String((args as { path?: unknown } | undefined)?.path ?? "")
      if (cmd === "list_directory" && p.includes("wiki/entities")) {
        return [{ name: "zhang.md", path: "/proj/wiki/entities/characters/zhang.md", is_dir: false }]
      }
      throw new Error("tauri unavailable in jsdom")
    })
    try {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
      render(<DirectorView projectId="/proj" />)
      await waitFor(() => expect(screen.getByTestId("director-generate-blueprint")).toBeInTheDocument())
      fireEvent.click(screen.getByTestId("director-generate-blueprint"))
      await waitFor(() => expect(screen.getByTestId("director-gap")).toBeInTheDocument())
      expect(screen.getByTestId("director-gap").textContent).toContain("directorPanel.blueprintDone")
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining("world-blueprint.json"),
        expect.stringContaining("zhang"),
      )
      fireEvent.click(screen.getByTestId("director-runlog-toggle"))
      expect(screen.getByText("已根据实体生成世界骨架草稿")).toBeInTheDocument()
    } finally {
      mocked.mockReset()
      if (prevImpl) mocked.mockImplementation(prevImpl)
    }
  })

  it("已启动 + LLM 不可用：banner 本地写作 → 建 chapter-001 并跳写作工作区", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    // 首 call（hasPersisted）放行 true，章节循环一律 false → 落 chapter-001
    mocks.fileExists.mockResolvedValue(false)
    mocks.fileExists.mockResolvedValueOnce(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-llm-blocked-banner")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-local-write-banner"))
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

  it("已启动 + LLM 不可用：chapter-001 已存在 → 追加 chapter-002", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    mocks.fileExists.mockImplementation(async (path: string) =>
      path.endsWith("director-pipeline.json") || path.endsWith("chapter-001.md"),
    )
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-local-write-banner")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-local-write-banner"))
    await waitFor(() =>
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
        "C:/proj/book/QM/chapters/chapter-002.md",
        // 立意标题非空 → 沿用立意标题（雾都），仅章节号递增不断言默认标题
        expect.stringContaining("chapter: 2"),
      ),
    )
  })

  it("本地写作 999 上限：fileExists 恒真 → 落到 chapter-999", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    mocks.fileExists.mockResolvedValue(true)
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-local-write-banner")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-local-write-banner"))
    await waitFor(() =>
      expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
        "C:/proj/book/QM/chapters/chapter-999.md",
        expect.any(String),
      ),
    )
  })

  it("project 缺失时本地写作为空操作", async () => {
    mocks.project = null
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-local-write-banner")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-local-write-banner"))
    await waitFor(() => expect(screen.getByTestId("director-local-write-banner")).toBeInTheDocument())
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("banner 配置模型 → 跳设置", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-configure-llm-banner")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-configure-llm-banner"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")
  })

  it("未启动态配置模型 → 跳设置", async () => {
    mocks.llmConfig = { provider: "openai", apiKey: "", model: "" }
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-configure-llm")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-configure-llm"))
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")
  })

  it("unmount 取消：has 阶段取消不触发加载", async () => {
    let resolveHas!: (v: boolean) => void
    mocks.fileExists.mockImplementationOnce(() => new Promise<boolean>((res) => { resolveHas = res }))
    const first = render(<DirectorView projectId="/proj" />)
    first.unmount()
    resolveHas(true)
    await waitFor(() => expect(mocks.readFile).not.toHaveBeenCalled())
    // 取消后重挂载仍可正常加载
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-idea-title")).toBeInTheDocument())
  })

  it("unmount 取消：load 阶段取消不写状态", async () => {
    let resolveLoad!: (v: string) => void
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockImplementationOnce(() => new Promise<string>((res) => { resolveLoad = res }))
    const first = render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalled())
    first.unmount()
    resolveLoad(JSON.stringify(makeFile()))
    // 取消后重挂载仍可正常加载
    mocks.readFile.mockResolvedValue(JSON.stringify(makeFile()))
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-idea-title")).toBeInTheDocument())
  })

  it("运行记录级别筛选：info/success/error/all", async () => {
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
    fireEvent.click(screen.getByTestId("director-runlog-toggle"))
    expect(screen.getAllByTestId("director-runlog-item")).toHaveLength(2)
    fireEvent.click(screen.getByTestId("director-runlog-filter-success"))
    expect(screen.getAllByTestId("director-runlog-item")).toHaveLength(1)
    expect(screen.getByText("推进成功，进入下一阶段")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-filter-info"))
    expect(screen.getAllByTestId("director-runlog-item")).toHaveLength(1)
    expect(screen.getByText("开始推进当前阶段")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-filter-error"))
    expect(screen.getByTestId("director-runlog-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("director-runlog-filter-all"))
    expect(screen.getAllByTestId("director-runlog-item")).toHaveLength(2)
  })
})

describe("DirectorView statements 缺口补齐（第十五批）", () => {
  beforeEach(() => {
    resetMocks()
    cleanup()
    vi.clearAllMocks()
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
  })

  it("非立意阶段推进 → 不查立意必填项，直接跑管线", async () => {
    const base = createDirectorPipeline()
    const worldState: DirectorPipelineState = {
      ...base,
      currentPhase: "world",
      statuses: { ...base.statuses, idea: "done" },
    }
    // 立意输入全空，但当前阶段是 world：必填校验只对 idea 阶段生效，不应拦下推进。
    const file = makeFile({ state: worldState, ideaInput: { title: "", genre: "", coreConflict: "" } })
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify(file))
    advanceMock.fn.mockResolvedValue({
      state: worldState,
      advanced: true,
      completed: false,
      generated: true,
      stage: "world",
    })
    render(<DirectorView projectId="/proj" />)
    await waitFor(() => expect(screen.getByTestId("director-advance")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("director-advance"))
    // 推进完成契约：phase-status 变 advanced 且推进按钮退出 busy（disabled={busy}，finally 复位）
    await waitFor(() =>
      expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "advanced"),
    )
    await waitFor(() => expect(screen.getByTestId("director-advance")).not.toBeDisabled())
    expect(advanceMock.fn).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("director-gap")).not.toBeInTheDocument()
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "advanced")
  })
})
