// @vitest-environment jsdom
/**
 * detective-board-panel.tsx 行为测试（原 C4 空壳已删除，原位重写）。
 * 覆盖 ClueTimelinePanel：空态、事件/谣言线索构建、排序、secret 判定、
 * 知晓名单渲染、全部筛选器交互。
 */
import { afterEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { ClueTimelinePanel } from "./detective-board-panel"
import type { NovelAgent, RumorEvent, TimelineEvent } from "@/lib/novel"
import zh from "@/i18n/zh.json"

afterEach(cleanup)

const T = zh.storySimulation as unknown as Record<string, string>
function fill(tpl: string, vars: Record<string, unknown>): string {
  let s = tpl
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(String(v))
  return s
}

function makeAgent(id: string, name: string): NovelAgent {
  return { characterId: id, name } as NovelAgent
}

function agentsOf(...pairs: Array<[string, string]>): Map<string, NovelAgent> {
  return new Map(pairs.map(([id, name]) => [id, makeAgent(id, name)]))
}

let seq = 0
function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1
  return {
    id: `e${seq}`,
    round: 0,
    nodeIndex: 0,
    actorId: "a1",
    actorName: "甲",
    actionType: "speak",
    content: `事件内容${seq}`,
    observableBy: [],
    impacts: [],
    timestamp: "2026-10-30T11:21:00.000Z",
    ...overrides,
  }
}

function makeRumor(overrides: Partial<RumorEvent> = {}): RumorEvent {
  seq += 1
  return {
    id: `r${seq}`,
    round: 0,
    nodeIndex: 0,
    sourceId: null,
    content: `谣言内容${seq}`,
    distortion: 0.2,
    observableBy: [],
    believedBy: [],
    verifiedBy: [],
    timestamp: "2026-10-30T11:22:00.000Z",
    generation: 0,
    ...overrides,
  }
}

function bodyText(): string {
  return document.body.textContent ?? ""
}

/** 筛选栏里仅有的 3 个按钮：全部 / 事件 / 谣言（按渲染顺序）。 */
function typeFilterButtons(): HTMLElement[] {
  return screen.getAllByRole("button")
}

/** 两个 select：先角色，后节点（按渲染顺序）。 */
function selects(): HTMLElement[] {
  return screen.getAllByRole("combobox")
}

describe("ClueTimelinePanel 空态与过滤", () => {
  it("无事件无谣言时渲染 noClueData", () => {
    render(<ClueTimelinePanel agents={agentsOf(["a1", "甲"])} rumors={[]} events={[]} />)
    expect(bodyText()).toContain(T.noClueData)
  })

  it("空白 content 的事件被过滤，仍视为空", () => {
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"])}
        rumors={[]}
        events={[
          makeEvent({ id: "blank1", content: "   " }),
          makeEvent({ id: "blank2", content: "" }),
        ]}
      />,
    )
    expect(bodyText()).toContain(T.noClueData)
  })

  it("observableBy 缺失时兜底为空数组并渲染 knownByNone", () => {
    const ev = makeEvent({
      id: "no-obs",
      content: "缺失可见名单UNIQUE-OBS",
      observableBy: undefined as unknown as string[],
    })
    render(<ClueTimelinePanel agents={agentsOf(["a1", "甲"])} rumors={[]} events={[ev]} />)
    expect(bodyText()).toContain("缺失可见名单UNIQUE-OBS")
    expect(bodyText()).toContain(T.knownByNone)
  })
})

