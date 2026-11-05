/**
 * simulation-serializer 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：Set/Map 序列化往返/关系表/rumorCredibility 缺省/空快照/
 * 状态字段还原（directorEnabled 关闭、注入表置空）。
 * 纯函数，无文件与 LLM 操作。
 */
import { describe, expect, it } from "vitest"
import type { NovelAgent, SimulationState } from "./types"
import {
  serializeSimulationState,
  deserializeSimulationSnapshot,
  type SerializedSimulationSnapshot,
} from "./simulation-serializer"

function agent(overrides: Partial<NovelAgent> = {}): NovelAgent {
  return {
    characterId: "c-aming",
    name: "阿明",
    profile: "勇者档案",
    aura: null,
    cognition: { knows: ["秘密"], doesNotKnow: ["真相"] },
    soul: "soul-doc",
    currentGoal: "守护村庄",
    emotionalState: "firm",
    knownFacts: new Set(["f1", "f2"]),
    relationships: new Map([
      ["c-hong", { targetId: "c-hong", relationType: "ally", sentiment: 30 }],
    ]),
    powerLevel: "high",
    memory: {
      observedEvents: ["e1"],
      knownSecrets: new Set(["s1"]),
      sentiments: new Map([["c-hong", 30]]),
      recentDecisions: ["d1"],
      rumorCredibility: 0.7,
    },
    knowledgeScope: ["scope-a"],
    personality: ["勇敢"],
    speakingStyle: "直率",
    ...overrides,
  }
}

function state(agents: NovelAgent[]): SimulationState {
  return {
    currentRound: 4,
    timelineEvents: [
      {
        id: "e1",
        round: 3,
        nodeIndex: 0,
        actorId: "c-aming",
        actorName: "阿明",
        actionType: "speak",
        content: "冲！",
        observableBy: ["c-aming"],
        impacts: [],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
    activeAgents: new Map(agents.map((a) => [a.characterId, a])),
    worldState: { weather: "rain" },
    directorEnabled: true,
    nextNodeInjectionMap: new Map([[2, "inject"]]),
  }
}

describe("serializeSimulationState", () => {
  it("把 Set/Map 转为可 JSON 序列化的结构", () => {
    const snap = serializeSimulationState(state([agent()]), [agent()])
    // 序列化结果必须能走 JSON 往返
    const revived = JSON.parse(JSON.stringify(snap)) as SerializedSimulationSnapshot
    expect(revived.agents).toHaveLength(1)
    expect(revived.agents[0]).toMatchObject({
      characterId: "c-aming",
      name: "阿明",
      soul: "soul-doc",
      currentGoal: "守护村庄",
    })
    expect(revived.agents[0]!.knownFacts).toEqual(["f1", "f2"])
    expect(revived.agents[0]!.relationships).toEqual([
      { targetId: "c-hong", relationType: "ally", sentiment: 30 },
    ])
    expect(revived.agents[0]!.memory).toEqual({
      observedEvents: ["e1"],
      knownSecrets: ["s1"],
      sentiments: { "c-hong": 30 },
      recentDecisions: ["d1"],
      rumorCredibility: 0.7,
    })
    expect(revived.state.currentRound).toBe(4)
    expect(Object.keys(revived.state.activeAgents)).toEqual(["c-aming"])
    expect(revived.state.worldState).toEqual({ weather: "rain" })
  })

  it("空 agent 列表序列化为空数组与空表", () => {
    const snap = serializeSimulationState(state([]), [])
    expect(snap.agents).toEqual([])
    expect(snap.state.activeAgents).toEqual({})
  })
})

describe("deserializeSimulationSnapshot", () => {
  it("完整往返恢复 Set/Map 与 agent 字段", () => {
    const snap = serializeSimulationState(state([agent()]), [agent()])
    const { agents, state: restored } = deserializeSimulationSnapshot(
      JSON.parse(JSON.stringify(snap)),
    )

    expect(agents).toHaveLength(1)
    const a = agents[0]!
    expect(a.knownFacts).toBeInstanceOf(Set)
    expect([...a.knownFacts]).toEqual(["f1", "f2"])
    expect(a.relationships).toBeInstanceOf(Map)
    expect(a.relationships.get("c-hong")).toEqual({
      targetId: "c-hong",
      relationType: "ally",
      sentiment: 30,
    })
    expect(a.memory.knownSecrets).toBeInstanceOf(Set)
    expect(a.memory.sentiments).toBeInstanceOf(Map)
    expect(a.memory.sentiments.get("c-hong")).toBe(30)
    expect(a.memory.observedEvents).toEqual(["e1"])

    expect(restored.currentRound).toBe(4)
    expect(restored.timelineEvents).toHaveLength(1)
    expect(restored.activeAgents).toBeInstanceOf(Map)
    expect(restored.activeAgents.get("c-aming")?.name).toBe("阿明")
    expect(restored.worldState).toEqual({ weather: "rain" })
    // 反序列化固定关闭导演并清空注入表
    expect(restored.directorEnabled).toBe(false)
    expect(restored.nextNodeInjectionMap).toBeInstanceOf(Map)
    expect(restored.nextNodeInjectionMap.size).toBe(0)
  })

  it("缺失 rumorCredibility 时回退 0.5", () => {
    const snap = serializeSimulationState(state([agent()]), [agent()])
    const tampered = JSON.parse(JSON.stringify(snap)) as SerializedSimulationSnapshot
    delete (tampered.agents[0]!.memory as unknown as Record<string, unknown>)
      .rumorCredibility
    const { agents } = deserializeSimulationSnapshot(tampered)
    expect(agents[0]!.memory.rumorCredibility).toBe(0.5)
  })

  it("多 agent 关系各自独立还原", () => {
    const b = agent({
      characterId: "c-hong",
      name: "阿红",
      knownFacts: new Set(),
      relationships: new Map(),
      memory: {
        observedEvents: [],
        knownSecrets: new Set(),
        sentiments: new Map([["c-aming", -10]]),
        recentDecisions: [],
        rumorCredibility: 0.2,
      },
    })
    const snap = serializeSimulationState(state([agent(), b]), [agent(), b])
    const { agents } = deserializeSimulationSnapshot(
      JSON.parse(JSON.stringify(snap)),
    )
    expect(agents.map((a) => a.characterId).sort()).toEqual([
      "c-aming",
      "c-hong",
    ])
    expect(agents[1]!.memory.sentiments.get("c-aming")).toBe(-10)
    expect(agents[1]!.memory.rumorCredibility).toBe(0.2)
  })
})
