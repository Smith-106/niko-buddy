// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, within } from "@/test-helpers/component-test-utils"
import { RumorPropagationPanel } from "./rumor-propagation-panel"
import type { NovelAgent, RumorEvent, TimelineEvent } from "@/lib/novel"
import zh from "@/i18n/zh.json"

const t = zh.storySimulation as unknown as Record<string, string>

function fill(tpl: string, vars: Record<string, string | number>): string {
  let s = tpl
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(String(v))
  return s
}

function makeRumor(overrides: Partial<RumorEvent> = {}): RumorEvent {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    round: 0,
    nodeIndex: 0,
    sourceId: null,
    content: "传闻内容",
    distortion: 0.1,
    observableBy: [],
    believedBy: [],
    verifiedBy: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    generation: 0,
    ...overrides,
  }
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    round: 0,
    nodeIndex: 0,
    actorId: "a1",
    actorName: "寨主",
    actionType: "speak",
    content: "源事件内容。",
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeAgent(name: string): NovelAgent {
  return { characterId: `c-${name}`, name } as NovelAgent
}

function selectFilter(value: string): void {
  fireEvent.change(screen.getByRole("combobox"), { target: { value } })
}

function clickRumor(content: string): void {
  fireEvent.click(screen.getByRole("button", { name: content }))
}

beforeEach(() => {
  document.body.innerHTML = ""
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("RumorPropagationPanel 空态与初始态", () => {
  it("rumors 为空时显示无传闻数据", () => {
    render(<RumorPropagationPanel rumors={[]} agents={new Map()} events={[]} />)
    expect(screen.getByText(t.noRumorData)).toBeTruthy()
  })

  it("未选择传闻时显示列表与选择提示", () => {
    const rumors = [makeRumor({ id: "r1", content: "山下来了商队" })]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    expect(screen.getByRole("button", { name: "山下来了商队" })).toBeTruthy()
    expect(screen.getByText(t.selectRumorHint)).toBeTruthy()
  })
})

describe("RumorPropagationPanel 筛选器", () => {
  const rumors = [
    makeRumor({ id: "r-un", content: "未验证传闻", verifiedBy: [], distortion: 0.9 }),
    makeRumor({ id: "r-ok", content: "已验证传闻", verifiedBy: ["a1"], distortion: 0.2 }),
    makeRumor({ id: "r-bad", content: "已证伪传闻", verifiedBy: ["a1"], distortion: 0.7 }),
  ]

  function renderList() {
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
  }

  it("默认 all 显示全部三条", () => {
    renderList()
    expect(screen.getByRole("button", { name: "未验证传闻" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "已验证传闻" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "已证伪传闻" })).toBeTruthy()
  })

  it("unverified 只显示 verifiedBy 为空的（失真再高也不计入别档）", () => {
    renderList()
    selectFilter("unverified")
    expect(screen.getByRole("button", { name: "未验证传闻" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "已验证传闻" })).toBeNull()
    expect(screen.queryByRole("button", { name: "已证伪传闻" })).toBeNull()
  })

  it("verified 要求 verifiedBy 非空且 distortion < 0.5", () => {
    renderList()
    selectFilter("verified")
    expect(screen.getByRole("button", { name: "已验证传闻" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "未验证传闻" })).toBeNull()
    expect(screen.queryByRole("button", { name: "已证伪传闻" })).toBeNull()
  })

  it("falsified 要求 verifiedBy 非空且 distortion >= 0.5（含 0.5 边界）", () => {
    const edge = [
      makeRumor({ id: "e1", content: "边界传闻", verifiedBy: ["a1"], distortion: 0.5 }),
      makeRumor({ id: "e2", content: "低失真已验证", verifiedBy: ["a1"], distortion: 0.49 }),
    ]
    render(<RumorPropagationPanel rumors={edge} agents={new Map()} events={[]} />)
    selectFilter("falsified")
    expect(screen.getByRole("button", { name: "边界传闻" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "低失真已验证" })).toBeNull()
    cleanup()
    render(<RumorPropagationPanel rumors={edge} agents={new Map()} events={[]} />)
    selectFilter("verified")
    expect(screen.getByRole("button", { name: "低失真已验证" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "边界传闻" })).toBeNull()
  })

  it("筛选无匹配时显示空提示", () => {
    const onlyVerified = [makeRumor({ id: "r-ok", content: "已验证传闻", verifiedBy: ["a1"] })]
    render(<RumorPropagationPanel rumors={onlyVerified} agents={new Map()} events={[]} />)
    selectFilter("unverified")
    expect(screen.getByText(t.noMatchingRumors)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "已验证传闻" })).toBeNull()
  })
})

