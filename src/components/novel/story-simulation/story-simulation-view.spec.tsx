// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  StorySimulationView,
  branchProbabilityWidth,
  buildConflictDraft,
  pickConflictEvents,
  scoreBarWidth,
} from "./story-simulation-view"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type { SimulationReport, StoryFramework, TimelineEvent } from "@/lib/novel"

const wikiState = vi.hoisted(() => ({
  project: { id: "p1", name: "proj", path: "C:/proj" },
  llmConfig: null,
  dataVersion: 1,
  setSelectedFile: vi.fn(),
  setActiveView: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof wikiState) => unknown) => selector(wikiState),
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts && typeof opts.count === "number" ? `${key}#${opts.count}` : key,
  }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}))

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "e1",
    round: 1,
    nodeIndex: 0,
    actorId: "c1",
    actorName: "寨主",
    actionType: "speak",
    content: "今夜子时动手。",
    observableBy: [],
    impacts: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeReport(): SimulationReport {
  return {
    frameworkId: "fw1",
    mode: "event-driven",
    characterAnalyses: [
      { characterId: "c1", name: "寨主", behaviors: [], stateChanges: [], consistencyScore: 82 },
      { characterId: "c2", name: "军师", behaviors: [], stateChanges: [], consistencyScore: 45 },
    ],
    branches: [
      {
        title: "夜袭",
        summary: "s",
        keyEvents: [],
        probability: "high",
        pros: "",
        cons: "",
        recommendation: true,
      },
    ],
    recommendation: "r",
    createdAt: new Date().toISOString(),
  }
}

function makeFramework(): StoryFramework {
  return {
    id: "fw1",
    title: "测试框架",
    premise: "premise",
    targetWords: 1000,
    simulationMode: "event-driven",
    sourceChapters: 0,
    nodes: [],
  } as unknown as StoryFramework
}

describe("pickConflictEvents", () => {
  it("只收对抗/推进/对话/反应四类有正文事件", () => {
    const events = [
      makeEvent({ id: "a", actionType: "confront", content: "拔刀。" }),
      makeEvent({ id: "b", actionType: "observe", content: "他看了看天。" }),
      makeEvent({ id: "c", actionType: "speak", content: "   " }),
      makeEvent({ id: "d", actionType: "pushPlot", content: "火起。" }),
    ]
    expect(pickConflictEvents(events).map((e) => e.id)).toEqual(["a", "d"])
  })
})

describe("buildConflictDraft", () => {
  it("每冲突事件一节，原文直送无改写", () => {
    const draft = buildConflictDraft(
      [makeEvent({ id: "a", actionType: "confront", content: "拔刀。" })],
      "fw1",
    )
    expect(draft.branchId).toBe("extracted-conflicts")
    expect(draft.frameworkId).toBe("fw1")
    expect(draft.chapters).toHaveLength(1)
    expect(draft.chapters[0].content).toBe("拔刀。")
    expect(draft.chapters[0].rawContent).toBe("拔刀。")
  })

  it("最多取 20 节", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `e${i}`, actionType: "speak", content: `台词${i}` }),
    )
    expect(buildConflictDraft(events, "fw1").chapters).toHaveLength(20)
  })
})

describe("scoreBarWidth / branchProbabilityWidth", () => {
  it("钳制越界与 NaN", () => {
    expect(scoreBarWidth(82)).toBe(82)
    expect(scoreBarWidth(150)).toBe(100)
    expect(scoreBarWidth(-3)).toBe(0)
    expect(scoreBarWidth(NaN)).toBe(0)
  })

  it("分支概率映射 high=100/medium=60/low=30", () => {
    expect(branchProbabilityWidth("high")).toBe(100)
    expect(branchProbabilityWidth("medium")).toBe(60)
    expect(branchProbabilityWidth("low")).toBe(30)
  })
})

describe("StorySimulationView 3 coreIssues wiring", () => {
  beforeEach(() => {
    useStorySimulationStore.setState({
      phase: "simulating",
      timelineEvents: [
        makeEvent({ id: "e1", actorName: "寨主", content: "今夜子时动手。" }),
        makeEvent({ id: "e2", actorName: "军师", content: "不可，需再探。", actionType: "react" }),
      ],
      debugTraces: [],
      currentRumors: [],
      currentAgents: new Map(),
      branches: [],
      currentReport: null,
      currentDraft: null,
      currentFramework: makeFramework(),
    })
  })

  afterEach(() => {
    cleanup()
    useStorySimulationStore.setState({
      phase: "idle",
      timelineEvents: [],
      currentReport: null,
      currentDraft: null,
    })
  })

  it("推演中渲染实时台词气泡", async () => {
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByTestId("sim-live-bubbles")).toBeTruthy())
    expect(screen.getByTestId("sim-live-bubble-e1").textContent).toContain("今夜子时动手")
    expect(screen.getByTestId("sim-live-bubble-e2").textContent).toContain("军师")
  })

  it("报告页渲染图形化打分条", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport() })
    render(<StorySimulationView />)
    await waitFor(() => expect(screen.getByTestId("sim-score-overview")).toBeTruthy())
    const bar = screen.getByTestId("sim-score-bar-c1")
    expect(bar.getAttribute("style")).toContain("82%")
    expect(screen.getByTestId("sim-branch-bar-0").getAttribute("style")).toContain("100%")
  })

  it("一键提取冲突动作直送正文草稿并切到草稿视图", async () => {
    useStorySimulationStore.setState({ phase: "report-viewing", currentReport: makeReport() })
    render(<StorySimulationView />)
    fireEvent.click(screen.getByText("时间线"))
    await waitFor(() => expect(screen.getByTestId("sim-extract-conflicts")).toBeTruthy())
    fireEvent.click(screen.getByTestId("sim-extract-conflicts"))
    await waitFor(() =>
      expect(useStorySimulationStore.getState().phase).toBe("draft-viewing"),
    )
    const draft = useStorySimulationStore.getState().currentDraft
    expect(draft).not.toBeNull()
    expect(draft?.chapters.length).toBeGreaterThan(0)
    expect(draft?.chapters[0].content).toContain("今夜子时动手")
  })
})
