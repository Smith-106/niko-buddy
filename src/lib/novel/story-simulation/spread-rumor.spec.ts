import { describe, expect, it, vi } from "vitest"

import type { NovelAgent, RumorEvent } from "@/lib/novel/story-simulation/types"
import {
  createSimulationBlackboard,
  recordRumorEvent,
  spreadRumor,
} from "@/lib/novel/story-simulation/multi-agent-orchestrator"

function makeAgent(id: string, name: string): NovelAgent {
  return {
    characterId: id,
    name,
    profile: `${name} profile`,
    aura: null,
    cognition: null,
    soul: "",
    currentGoal: "完成当前节点目标",
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

function makeRumorEvent(id: string, observableBy: string[], distortion = 0.3): RumorEvent {
  return {
    id,
    round: 0,
    nodeIndex: 0,
    sourceId: null,
    content: `传闻内容：${id}`,
    distortion,
    observableBy,
    believedBy: [],
    verifiedBy: [],
    timestamp: "2026-07-04T00:00:00.000Z",
    generation: 0,
  }
}

describe("spreadRumor", () => {
  it("基本传播：生成新传闻，加入目标可见列表", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "我跟你说个秘密")

    expect(result.newRumor).not.toBeNull()
    expect(result.newRumor!.content).toBe("我跟你说个秘密")
    expect(blackboard.rumors).toHaveLength(2)
    expect(blackboard.visibleRumorsByAgent.get("b")!.map((r) => r.id)).toContain(
      result.newRumor!.id,
    )
  })

  it("失真度增加：新传闻 distortion >= 源传闻 distortion", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.2)
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")

    expect(result.newRumor!.distortion).toBeGreaterThanOrEqual(sourceRumor.distortion + 0.1)
    expect(result.newRumor!.distortion).toBeLessThanOrEqual(1)
  })

  it("generation 递增：子代 generation = 父代 + 1", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙"), makeAgent("c", "丙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    recordRumorEvent(blackboard, sourceRumor)

    const result1 = spreadRumor(blackboard, "rumor-1", "a", "b", "一传")
    expect(result1.newRumor!.generation).toBe(1)

    const result2 = spreadRumor(blackboard, result1.newRumor!.id, "b", "c", "二传")
    expect(result2.newRumor!.generation).toBe(2)
  })

  it("parentId 和 spreadBy 正确设置", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "传一下")

    expect(result.newRumor!.parentId).toBe("rumor-1")
    expect(result.newRumor!.spreadBy).toBe("a")
    expect(result.newRumor!.spreadRound).toBe(1)
    expect(result.newRumor!.round).toBe(1)
  })

  it("传播不存在的传闻：返回 null", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })

    const result = spreadRumor(blackboard, "nonexistent", "a", "b", "传一下")

    expect(result.newRumor).toBeNull()
    expect(result.targetBelieved).toBe(false)
  })

  it("传播给不存在的目标：返回 null", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "nonexistent", "传一下")

    expect(result.newRumor).toBeNull()
    expect(result.targetBelieved).toBe(false)
  })

  it("传播者看不到传闻时：返回 null", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["b"])
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "传一下")

    expect(result.newRumor).toBeNull()
    expect(result.targetBelieved).toBe(false)
  })

  it("message 为空时使用源传闻 content", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")

    expect(result.newRumor!.content).toBe(sourceRumor.content)
  })

  it("可信度影响：高可信度传播者更容易被相信", () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    agentA.memory.rumorCredibility = 1.0
    agentB.memory.sentiments.set("a", 0)

    const blackboard = createSimulationBlackboard({ agents: [agentA, agentB] })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.0)
    recordRumorEvent(blackboard, sourceRumor)

    let callCount = 0
    const mockRandom = vi.fn(() => {
      callCount++
      if (callCount === 1) return 0
      return 0.99
    })
    const originalRandom = Math.random
    Math.random = mockRandom

    try {
      const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")
      const baseBelief = (1 - result.newRumor!.distortion) * 0.6
      const credibilityBonus = (1.0 - 0.5) * 0.4
      const finalProb = Math.max(0.1, Math.min(0.9, baseBelief + credibilityBonus))
      expect(finalProb).toBeGreaterThan(0.6)
    } finally {
      Math.random = originalRandom
    }
  })

  it("低可信度传播者更难被相信", () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    agentA.memory.rumorCredibility = 0.0
    agentB.memory.sentiments.set("a", 0)

    const blackboard = createSimulationBlackboard({ agents: [agentA, agentB] })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.5)
    recordRumorEvent(blackboard, sourceRumor)

    const mockRandom = vi.fn(() => 0.01)
    const originalRandom = Math.random
    Math.random = mockRandom

    try {
      const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")
      const baseBelief = (1 - result.newRumor!.distortion) * 0.6
      const credibilityBonus = (0.0 - 0.5) * 0.4
      const finalProb = Math.max(0.1, Math.min(0.9, baseBelief + credibilityBonus))
      expect(finalProb).toBeLessThan(0.5)
    } finally {
      Math.random = originalRandom
    }
  })

  it("情感影响：目标对传播者好感度高更容易相信", () => {
    const agentA = makeAgent("a", "甲")
    const agentB = makeAgent("b", "乙")
    agentB.memory.sentiments.set("a", 100)

    const blackboard = createSimulationBlackboard({ agents: [agentA, agentB] })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.5)
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")
    expect(result.newRumor).not.toBeNull()
  })

  it("sourceId 正确继承", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"])
    sourceRumor.sourceId = "event-123"
    recordRumorEvent(blackboard, sourceRumor)

    const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")

    expect(result.newRumor!.sourceId).toBe("event-123")
  })

  it("相信传闻后目标加入 believedBy", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.0)
    recordRumorEvent(blackboard, sourceRumor)

    const mockRandom = vi.fn(() => 0.0)
    const originalRandom = Math.random
    Math.random = mockRandom

    try {
      const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")
      expect(result.targetBelieved).toBe(true)
      expect(result.newRumor!.believedBy).toContain("b")
    } finally {
      Math.random = originalRandom
    }
  })

  it("不相信传闻时目标不加入 believedBy", () => {
    const agents = [makeAgent("a", "甲"), makeAgent("b", "乙")]
    const blackboard = createSimulationBlackboard({ agents })
    const sourceRumor = makeRumorEvent("rumor-1", ["a"], 0.99)
    recordRumorEvent(blackboard, sourceRumor)

    const mockRandom = vi.fn(() => 0.99)
    const originalRandom = Math.random
    Math.random = mockRandom

    try {
      const result = spreadRumor(blackboard, "rumor-1", "a", "b", "")
      expect(result.targetBelieved).toBe(false)
      expect(result.newRumor!.believedBy).not.toContain("b")
    } finally {
      Math.random = originalRandom
    }
  })
})