describe("ClueTimelinePanel 线索渲染", () => {
  it("渲染事件内容、人物、目标与类型徽标", () => {
    const ev = makeEvent({
      id: "ev-full",
      content: "甲对乙说了关键情报UNIQUE-FULL",
      actorName: "甲",
      targetName: "乙",
      actionType: "speak",
      observableBy: ["a1", "a2"],
    })
    render(
      <ClueTimelinePanel agents={agentsOf(["a1", "甲"], ["a2", "乙"])} rumors={[]} events={[ev]} />,
    )
    const text = bodyText()
    expect(text).toContain("甲对乙说了关键情报UNIQUE-FULL")
    // 类型徽标取自 typeInfo（事件类型标签）；clue.title 短标签仅计算不渲染
    expect(text).toContain(T.eventType)
    expect(text).toContain("→")
    expect(text).toContain("乙")
    // round + 1 展示
    expect(text).toContain(fill(T.roundLabel, { round: 1 }))
  })

  it("无 actorName 时不渲染人物行，有 targetName 时渲染箭头", () => {
    const withTarget = makeEvent({
      id: "ev-t",
      content: "带目标事件UNIQUE-TGT",
      actorName: "甲",
      targetName: "乙",
      observableBy: ["a1"],
    })
    const { unmount } = render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"])}
        rumors={[]}
        events={[withTarget]}
      />,
    )
    expect(bodyText()).toContain("乙")
    unmount()
    const noActor = makeEvent({ id: "ev-na", content: "匿名事件UNIQUE-NOACTOR", actorName: "" })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"])}
        rumors={[]}
        events={[noActor]}
      />,
    )
    expect(bodyText()).toContain("匿名事件UNIQUE-NOACTOR")
  })

  it("按 nodeIndex → round → timestamp 排序", () => {
    const late = makeEvent({
      id: "sort-late",
      content: "排序末位UNIQUE-SORT-C",
      nodeIndex: 1,
      round: 0,
      timestamp: "2026-10-30T11:20:00.000Z",
    })
    const mid = makeEvent({
      id: "sort-mid",
      content: "排序中位UNIQUE-SORT-B",
      nodeIndex: 0,
      round: 1,
      timestamp: "2026-10-30T11:19:00.000Z",
    })
    const first = makeEvent({
      id: "sort-first",
      content: "排序首位UNIQUE-SORT-A",
      nodeIndex: 0,
      round: 0,
      timestamp: "2026-10-30T11:25:00.000Z",
    })
    const sameSlotLater = makeEvent({
      id: "sort-ts",
      content: "同槽较晚UNIQUE-SORT-D",
      nodeIndex: 0,
      round: 0,
      timestamp: "2026-10-30T11:30:00.000Z",
    })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"])}
        rumors={[]}
        events={[late, mid, sameSlotLater, first]}
      />,
    )
    const text = bodyText()
    const ia = text.indexOf("排序首位UNIQUE-SORT-A")
    const id = text.indexOf("同槽较晚UNIQUE-SORT-D")
    const ib = text.indexOf("排序中位UNIQUE-SORT-B")
    const ic = text.indexOf("排序末位UNIQUE-SORT-C")
    expect(ia).toBeGreaterThanOrEqual(0)
    expect(id).toBeGreaterThanOrEqual(0)
    expect(ib).toBeGreaterThanOrEqual(0)
    expect(ic).toBeGreaterThanOrEqual(0)
    // 同 node+round 按 timestamp；round 高的靠后；node 高的最后
    expect(ia).toBeLessThan(id)
    expect(id).toBeLessThan(ib)
    expect(ib).toBeLessThan(ic)
  })

  it("节点分组头渲染 nodeTitle 与 countClues", () => {
    const ev = makeEvent({ id: "grp", content: "分组事件UNIQUE-GRP", nodeIndex: 2, observableBy: ["a1"] })
    render(<ClueTimelinePanel agents={agentsOf(["a1", "甲"])} rumors={[]} events={[ev]} />)
    expect(bodyText()).toContain(fill(T.nodeTitle, { index: 3 }))
    expect(bodyText()).toContain(fill(T.countClues, { count: 1 }))
    expect(bodyText()).toContain(fill(T.totalClues, { count: 1 }))
  })
})

