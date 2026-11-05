import { describe, expect, it, vi } from "vitest"
import type { NovelAgent, TimelineEvent } from "@/lib/novel/story-simulation/types"
import {
  createSimulationBlackboard,
  recordBlackboardEvent,
  type SimulationBlackboard,
} from "@/lib/novel/story-simulation/multi-agent-orchestrator"
import { createSimAgentTools } from "@/lib/novel/story-simulation/sim-agent-tools"
import { recordRumorEvent } from "@/lib/novel/story-simulation/multi-agent-orchestrator"
import type { RumorEvent } from "@/lib/novel/story-simulation/types"

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
      sentiments: new Map(),
      recentDecisions: [],
      rumorCredibility: 0.5,
    },
    knowledgeScope: [],
    personality: [],
    speakingStyle: "",
  }
}

function makeTimelineEvent(
  id: string,
  round: number,
  actorId: string,
  actorName: string,
  observableBy: string[],
  content: string,
): TimelineEvent {
  return {
    id,
    round,
    nodeIndex: 0,
    actorId,
    actorName,
    actionType: "speak",
    content,
    observableBy,
    impacts: [],
    timestamp: "2026-07-04T00:00:00.000Z",
  }
}

function setupTwoAgents(): {
  agentA: NovelAgent
  agentB: NovelAgent
  blackboard: SimulationBlackboard
} {
  const agentA = makeAgent("a", "甲")
  const agentB = makeAgent("b", "乙")
  const blackboard = createSimulationBlackboard({ agents: [agentA, agentB] })
  return { agentA, agentB, blackboard }
}

describe("createSimAgentTools", () => {
  it("creates a registry with 6 tools", () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    expect(registry.has("recall")).toBe(true)
    expect(registry.has("observe")).toBe(true)
    expect(registry.has("inquire")).toBe(true)
    expect(registry.has("introspect")).toBe(true)
    expect(registry.has("investigate")).toBe(true)
    expect(registry.has("spread_rumor")).toBe(true)
    expect(registry.list().length).toBe(6)
  })
})

describe("recall tool", () => {
  it("returns visible events for the agent", async () => {
    const { agentA, blackboard } = setupTwoAgents()

    const event1 = makeTimelineEvent("e1", 0, "b", "乙", ["a", "b"], "你好甲")
    const event2 = makeTimelineEvent("e2", 0, "a", "甲", ["a", "b"], "你好乙")
    const event3 = makeTimelineEvent("e3", 0, "b", "乙", ["b"], "我私下想")

    recordBlackboardEvent(blackboard, event1)
    recordBlackboardEvent(blackboard, event2)
    recordBlackboardEvent(blackboard, event3)

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("recall")!
    const result = await tool.execute({})

    expect(result).toContain("乙")
    expect(result).toContain("你好甲")
    expect(result).toContain("你好乙")
    expect(result).not.toContain("我私下想")
  })

  it("respects the limit parameter", async () => {
    const { agentA, blackboard } = setupTwoAgents()

    for (let i = 0; i < 10; i++) {
      const evt = makeTimelineEvent(`e${i}`, 0, "b", "乙", ["a", "b"], `事件${i}`)
      recordBlackboardEvent(blackboard, evt)
    }

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("recall")!
    const result = await tool.execute({ limit: 3 })

    const lines = result.split("\n").filter((l) => l.startsWith("- "))
    expect(lines.length).toBe(3)
  })

  it("returns empty message when no events", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("recall")!
    const result = await tool.execute({})

    expect(result).toContain("暂无可见事件")
  })
})

describe("observe tool", () => {
  it("returns public events from current round excluding self", async () => {
    const { agentA, blackboard } = setupTwoAgents()

    const round0Public = makeTimelineEvent("e1", 0, "b", "乙", ["a", "b"], "公开言论")
    const round0Self = makeTimelineEvent("e2", 0, "a", "甲", ["a", "b"], "自己说的话")
    const round1Public = makeTimelineEvent("e3", 1, "b", "乙", ["a", "b"], "下一轮的话")

    recordBlackboardEvent(blackboard, round0Public)
    recordBlackboardEvent(blackboard, round0Self)
    recordBlackboardEvent(blackboard, round1Public)

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("observe")!
    const result = await tool.execute({})

    expect(result).toContain("公开言论")
    expect(result).not.toContain("自己说的话")
    expect(result).not.toContain("下一轮的话")
  })

  it("returns empty when no public events in current round", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("observe")!
    const result = await tool.execute({})

    expect(result).toContain("暂无可见事件")
  })
})

