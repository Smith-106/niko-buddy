// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { DirectorPanel } from "./director-panel"
import { createDirectorPipeline, advanceDirectorPhase } from "@/lib/novel/director-pipeline"
import type { PhaseGateInput } from "@/lib/novel/director-pipeline"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (k === "directorPanel.retryCount") return `重试 ${opts?.count ?? 0} 次`
    return k
  } }),
}))

const FULL_GATE: PhaseGateInput = {
  idea: { title: "T", genre: "G", coreConflict: "C" },
  worldComplete: true,
  protagonistNamed: true,
  antagonistNamed: true,
  frameworkChosen: true,
  volumesPlanned: true,
  firstChapterReady: true,
}

function stateAtPhase(input: PhaseGateInput = FULL_GATE): ReturnType<typeof createDirectorPipeline> {
  let state = createDirectorPipeline()
  for (let i = 0; i < 5; i++) {
    const r = advanceDirectorPhase(state, input)
    if (!r.advanced) break
    state = r.state
    if (r.completed) break
  }
  return state
}

describe("DirectorPanel（60 号设计：开书导演 UI）", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("渲染 5 阶段列表", () => {
    render(<DirectorPanel state={createDirectorPipeline()} onAdvance={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByTestId("director-phases")).toBeInTheDocument()
    expect(screen.getByTestId("director-phase-idea")).toHaveAttribute("data-status", "running")
    expect(screen.getByTestId("director-phase-world")).toHaveAttribute("data-status", "pending")
    expect(screen.getByTestId("director-phase-chapters")).toHaveAttribute("data-status", "pending")
  })

  it("推进按钮触发 onAdvance", () => {
    const onAdvance = vi.fn()
    render(<DirectorPanel state={createDirectorPipeline()} onAdvance={onAdvance} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByTestId("director-advance"))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it("全完成态：5 阶段 done + 完成横幅 + 无推进/重试按钮", () => {
    const done = stateAtPhase()
    render(<DirectorPanel state={done} onAdvance={vi.fn()} onRetry={vi.fn()} />)
    for (const phase of ["idea", "world", "character", "outline", "chapters"]) {
      expect(screen.getByTestId(`director-phase-${phase}`)).toHaveAttribute("data-status", "done")
    }
    expect(screen.getByTestId("director-completed")).toBeInTheDocument()
    expect(screen.queryByTestId("director-retry")).not.toBeInTheDocument()
    expect(screen.queryByTestId("director-advance")).not.toBeInTheDocument()
  })

  it("failed 态：显示重试按钮 + 缺口提示", () => {
    // 构造 failed：门失败
    const state = createDirectorPipeline()
    const badInput: PhaseGateInput = { ...FULL_GATE, idea: { title: "", genre: "", coreConflict: "" } }
    const failed = advanceDirectorPhase(state, badInput).state // idea failed
    expect(failed.statuses.idea).toBe("failed")
    render(
      <DirectorPanel
        state={failed}
        gap="请先填写书名"
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-retry")).toBeInTheDocument()
    expect(screen.getByTestId("director-gap")).toHaveTextContent("请先填写书名")
    expect(screen.getByTestId("director-phase-idea")).toHaveAttribute("data-status", "failed")
  })

  it("重试按钮触发 onRetry", () => {
    const state = createDirectorPipeline()
    const badInput: PhaseGateInput = { ...FULL_GATE, idea: { title: "", genre: "", coreConflict: "" } }
    const failed = advanceDirectorPhase(state, badInput).state
    const onRetry = vi.fn()
    render(<DirectorPanel state={failed} onAdvance={vi.fn()} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId("director-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("busy 时推进按钮禁用", () => {
    render(
      <DirectorPanel
        state={createDirectorPipeline()}
        busy
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-advance")).toBeDisabled()
  })
})
