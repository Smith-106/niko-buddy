// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { SimulationConfigPanel } from "./simulation-config-panel"
import { useStorySimulationStore } from "@/stores/story-simulation-store"

function state() {
  return useStorySimulationStore.getState()
}

beforeEach(() => {
  document.body.innerHTML = ""
  // reset() 保留用户配置项（mode/字数/章节/轮次），此处显式归位保证用例隔离
  useStorySimulationStore.getState().reset()
  useStorySimulationStore.setState({
    mode: "event-driven",
    userIdea: "",
    targetWords: 10000,
    sourceChapters: 10,
    simulationRounds: 0,
    directorEnabled: false,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useStorySimulationStore.getState().reset()
})

describe("SimulationConfigPanel 模式选择", () => {
  it("渲染四种模式；默认选中事件驱动", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    expect(screen.getByText("事件驱动")).toBeTruthy()
    expect(screen.getByText("自由涌现")).toBeTruthy()
    expect(screen.getByText("决策树")).toBeTruthy()
    expect(screen.getByText("混合模式")).toBeTruthy()
    expect(state().mode).toBe("event-driven")
  })

  it("点击切换模式并更新详情区", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    fireEvent.click(screen.getByText("自由涌现"))
    expect(state().mode).toBe("free-emergence")
    expect(screen.getByText("角色自由互动，剧情自然发展，惊喜多")).toBeTruthy()
    expect(screen.getByText("探索角色可能性，寻找灵感和意外剧情")).toBeTruthy()
    fireEvent.click(screen.getByText("决策树"))
    expect(state().mode).toBe("decision-tree")
    fireEvent.click(screen.getByText("混合模式"))
    expect(state().mode).toBe("hybrid")
    expect(screen.getByText("平衡推进与自由，综合表现佳，推荐首选")).toBeTruthy()
  })

  it("详情区渲染特性列表与三项指标", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    expect(screen.getByText("严格按节点目标推进剧情")).toBeTruthy()
    expect(screen.getByText("适中 (0.8x)")).toBeTruthy()
    expect(screen.getByText("低 (10%)")).toBeTruthy()
  })
})

describe("SimulationConfigPanel 用户思路", () => {
  it("输入同步到 store", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    const box = screen.getByPlaceholderText("描述你的故事构想，例如核心冲突、人物关系、想探索的主题……") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "山寨版三国 UNIQUE-IDEA-1" } })
    expect(state().userIdea).toBe("山寨版三国 UNIQUE-IDEA-1")
  })
})

describe("SimulationConfigPanel 目标字数", () => {
  it("点击预设切换字数", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    expect(state().targetWords).toBe(10000)
    fireEvent.click(screen.getByText("3万字"))
    expect(state().targetWords).toBe(30000)
    fireEvent.click(screen.getByText("5万字"))
    expect(state().targetWords).toBe(50000)
  })

  it("自定义输入合法数字生效；非法/非正数被忽略", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    const input = screen.getByDisplayValue("10000") as HTMLInputElement
    fireEvent.change(input, { target: { value: "66666" } })
    expect(state().targetWords).toBe(66666)
    fireEvent.change(input, { target: { value: "0" } })
    expect(state().targetWords).toBe(66666)
    fireEvent.change(input, { target: { value: "-5" } })
    expect(state().targetWords).toBe(66666)
    fireEvent.change(input, { target: { value: "" } })
    expect(state().targetWords).toBe(66666)
  })
})

describe("SimulationConfigPanel 章节与轮次", () => {
  it("章节下拉切换", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(state().sourceChapters).toBe(10)
    fireEvent.change(select, { target: { value: "30" } })
    expect(state().sourceChapters).toBe(30)
  })

  it("轮次按钮切换（含自动 0 轮）", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    expect(state().simulationRounds).toBe(0)
    fireEvent.click(screen.getByText("标准（3轮）"))
    expect(state().simulationRounds).toBe(3)
    fireEvent.click(screen.getByText("快速（2轮）"))
    expect(state().simulationRounds).toBe(2)
    fireEvent.click(screen.getByText("深度（5轮）"))
    expect(state().simulationRounds).toBe(5)
    fireEvent.click(screen.getByText("自动（按字数）"))
    expect(state().simulationRounds).toBe(0)
  })
})

describe("SimulationConfigPanel 高级设置与启动", () => {
  it("导演开关双向切换", () => {
    render(<SimulationConfigPanel onStart={() => {}} />)
    const box = screen.getByRole("checkbox") as HTMLInputElement
    expect(state().directorEnabled).toBe(false)
    fireEvent.click(box)
    expect(state().directorEnabled).toBe(true)
    fireEvent.click(box)
    expect(state().directorEnabled).toBe(false)
  })

  it("开始按钮触发 onStart", () => {
    const onStart = vi.fn()
    render(<SimulationConfigPanel onStart={onStart} />)
    fireEvent.click(screen.getByText("开始提取"))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
