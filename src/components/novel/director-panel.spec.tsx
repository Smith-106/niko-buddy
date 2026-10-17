// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { DirectorPanel } from "./director-panel"
import { createDirectorPipeline, advanceDirectorPhase } from "@/lib/novel"
import type { PhaseGateInput } from "@/lib/novel"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (k === "directorPanel.retryCount") return `重试 ${opts?.count ?? 0} 次`
    if (k === "directorPanel.artifactIdea") return `立意卡《${opts?.title}》· ${opts?.genre} · ${opts?.hooks} 个钩子`
    if (k === "directorPanel.artifactCharacter") return `角色账本 ${opts?.count} 人（主角 ${opts?.protagonist}）`
    if (k === "directorPanel.artifactOutline") return `大纲：${opts?.framework} · ${opts?.volumes} 卷 · 计划 ${opts?.chapters} 章`
    if (k === "directorPanel.artifactChapters") return `首章《${opts?.title}》· ${opts?.beats} 个节拍`
    if (k === "directorPanel.draftReceipt") return `首章草稿已生成：${opts?.id}（${opts?.chars} 字，待你接受）`
    if (k === "directorPanel.lastError") return `失败原因：${opts?.error}`
    if (k === "directorPanel.statusGenerating") return `正在生成「${opts?.phase}」阶段产物…`
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

describe("DirectorPanel · 阶段生成状态与产物摘要（B 范围）", () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  const ARTIFACTS = {
    idea: { title: "雾都", genre: "悬疑", coreConflict: "C", logline: "l", hooks: ["h1", "h2"] },
    character: {
      characters: [
        { name: "陈默", role: "protagonist" as const, desire: "d", flaw: "f" },
        { name: "房东", role: "antagonist" as const, desire: "d", flaw: "f" },
      ],
    },
    outline: {
      framework: "三幕",
      volumes: [
        { title: "第一卷", arc: "起", chapterCount: 30 },
        { title: "第二卷", arc: "转", chapterCount: 32 },
      ],
    },
    chapters: { firstChapter: { title: "第一章 租约", beats: ["签合同", "让渡"], hook: "h" } },
  }

  it("idle：无产物时显示空态", () => {
    render(
      <DirectorPanel
        state={createDirectorPipeline()}
        progress={{ status: "idle", artifacts: null }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "idle")
    expect(screen.getByTestId("director-artifacts-empty")).toBeInTheDocument()
  })

  it("generating：显示生成中（busy 时插值当前阶段名）+ 旋转图标", () => {
    render(
      <DirectorPanel
        state={createDirectorPipeline()}
        busy
        progress={{ status: "generating", artifacts: null }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    const row = screen.getByTestId("director-phase-status")
    expect(row).toHaveAttribute("data-status", "generating")
    expect(row).toHaveTextContent("正在生成「directorPanel.phaseIdea」阶段产物…")
    expect(screen.getByTestId("director-phase-status-icon")).toBeInTheDocument()
  })

  it("gating：产物已生成待校验，并展示四阶段产物摘要", () => {
    render(
      <DirectorPanel
        state={createDirectorPipeline()}
        progress={{ status: "gating", artifacts: ARTIFACTS }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "gating")
    expect(screen.getByTestId("director-artifact-idea")).toHaveTextContent("立意卡《雾都》· 悬疑 · 2 个钩子")
    expect(screen.getByTestId("director-artifact-character")).toHaveTextContent("角色账本 2 人（主角 陈默）")
    expect(screen.getByTestId("director-artifact-outline")).toHaveTextContent("大纲：三幕 · 2 卷 · 计划 62 章")
    expect(screen.getByTestId("director-artifact-chapters")).toHaveTextContent("首章《第一章 租约》· 2 个节拍")
  })

  it("advanced：显示已推进，并展示首章草稿回执", () => {
    render(
      <DirectorPanel
        state={stateAtPhase()}
        progress={{
          status: "advanced",
          artifacts: ARTIFACTS,
          drafts: [{ id: "draft_1", chapterName: "第一章 租约", chars: 1800 }],
        }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "advanced")
    expect(screen.getByTestId("director-draft-receipt")).toHaveTextContent("首章草稿已生成：draft_1（1800 字，待你接受）")
  })

  it("failed：显示失败原因 + 重试按钮", () => {
    const badInput: PhaseGateInput = { ...FULL_GATE, idea: { title: "", genre: "", coreConflict: "" } }
    const failed = advanceDirectorPhase(createDirectorPipeline(), badInput).state
    render(
      <DirectorPanel
        state={failed}
        progress={{ status: "failed", error: "idea 阶段产物结构不合格：title 书名缺失", artifacts: null }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-phase-status")).toHaveAttribute("data-status", "failed")
    expect(screen.getByTestId("director-last-error")).toHaveTextContent("失败原因：idea 阶段产物结构不合格：title 书名缺失")
    expect(screen.getByTestId("director-retry")).toBeInTheDocument()
  })

  it("旧存档结构损坏的产物被跳过，不炸整页", () => {
    render(
      <DirectorPanel
        state={createDirectorPipeline()}
        progress={{ status: "gating", artifacts: { idea: { title: 1 } as never } }}
        onAdvance={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId("director-artifacts-empty")).toBeInTheDocument()
  })
})
