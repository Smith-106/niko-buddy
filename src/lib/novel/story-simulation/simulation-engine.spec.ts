import { describe, expect, it, vi } from "vitest"
import type {
  ExtractionResult,
  NovelAgent,
  StoryFramework,
  TimelineEvent,
} from "@/lib/novel/story-simulation/types"
import type { SimulationTelemetry } from "@/lib/novel/story-simulation/simulation-engine"
import { runSimulation } from "@/lib/novel/story-simulation/simulation-engine"

let mockRun: unknown

vi.mock("@/lib/agent/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/runner")>()
  return {
    ...actual,
    AgentRunner: class {
      run(...args: unknown[]) {
        return (mockRun as (...a: unknown[]) => Promise<unknown>)(...args)
      }
    },
    ModelDoesNotSupportToolsError: class extends Error {
      constructor() {
        super("当前模型不支持工具调用")
        this.name = "ModelDoesNotSupportToolsError"
      }
    },
  }
})

vi.mock("@/lib/embedding-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding-client")>()
  return {
    ...actual,
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
    cosineSimilarity: vi.fn().mockReturnValue(0),
  }
})

function makeAgent(): NovelAgent {
  return {
    characterId: "a",
    name: "甲",
    profile: "甲的档案",
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "完成当前目标",
    emotionalState: "neutral",
    knownFacts: new Set(),
    relationships: new Map(),
    powerLevel: "normal",
    memory: {
      observedEvents: [],
      knownSecrets: new Set(),
      sentiments: new Map(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: [],
    speakingStyle: "",
  }
}

function makeExtraction(): ExtractionResult {
  return {
    characters: [],
    chapterContents: [],
    memoryData: {
      characterStates: "",
      characterCognition: null,
      foreshadowingTracker: null,
      timeline: [],
      canonFacts: "",
      conflicts: "",
    },
    worldRules: "",
    powerSystem: "",
    foreshadowing: null,
    timeline: [],
    outlineContent: "",
    soulDoc: "",
  }
}

function makeFramework(): StoryFramework {
  return {
    id: "fw",
    title: "测试框架",
    premise: "测试",
    targetWords: 10000,
    simulationMode: "event-driven",
    sourceChapters: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    nodes: [
      {
        index: 0,
        phase: "起",
        title: "开端",
        coreConflict: "冲突",
        involvedCharacters: ["甲"],
        goal: "继续开端",
        causeFromPrev: "无",
        expectedOutcome: "完成开端",
      },
    ],
  }
}

describe("runSimulation engine telemetry", () => {
  it("emits onTelemetry once on completion with counts matching the run", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "遥测事件",
        visibility: "all",
        motivation: "推进",
        plot_push: "补完当前节点",
      }),
    })

    const telemetries: SimulationTelemetry[] = []
    const streamed: TimelineEvent[] = []

    const events = await runSimulation(
      {
        agents: [makeAgent()],
        framework: makeFramework(),
        mode: "event-driven",
        wordBudget: 10000,
        llmConfig: {},
        maxRoundsPerNode: 1,
      } as never,
      makeExtraction(),
      {
        onEvent: () => {},
        onProgress: () => {},
        onComplete: () => {},
        onError: () => {},
        onTimelineEvent: (event) => streamed.push(event),
        onTelemetry: (t) => telemetries.push(t),
      },
    )

    expect(telemetries).toHaveLength(1)
    const tele = telemetries[0]
    expect(tele.aborted).toBe(false)
    expect(tele.degraded).toBe(false)
    expect(tele.eventCount).toBe(events.length)
    expect(tele.eventCount).toBeGreaterThan(0)
    expect(tele.timelineEventCount).toBe(streamed.length)
    expect(tele.timelineEventCount).toBeGreaterThan(0)
    expect(tele.rounds).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(tele.latencyMs)).toBe(true)
    expect(tele.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(tele.timestamp))).toBe(false)
  })
})