describe("RumorPropagationPanel 传闻详情", () => {
  it("点击传闻显示详情：内容、失真率、可见/验证人数", () => {
    const rumors = [
      makeRumor({
        id: "r1",
        content: "粮仓失火了",
        distortion: 0.2,
        observableBy: ["a1", "a2", "a3", "a4", "a5"],
        believedBy: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
        verifiedBy: ["a1", "a2", "a3"],
      }),
    ]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    clickRumor("粮仓失火了")
    expect(screen.getByText(t.rumorDetail)).toBeTruthy()
    expect(screen.getByText(t.spreadTree)).toBeTruthy()
    expect(screen.getByText(t.distortionRate)).toBeTruthy()
    expect(screen.getByText("20%")).toBeTruthy()
    // observableBy 5 只出现在详情统计格（列表按钮只展示相信/验证数）
    expect(screen.getByText("5")).toBeTruthy()
    // verifiedBy 3 同时出现在列表按钮与详情统计格
    expect(screen.getAllByText("3")).toHaveLength(2)
  })

  it("切换选择会更新详情内容", () => {
    const rumors = [
      makeRumor({ id: "r1", content: "第一条传闻", distortion: 0.1 }),
      makeRumor({ id: "r2", content: "第二条传闻", distortion: 0.8 }),
    ]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    clickRumor("第一条传闻")
    expect(screen.getByText("10%")).toBeTruthy()
    clickRumor("第二条传闻")
    expect(screen.getByText("80%")).toBeTruthy()
    expect(screen.queryByText("10%")).toBeNull()
  })

  it("失真徽章三档样式：<0.3 成功 / <0.6 警告 / 否则危险（含 0.3/0.6 边界）", () => {
    const rumors = [
      makeRumor({ id: "r1", content: "低失真", distortion: 0.1 }),
      makeRumor({ id: "r2", content: "恰0.3", distortion: 0.3 }),
      makeRumor({ id: "r3", content: "恰0.6", distortion: 0.6 }),
    ]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    const low = screen.getByText(fill(t.distortion, { value: "10" })).closest("span") as HTMLElement
    const mid = screen.getByText(fill(t.distortion, { value: "30" })).closest("span") as HTMLElement
    const high = screen.getByText(fill(t.distortion, { value: "60" })).closest("span") as HTMLElement
    expect(low.className).toContain("bg-success/15")
    expect(mid.className).toContain("bg-warning/15")
    expect(high.className).toContain("bg-destructive/15")
    // 详情统计格文字颜色同样三档
    clickRumor("恰0.3")
    const stat = screen.getByText("30%")
    expect(stat.className).toContain("text-warning-foreground")
  })

  it("列表展示轮次与相信/验证人数", () => {
    const rumors = [
      makeRumor({ id: "r1", content: "计数传闻", round: 2, believedBy: ["a", "b"], verifiedBy: ["c"] }),
    ]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    expect(screen.getByText(fill(t.roundLabel, { round: 3 }))).toBeTruthy()
    const btn = screen.getByRole("button", { name: "计数传闻" })
    expect(within(btn).getByText("2")).toBeTruthy()
    expect(within(btn).getByText("1")).toBeTruthy()
  })
})

