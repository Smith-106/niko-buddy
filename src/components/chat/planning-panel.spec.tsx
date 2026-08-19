// @vitest-environment jsdom
/**
 * Wave 3 计划模式 — PlanningPanel 组件测试（受控纯展示）。
 * 三类数据只读展示 + degraded 可见标记 + 刷新/开写/关闭动作出口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { PlanningPanel, type PlanningPanelProps } from "./planning-panel"
import type { ChapterPlanView } from "@/lib/novel/planning"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makePlan(overrides: Partial<ChapterPlanView> = {}): ChapterPlanView {
  return {
    chapterNumber: 8,
    generatedAt: "2026-08-18T00:00:00.000Z",
    foreshadowing: {
      status: "ok",
      report: {
        debtScore: 12,
        items: [
          {
            id: "f1",
            name: "青铜古戒",
            description: "",
            status: "planted",
            plantedChapter: 2,
            chaptersSincePlanted: 6,
            debtLevel: "critical",
          },
        ],
      },
      overdueFindings: [],
    },
    characters: {
      status: "ok",
      items: [
        {
          name: "林动",
          lastSeenChapter: 7,
          inCurrentOutline: true,
          chaptersSinceSeen: 1,
        },
        {
          name: "应欢欢",
          lastSeenChapter: 1,
          inCurrentOutline: false,
          chaptersSinceSeen: 7,
        },
      ],
    },
    threads: {
      status: "ok",
      items: [
        {
          subplotId: "s1",
          title: "宗门大比",
          arcState: "Rising",
          basis: "progress",
        },
      ],
      openCount: 1,
    },
    summary: { debtScore: 12, criticalForeshadowing: 1, openThreads: 1, charactersDue: 0 },
    ...overrides,
  }
}

function makeProps(overrides: Partial<PlanningPanelProps> = {}): PlanningPanelProps {
  return {
    plan: makePlan(),
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    onStartWriting: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe("PlanningPanel", () => {
  beforeEach(() => {
    setupDomGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it("渲染三类数据（伏笔债务/角色出场/支线推进）", () => {
    render(<PlanningPanel {...makeProps()} />)
    expect(screen.getByText("青铜古戒")).toBeTruthy()
    expect(screen.getByText("林动")).toBeTruthy()
    expect(screen.getByText("宗门大比")).toBeTruthy()
    expect(screen.getByText("critical")).toBeTruthy()
    expect(screen.getByText("Rising")).toBeTruthy()
  })

  it("loading 时显示骨架而非数据", () => {
    render(<PlanningPanel {...makeProps({ loading: true, plan: null })} />)
    expect(screen.queryByText("青铜古戒")).toBeNull()
  })

  it("error 时显示错误信息", () => {
    render(<PlanningPanel {...makeProps({ plan: null, error: "读取失败" })} />)
    expect(screen.getByText("读取失败")).toBeTruthy()
  })

  it("degraded 维度显示可见标记", () => {
    const plan = makePlan()
    plan.characters.status = "degraded"
    plan.characters.items = []
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("数据源不可用").length).toBeGreaterThan(0)
  })

  it("刷新/关闭/开写动作出口触发回调", () => {
    const props = makeProps()
    render(<PlanningPanel {...props} />)
    fireEvent.click(screen.getByLabelText("刷新"))
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText("关闭"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText("以此计划开写"))
    expect(props.onStartWriting).toHaveBeenCalledTimes(1)
    expect(props.onStartWriting).toHaveBeenCalledWith(props.plan)
  })

  it("空数据（ok 状态）渲染空态文案", () => {
    const plan = makePlan({
      foreshadowing: { status: "ok", report: { debtScore: 0, items: [] }, overdueFindings: [] },
      characters: { status: "ok", items: [] },
      threads: { status: "ok", items: [], openCount: 0 },
    })
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("无未回收伏笔").length).toBeGreaterThan(0)
  })

  it("plan 为 null 且无 loading/error → 不渲染数据区", () => {
    render(<PlanningPanel {...makeProps({ plan: null })} />)
    expect(screen.queryByText("伏笔债务")).toBeNull()
    expect(screen.queryByText("支线推进")).toBeNull()
  })

  it("foreshadowing/threads degraded → 数据源不可用标记", () => {
    const plan = makePlan()
    plan.foreshadowing.status = "degraded"
    plan.threads.status = "degraded"
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getAllByText("数据源不可用").length).toBeGreaterThanOrEqual(2)
  })

  it("未知 debtLevel/arcState → 样式回退；已退场/逾期/违规标注", () => {
    const plan = makePlan()
    plan.foreshadowing.report!.items[0] = {
      ...plan.foreshadowing.report!.items[0],
      debtLevel: "unknown" as never,
    }
    plan.characters.items = [
      { name: "林动", lastSeenChapter: 7, inCurrentOutline: true, chaptersSinceSeen: 1, isAlive: false },
      { name: "应欢欢", lastSeenChapter: 1, inCurrentOutline: false, chaptersSinceSeen: 12 },
    ]
    plan.threads.items[0] = {
      ...plan.threads.items[0],
      arcState: "Unknown" as never,
      transitionViolation: "Resolved 后仍有新增进度条目",
    }
    render(<PlanningPanel {...makeProps({ plan })} />)
    expect(screen.getByText("unknown")).toBeTruthy()
    expect(screen.getByText("已退场")).toBeTruthy()
    expect(screen.getByText(/已 .*章未出场/)).toBeTruthy()
    expect(screen.getByText("Unknown")).toBeTruthy()
    expect(screen.getByText("Resolved 后仍有新增进度条目")).toBeTruthy()
  })
})