describe("inquire tool", () => {
  it("writes an event to the blackboard targeted at another agent", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("inquire")!

    const beforeCount = blackboard.events.length
    const result = await tool.execute({ target: "乙", question: "你今天好吗？" })

    expect(result).toContain("乙")
    expect(result).toContain("你今天好吗？")
    expect(blackboard.events.length).toBe(beforeCount + 1)

    const lastEvent = blackboard.events[blackboard.events.length - 1]
    expect(lastEvent.actorId).toBe("a")
    expect(lastEvent.actorName).toBe("甲")
    expect(lastEvent.targetName).toBe("乙")
    expect(lastEvent.content).toBe("你今天好吗？")
    expect(lastEvent.observableBy).toContain("a")
    expect(lastEvent.observableBy).toContain("b")
  })

  it("returns error when target or question is missing", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("inquire")!

    const result1 = await tool.execute({ target: "乙" })
    expect(result1).toContain("错误")

    const result2 = await tool.execute({ question: "你好" })
    expect(result2).toContain("错误")
  })
})

describe("introspect tool", () => {
  it("returns the agent's internal state", async () => {
    const agent = makeAgent("a", "甲")
    agent.currentGoal = "寻找真相"
    agent.emotionalState = "curious"
    agent.personality = ["机智", "冷静"]
    agent.speakingStyle = "简洁明了"
    agent.knowledgeScope = ["知道一些秘密"]
    agent.memory.recentDecisions = ["决定调查"]

    const blackboard = createSimulationBlackboard({ agents: [agent] })
    const registry = createSimAgentTools(agent, blackboard)
    const tool = registry.get("introspect")!
    const result = await tool.execute({})

    expect(result).toContain("内心审视")
    expect(result).toContain("寻找真相")
    expect(result).toContain("curious")
    expect(result).toContain("机智")
    expect(result).toContain("简洁明了")
    expect(result).toContain("知道一些秘密")
    expect(result).toContain("决定调查")
  })

  it("includes sentiments toward other agents", async () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    agentA.memory.sentiments.set("b", 20)

    const blackboard = createSimulationBlackboard({ agents: [agentA, agentB] })
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("introspect")!
    const result = await tool.execute({})

    expect(result).toContain("对他人的情感")
    expect(result).toContain("20")
  })
})

function makeRumor(id: string, content: string, observer: string): RumorEvent {
  return {
    id,
    round: 0,
    nodeIndex: 0,
    sourceId: null,
    content,
    distortion: 0.1,
    observableBy: [observer],
    believedBy: [],
    verifiedBy: [],
    timestamp: "2026-07-04T00:00:00.000Z",
    generation: 0,
  }
}

describe("introspect tool 边界", () => {
  it("跳过对自己的情感并在黑板无名时回退到 ID 显示", async () => {
    const agentA = makeAgent("a", "甲")
    agentA.memory.sentiments.set("a", 100)
    agentA.memory.sentiments.set("ghost", -5)

    const blackboard = createSimulationBlackboard({ agents: [agentA] })
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("introspect")!
    const result = await tool.execute({})

    expect(result).not.toContain("(a)")
    expect(result).toContain("- 角色[ghost]：好感度 -5")
  })

  it("空画像时省略可选章节且最近决策只取后 5 条", async () => {
    const agentA = makeAgent("a", "甲")
    agentA.personality = []
    agentA.speakingStyle = ""
    agentA.knowledgeScope = []
    agentA.memory.recentDecisions = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]

    const blackboard = createSimulationBlackboard({ agents: [agentA] })
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("introspect")!
    const result = await tool.execute({})

    expect(result).toContain("内心审视")
    expect(result).not.toContain("性格关键词")
    expect(result).not.toContain("说话风格")
    expect(result).not.toContain("知道的信息")
    expect(result).toContain("d3")
    expect(result).not.toContain("d2")
  })

  it("用角色名索引情感时显示对方名字", async () => {
    const { agentA, agentB, blackboard } = setupTwoAgents()
    void agentB
    agentA.memory.sentiments.set("b", 42)
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("introspect")!
    const result = await tool.execute({})

    expect(result).toContain("- 角色[乙]（b）：好感度 42")
  })
})

describe("inquire tool 边界", () => {
  it("目标不在黑板时用原名记录事件", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("inquire")!

    const result = await tool.execute({ target: "陌生人", question: "你是谁？" })
    expect(result).toContain("陌生人")
    expect(result).toContain("你是谁？")

    const lastEvent = blackboard.events[blackboard.events.length - 1]
    expect(lastEvent.targetId).toBe("陌生人")
    expect(lastEvent.targetName).toBe("陌生人")
    expect(lastEvent.observableBy).toEqual(["a", "陌生人"])
    expect(lastEvent.actionType).toBe("speak")
  })

  it("按角色 ID 也能定位目标", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("inquire")!

    const result = await tool.execute({ target: "b", question: "在吗？" })
    expect(result).toContain("乙")

    const lastEvent = blackboard.events[blackboard.events.length - 1]
    expect(lastEvent.targetId).toBe("b")
    expect(lastEvent.targetName).toBe("乙")
  })
})