describe("RumorPropagationPanel 传播树", () => {
  function familyRumors() {
    return [
      makeRumor({
        id: "r-root",
        content: "根部传闻内容",
        generation: 0,
        spreadBy: "a1",
        sourceId: "e1",
        observableBy: ["a1"],
        believedBy: ["a1", "a2"],
      }),
      makeRumor({
        id: "r-child",
        content: "一代传播内容",
        generation: 1,
        parentId: "r-root",
        spreadBy: "ghost",
        sourceId: "e1",
        observableBy: ["a2", "a3", "a4"],
        believedBy: ["a2"],
      }),
      makeRumor({
        id: "r-grand",
        content: "二代传播内容",
        generation: 2,
        parentId: "r-child",
        observableBy: [],
        believedBy: [],
      }),
    ]
  }

  function agentsMap() {
    return new Map<string, NovelAgent>([["a1", makeAgent("寨主")]])
  }

  it("选中子代仍从根展示整棵树：原始徽章、代数、传播者与人数", () => {
    render(
      <RumorPropagationPanel
        rumors={familyRumors()}
        agents={agentsMap()}
        events={[makeEvent({ id: "e1" })]}
      />,
    )
    clickRumor("一代传播内容")
    // 根徽章与两代标签
    expect(screen.getByText(t.originalRumor)).toBeTruthy()
    expect(screen.getByText(fill(t.generation, { gen: 1 }))).toBeTruthy()
    expect(screen.getByText(fill(t.generation, { gen: 2 }))).toBeTruthy()
    // 传播者：已知 agent 显示名、未知 id 回退显示原 id、无 spreadBy 则不渲染该行
    expect(screen.getByText(fill(t.spreader, { name: "寨主" }))).toBeTruthy()
    expect(screen.getByText(fill(t.spreader, { name: "ghost" }))).toBeTruthy()
    expect(screen.queryByText(fill(t.spreader, { name: "" }))).toBeNull()
    // 人数（各节点计数互不相同，避免多节点同文）
    expect(screen.getByText(fill(t.visiblePeople, { count: 1 }))).toBeTruthy()
    expect(screen.getByText(fill(t.visiblePeople, { count: 3 }))).toBeTruthy()
    expect(screen.getByText(fill(t.believedPeople, { count: 2 }))).toBeTruthy()
    // 根的源事件块只出现一次（子代节点传入 sourceEvent=null）
    expect(screen.getByText("源事件内容。")).toBeTruthy()
  })

  it("sourceId 为空或事件不存在时不渲染源事件块", () => {
    render(<RumorPropagationPanel rumors={familyRumors()} agents={agentsMap()} events={[]} />)
    clickRumor("根部传闻内容")
    expect(screen.queryByText("源事件内容。")).toBeNull()
    expect(screen.getByText(t.originalRumor)).toBeTruthy()
  })

  it("actionTypeLabel 全分支映射", () => {
    const cases: Array<[string, string]> = [
      ["evaluate", t.actionEvaluate],
      ["pushPlot", t.rumorActionDefault],
      ["observe", t.actionObserve],
      ["react", t.actionReact],
      ["speak", t.rumorActionSpeak],
      ["ally", t.actionAlly],
      ["confront", t.actionConfront],
      ["conceal", t.actionConceal],
      ["investigate", t.actionInvestigate],
      ["act", t.rumorActionDefault],
    ]
    for (const [actionType, label] of cases) {
      const { unmount } = render(
        <RumorPropagationPanel
          rumors={[makeRumor({ id: "r1", content: `传闻-${actionType}`, sourceId: "e1" })]}
          agents={new Map()}
          events={[
            makeEvent({ id: "e1", actorName: "张三", actionType: actionType as never, content: "源事件内容。" }),
          ]}
        />,
      )
      clickRumor(`传闻-${actionType}`)
      expect(screen.getByText(fill(t.sourceEvent, { name: "张三", action: label }))).toBeTruthy()
      unmount()
      cleanup()
    }
  })

  it("选中孤立传闻（无 parentId）时树只有根节点", () => {
    const rumors = [makeRumor({ id: "solo", content: "孤立传闻", generation: 0 })]
    render(<RumorPropagationPanel rumors={rumors} agents={new Map()} events={[]} />)
    clickRumor("孤立传闻")
    expect(screen.getByText(t.originalRumor)).toBeTruthy()
    expect(screen.queryByText(fill(t.generation, { gen: 1 }))).toBeNull()
  })
})

describe("选中项被新数据移除", () => {
  it("选中传闻 A 后父级只回传 B → 家谱树为空（!target 早退），不崩", () => {
    const a = makeRumor({ id: "ra", content: "山下来了商队" })
    const b = makeRumor({ id: "rb", content: "城主病重" })
    const { rerender } = render(
      <RumorPropagationPanel rumors={[a, b]} agents={new Map()} events={[]} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "山下来了商队" }))
    rerender(<RumorPropagationPanel rumors={[b]} agents={new Map()} events={[]} />)
    expect(screen.queryByRole("button", { name: "山下来了商队" })).toBeNull()
    expect(screen.getByRole("button", { name: "城主病重" })).toBeTruthy()
  })
})