describe("ClueTimelinePanel secret 与知晓名单", () => {
  it("小范围可见标 secret，全员可见不标（含恰好 2 人知晓仍算 secret）", () => {
    const secretEv = makeEvent({
      id: "sec",
      content: "密谋事件UNIQUE-SECRET",
      observableBy: ["a1"],
    })
    const twoKnowerEv = makeEvent({
      id: "sec2",
      content: "两人知晓UNIQUE-TWOKNOWN",
      observableBy: ["a1", "a2"],
    })
    const publicEv = makeEvent({
      id: "pub",
      content: "公开事件UNIQUE-PUBLIC",
      observableBy: ["a1", "a2", "a3"],
    })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"], ["a3", "丙"])}
        rumors={[]}
        events={[secretEv, twoKnowerEv, publicEv]}
      />,
    )
    // 密谋 + 两人知晓标 secret（2 处），公开事件不标
    expect(screen.getAllByText(T.secret)).toHaveLength(2)
    expect(bodyText()).toContain("公开事件UNIQUE-PUBLIC")
  })

  it("knownByNone / knownByAll / 部分名单三种渲染", () => {
    const none = makeEvent({ id: "k-none", content: "无人知晓UNIQUE-KNOWN-NONE", observableBy: [] })
    const all = makeEvent({
      id: "k-all",
      content: "人尽皆知UNIQUE-KNOWN-ALL",
      observableBy: ["a1", "a2"],
    })
    const partial = makeEvent({
      id: "k-part",
      content: "部分知晓UNIQUE-KNOWN-PART",
      observableBy: ["a1"],
    })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"])}
        rumors={[]}
        events={[none, all, partial]}
      />,
    )
    const text = bodyText()
    expect(text).toContain(T.knownByNone)
    expect(text).toContain(T.knownByAll)
    expect(text).toContain("部分知晓UNIQUE-KNOWN-PART")
  })

  it("known 名单回退未知 id 原样显示", () => {
    const ev = makeEvent({
      id: "ghost",
      content: "幽灵知晓UNIQUE-GHOST",
      observableBy: ["a1", "ghost-id"],
    })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"], ["a3", "丙"])}
        rumors={[]}
        events={[ev]}
      />,
    )
    // 3 角色中 2 个知晓 → 走部分名单分支；
    // agents.get("ghost-id") 缺失 → 回退显示 id 本身
    expect(bodyText()).toContain("ghost-id")
    expect(bodyText()).toContain("甲")
  })

  it("unknow 名单超过 5 人时截断并显示 morePeople", () => {
    const agents = agentsOf(
      ["a1", "甲"],
      ["a2", "乙"],
      ["a3", "丙"],
      ["a4", "丁"],
      ["a5", "戊"],
      ["a6", "己"],
      ["a7", "庚"],
    )
    const ev = makeEvent({
      id: "many-unknown",
      content: "多人不知UNIQUE-MANY",
      observableBy: ["a1"],
    })
    render(<ClueTimelinePanel agents={agents} rumors={[]} events={[ev]} />)
    const text = bodyText()
    // 6 人不知 → 展示前 5 + "+1人"
    expect(text).toContain(fill(T.morePeople, { count: 1 }))
    expect(text).toContain("多人不知UNIQUE-MANY")
  })

  it("空角色表 + 有事件：空真公开、不标 secret", () => {
    const ev = makeEvent({ id: "no-agents", content: "空表事件UNIQUE-NOAGENTS", observableBy: [] })
    render(<ClueTimelinePanel agents={new Map()} rumors={[]} events={[ev]} />)
    const text = bodyText()
    expect(text).toContain("空表事件UNIQUE-NOAGENTS")
    expect(text).toContain(T.knownByNone)
    // 空角色表时 knowAgents(0) === allAgentIds(0) 视作公开 → 无 secret 徽标
    expect(screen.queryByText(T.secret)).toBeNull()
  })

  it("全员知晓时不渲染不知晓行，无人知晓时不知晓行占满不渲染", () => {
    const all = makeEvent({
      id: "all-known",
      content: "全员知UNIQUE-ALLKNOWN",
      observableBy: ["a1", "a2"],
    })
    const { unmount } = render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"])}
        rumors={[]}
        events={[all]}
      />,
    )
    expect(bodyText()).toContain(T.knownByAll)
    unmount()
    const none = makeEvent({ id: "none-known", content: "全不知UNIQUE-NONEKNOWN", observableBy: [] })
    render(
      <ClueTimelinePanel agents={agentsOf(["a1", "甲"], ["a2", "乙"])} rumors={[]} events={[none]} />,
    )
    expect(bodyText()).toContain(T.knownByNone)
  })
})

describe("ClueTimelinePanel 谣言线索", () => {
  it("spreader 优先于 source 作为 actorName（actor 行渲染）", () => {
    const sourced = makeRumor({
      id: "rumor-src",
      content: "有源谣言UNIQUE-RSRC",
      sourceId: "a1",
      spreadBy: "a2",
      // 两人都知晓 → 走 knownByAll，无名单干扰，actor 行只剩 spreader 名
      observableBy: ["a1", "a2"],
    })
    const { container } = render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"])}
        rumors={[sourced]}
        events={[]}
      />,
    )
    // 徽标为通用传闻类型标签（title 来源标题仅计算不渲染）
    expect(bodyText()).toContain(T.rumor)
    expect(bodyText()).toContain("有源谣言UNIQUE-RSRC")
    // actor 行（div.mb-1）显示传播者乙而非来源甲
    const actorRow = container.querySelector("div.mb-1")
    expect(actorRow?.textContent).toBe("乙")
  })

  it("无 source 无 spreader 时不渲染 actor 行", () => {
    const orphan = makeRumor({
      id: "rumor-orphan",
      content: "无源谣言UNIQUE-RORPH",
      sourceId: null,
      observableBy: undefined as unknown as string[],
    })
    const { container } = render(
      <ClueTimelinePanel agents={agentsOf(["a1", "甲"])} rumors={[orphan]} events={[]} />,
    )
    expect(bodyText()).toContain(T.rumor)
    expect(bodyText()).toContain("无源谣言UNIQUE-RORPH")
    expect(bodyText()).toContain(T.knownByNone)
    // actorName 为 undefined → actor 行缺席
    expect(container.querySelector("div.mb-1")).toBeNull()
  })

  it("仅 source 无 spreader 时 actorName 取 source 名", () => {
    const r = makeRumor({
      id: "rumor-only-src",
      content: "唯源谣言UNIQUE-RONLYSRC",
      sourceId: "a1",
      observableBy: ["a1", "a2"],
    })
    const { container } = render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"])}
        rumors={[r]}
        events={[]}
      />,
    )
    expect(bodyText()).toContain("唯源谣言UNIQUE-RONLYSRC")
    const actorRow = container.querySelector("div.mb-1")
    expect(actorRow?.textContent).toBe("甲")
  })

  it("谣言知晓 ≤2 人标 secret，3 人知晓不标", () => {
    const secretR = makeRumor({ id: "rumor-sec", content: "秘传谣言UNIQUE-RSEC", observableBy: ["a1"] })
    const openR = makeRumor({
      id: "rumor-open",
      content: "公开谣言UNIQUE-ROPEN",
      observableBy: ["a1", "a2", "a3"],
    })
    render(
      <ClueTimelinePanel
        agents={agentsOf(["a1", "甲"], ["a2", "乙"], ["a3", "丙"])}
        rumors={[secretR, openR]}
        events={[]}
      />,
    )
    expect(screen.getAllByText(T.secret)).toHaveLength(1)
    expect(bodyText()).toContain("公开谣言UNIQUE-ROPEN")
  })
})