describe("investigate tool", () => {
  it("缺少 rumorDescription 参数时返回错误", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("investigate")!

    const result = await tool.execute({})
    expect(result).toContain("错误")
  })

  it("没有匹配的传闻时提示确认描述", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("investigate")!

    const result = await tool.execute({ rumorDescription: "子虚乌有的事" })
    expect(result).toContain("未找到匹配的传闻")
  })

  it("命中传闻时返回调查结论并标记已验证", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    recordRumorEvent(blackboard, makeRumor("r1", "宝藏藏在后山", "a"))

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("investigate")!
    const result = await tool.execute({ rumorDescription: "后山" })

    expect(result).toContain("经过调查")
    expect(result).toContain("宝藏藏在后山")
    const rumor = blackboard.rumors.find((r) => r.id === "r1")!
    expect(rumor.verifiedBy).toContain("a")
  })
})

describe("spread_rumor tool", () => {
  it("缺少 rumorId 或 targetAgentId 时返回错误", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("spread_rumor")!

    expect(await tool.execute({ targetAgentId: "b", message: "hi" })).toContain("错误")
    expect(await tool.execute({ rumorId: "r1", message: "hi" })).toContain("错误")
  })

  it("传闻不存在或目标不存在时传播失败", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("spread_rumor")!

    const result = await tool.execute({
      rumorId: "nope",
      targetAgentId: "b",
      message: "听说了吗",
    })
    expect(result).toContain("传播失败")
  })

  it("随机数极小时目标相信传闻（确定性）", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    recordRumorEvent(blackboard, makeRumor("r1", "宝藏藏在后山", "a"))

    const rand = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      const registry = createSimAgentTools(agentA, blackboard)
      const tool = registry.get("spread_rumor")!
      const result = await tool.execute({
        rumorId: "r1",
        targetAgentId: "b",
        message: "宝藏藏在后山，千真万确",
      })

      expect(result).toContain("传播成功！新传闻 ID：")
      expect(result).toContain("目标角色相信了这条传闻")
      expect(result).toContain("新失真度：0.2")
      const created = blackboard.rumors.find((r) => r.id !== "r1")!
      expect(created.content).toBe("宝藏藏在后山，千真万确")
      expect(created.observableBy).toEqual(["b"])
      expect(created.parentId).toBe("r1")
    } finally {
      rand.mockRestore()
    }
  })

  it("随机数极大时目标持怀疑态度（确定性）", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    recordRumorEvent(blackboard, makeRumor("r1", "宝藏藏在后山", "a"))

    const rand = vi.spyOn(Math, "random").mockReturnValue(0.999)
    try {
      const registry = createSimAgentTools(agentA, blackboard)
      const tool = registry.get("spread_rumor")!
      const result = await tool.execute({
        rumorId: "r1",
        targetAgentId: "b",
        message: "宝藏藏在后山，千真万确",
      })

      expect(result).toContain("传播成功！新传闻 ID：")
      expect(result).toContain("持怀疑态度")
      expect(result).toContain("新失真度：0.4")
    } finally {
      rand.mockRestore()
    }
  })

  it("省略 message 时沿用源传闻内容", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    recordRumorEvent(blackboard, makeRumor("r1", "宝藏藏在后山", "a"))

    const rand = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      const registry = createSimAgentTools(agentA, blackboard)
      const tool = registry.get("spread_rumor")!
      const result = await tool.execute({ rumorId: "r1", targetAgentId: "b" })
      expect(result).toContain("传播成功")
      const created = blackboard.rumors.find((r) => r.id !== "r1")!
      expect(created.content).toBe("宝藏藏在后山")
    } finally {
      rand.mockRestore()
    }
  })
})

describe("roundPlans 轮次", () => {
  it("observe 使用最后一个计划的轮次过滤", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    blackboard.roundPlans.push({ round: 1, nodeIndex: 0, strategy: "all-agents", turns: [] })

    recordBlackboardEvent(
      blackboard,
      makeTimelineEvent("e0", 0, "b", "乙", ["a", "b"], "旧公开言论"),
    )
    recordBlackboardEvent(
      blackboard,
      makeTimelineEvent("e1", 1, "b", "乙", ["a", "b"], "本轮公开言论"),
    )
    recordBlackboardEvent(
      blackboard,
      makeTimelineEvent("e2", 1, "a", "甲", ["a", "b"], "自己本轮的话"),
    )

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("observe")!
    const result = await tool.execute({})

    expect(result).toContain("本轮公开言论")
    expect(result).not.toContain("旧公开言论")
    expect(result).not.toContain("自己本轮的话")
  })

  it("inquire 事件轮次跟随最后一个计划", async () => {
    const { agentA, blackboard } = setupTwoAgents()
    blackboard.roundPlans.push({ round: 5, nodeIndex: 0, strategy: "all-agents", turns: [] })

    const registry = createSimAgentTools(agentA, blackboard)
    const tool = registry.get("inquire")!
    await tool.execute({ target: "乙", question: "第5轮好吗？" })

    const lastEvent = blackboard.events[blackboard.events.length - 1]
    expect(lastEvent.round).toBe(5)
  })
})
