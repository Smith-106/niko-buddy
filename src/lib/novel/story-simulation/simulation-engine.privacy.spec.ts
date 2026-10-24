import { describe, expect, it, vi } from "vitest"
import type { NovelAgent, SimulationState, StoryNode, ExtractionResult } from "@/lib/novel/story-simulation/types"
import { createSimulationBlackboard } from "@/lib/novel/story-simulation/multi-agent-orchestrator"
import { agentDecideAndActWithReact } from "@/lib/novel/story-simulation/simulation-engine"

let mockRun: any

vi.mock("@/lib/agent/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/runner")>()
  return {
    ...actual,
    AgentRunner: class {
      run(...args: any[]) {
        return mockRun(...args)
      }
    },
  }
})

function makeAgent(id: string, name: string): NovelAgent {
  return {
    characterId: id,
    name,
    profile: `${name}的档案`,
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
      sentiments: new Map([[id === "a" ? "b" : "a", 20]]),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: [],
    speakingStyle: "",
  }
}

function makeNode(): StoryNode {
  return {
    index: 0,
    phase: "起",
    title: "开端",
    coreConflict: "冲突",
    involvedCharacters: ["甲", "乙"],
    goal: "推进剧情",
    causeFromPrev: "无",
    expectedOutcome: "完成开端",
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

function makeState(agents: NovelAgent[]): SimulationState {
  return {
    currentRound: 0,
    timelineEvents: [],
    activeAgents: new Map(agents.map((a) => [a.characterId, a])),
    worldState: {},
    directorEnabled: false,
    nextNodeInjectionMap: new Map(),
  }
}

function userText(): string {
  const callArgs = mockRun.mock.calls[0]
  const messages = callArgs[2] as Array<{ role: string; content: string }>
  return messages.filter((m) => m.role === "user").map((m) => m.content).join("\n")
}

describe("recentEventDescs 认知边界过滤", () => {
  it("乙的 self 内心戏不泄进甲的 Prompt", async () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    const agents = [agentA, agentB]
    const node = makeNode()
    const state = makeState(agents)
    const extraction = makeExtraction()
    const blackboard = createSimulationBlackboard({ agents })

    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "公开招呼",
        visibility: "all",
        motivation: "打招呼",
        plot_push: "建立联系",
      }),
    })

    const leaked = "乙 心中评价：甲的秘密计划绝不能让甲知道"
    await agentDecideAndActWithReact(agentA, node, state, {} as any, extraction, [leaked], undefined, blackboard)

    expect(userText()).not.toContain("甲的秘密计划绝不能让甲知道")
  })

  it("好感度显示真实姓名而非机器 ID", async () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    const agents = [agentA, agentB]
    const node = makeNode()
    const state = makeState(agents)
    const extraction = makeExtraction()
    const blackboard = createSimulationBlackboard({ agents })

    mockRun = vi.fn().mockResolvedValue({
      toolCalls: [],
      roundsUsed: 1,
      finalText: JSON.stringify({
        type: "speak",
        content: "你好",
        visibility: "all",
        motivation: "打招呼",
        plot_push: "建立联系",
      }),
    })

    await agentDecideAndActWithReact(agentA, node, state, {} as any, extraction, [], undefined, blackboard)

    const text = userText()
    expect(text).toContain("对角色[乙]")
    expect(text).not.toMatch(/对角色\[b\]/)
  })
})