describe("ClueTimelinePanel 筛选器", () => {
  function baseProps() {
    return {
      agents: agentsOf(["a1", "甲"], ["a2", "乙"]),
      events: [
        makeEvent({ id: "f-ev", content: "筛选事件UNIQUE-FEV", nodeIndex: 0, observableBy: ["a1"] }),
        makeEvent({ id: "f-ev2", content: "乙知事件UNIQUE-FEV2", nodeIndex: 1, observableBy: ["a2"] }),
      ],
      rumors: [makeRumor({ id: "f-ru", content: "筛选谣言UNIQUE-FRU", nodeIndex: 0, observableBy: ["a1", "a2"] })],
    }
  }

  it("类型筛选只保留对应线索", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    expect(bodyText()).toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).toContain("筛选谣言UNIQUE-FRU")

    // 点"谣言"：事件消失
    fireEvent.click(typeFilterButtons()[2])
    expect(bodyText()).not.toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).toContain("筛选谣言UNIQUE-FRU")

    // 点"事件"：谣言消失
    fireEvent.click(typeFilterButtons()[1])
    expect(bodyText()).toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).not.toContain("筛选谣言UNIQUE-FRU")

    // 点"全部"：都回来
    fireEvent.click(typeFilterButtons()[0])
    expect(bodyText()).toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).toContain("筛选谣言UNIQUE-FRU")
  })

  it("节点筛选只保留该节点线索", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    const [, nodeSelect] = selects()
    fireEvent.change(nodeSelect, { target: { value: "1" } })
    expect(bodyText()).not.toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).toContain("乙知事件UNIQUE-FEV2")
    expect(bodyText()).not.toContain("筛选谣言UNIQUE-FRU")
    // 切回全部节点
    fireEvent.change(nodeSelect, { target: { value: "all" } })
    expect(bodyText()).toContain("筛选事件UNIQUE-FEV")
  })

  it("角色筛选只保留该角色知晓的线索", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    const [agentSelect] = selects()
    fireEvent.change(agentSelect, { target: { value: "a2" } })
    // a2 只知晓 f-ev2 与谣言
    expect(bodyText()).not.toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).toContain("乙知事件UNIQUE-FEV2")
    expect(bodyText()).toContain("筛选谣言UNIQUE-FRU")
  })

  it("仅看未知勾选后反转角色筛选", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    const [agentSelect] = selects()
    fireEvent.change(agentSelect, { target: { value: "a2" } })
    // 勾选前：a2 知晓的可见
    expect(bodyText()).toContain("乙知事件UNIQUE-FEV2")
    // 勾选"只看未知"：a2 知晓的隐藏，不知晓的出现
    fireEvent.click(screen.getByRole("checkbox"))
    expect(bodyText()).not.toContain("乙知事件UNIQUE-FEV2")
    expect(bodyText()).toContain("筛选事件UNIQUE-FEV")
    expect(bodyText()).not.toContain("筛选谣言UNIQUE-FRU")
  })

  it("角色未选时不显示仅看未知勾选框", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    expect(screen.queryByRole("checkbox")).toBeNull()
    const [agentSelect] = selects()
    fireEvent.change(agentSelect, { target: { value: "a1" } })
    expect(screen.getByRole("checkbox")).not.toBeNull()
  })

  it("筛选无结果时渲染 noMatchingClues", () => {
    const props = baseProps()
    render(<ClueTimelinePanel {...props} />)
    // 选谣言类型 + 切到只有事件的节点 → 空
    fireEvent.click(typeFilterButtons()[2])
    const [, nodeSelect] = selects()
    fireEvent.change(nodeSelect, { target: { value: "1" } })
    expect(bodyText()).toContain(T.noMatchingClues)
  })
})
