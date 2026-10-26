// ── 模拟事件管线（M4-2 切片自 simulation-engine.ts） ──
//
// 纯逻辑事件管线：目标解析 → 可见性判定 → 影响计算 → 记忆应用 →
// 时间线事件创建/转换 → 行为描述 → 认知边界过滤，外加其体内依赖的
// ParsedAction 类型与 cloneAgent / nextEventId 单一源（simulation-engine 回导使用）。
// 本模块仅依赖 story-simulation/types（type-only），无新增运行时依赖，
// 不含 LLM 调用；过渡公开导出仅供 simulation-engine 内部复用。

import type {
  ActionVisibility,
  AgentAction,
  EventImpact,
  NovelAgent,
  SimulationEvent,
  SimulationState,
  StoryNode,
  TimelineEvent,
} from "@/lib/novel/story-simulation/types"

export interface ParsedAction {
  action: AgentAction
  motivation: string
  plotPush: string
  visibility: ActionVisibility
}

// ── 内部辅助：Agent 深拷贝（避免事件间共享可变状态） ──

export function cloneAgent(agent: NovelAgent): NovelAgent {
  return {
    ...agent,
    knownFacts: new Set(agent.knownFacts),
    relationships: new Map(
      Array.from(agent.relationships.entries()).map(([k, v]) => [
        k,
        { ...v },
      ]),
    ),
    memory: {
      observedEvents: [...agent.memory.observedEvents],
      knownSecrets: new Set(agent.memory.knownSecrets),
      sentiments: new Map(agent.memory.sentiments),
      recentDecisions: [...agent.memory.recentDecisions],
      rumorCredibility: agent.memory.rumorCredibility,
    },
    knowledgeScope: [...agent.knowledgeScope],
    personality: [...agent.personality],
  }
}

// ── 内部辅助：生成唯一 ID ──

let eventCounter = 0
export function nextEventId(): string {
  eventCounter++
  return `evt_${Date.now()}_${eventCounter}`
}

// ── 内部辅助：根据名字或 ID 查找目标 Agent ──

export function resolveTarget(
  targetName: string | undefined,
  agents: Map<string, NovelAgent>,
): NovelAgent | undefined {
  if (!targetName) return undefined
  for (const agent of agents.values()) {
    if (agent.name === targetName || agent.characterId === targetName) {
      return agent
    }
  }
  return undefined
}

// ── 内部辅助：根据可见性确定 observableBy 列表 ──

export function determineObservableBy(
  actor: NovelAgent,
  target: NovelAgent | undefined,
  visibility: ActionVisibility,
  allAgents: Map<string, NovelAgent>,
): string[] {
  switch (visibility) {
    case "self":
      return [actor.characterId]
    case "target_only":
      if (target) {
        return [actor.characterId, target.characterId]
      }
      return [actor.characterId]
    case "all":
    default: {
      const ids: string[] = []
      for (const id of allAgents.keys()) {
        ids.push(id)
      }
      return ids
    }
  }
}

// ── 内部辅助：计算事件对角色的影响 ──

export function computeImpacts(
  actor: NovelAgent,
  parsed: ParsedAction,
  target: NovelAgent | undefined,
): EventImpact[] {
  const impacts: EventImpact[] = []
  const { action } = parsed

  // 对目标的情感影响
  if (target) {
    switch (action.type) {
      case "ally":
        impacts.push({
          characterId: target.characterId,
          type: "relationship",
          detail: `${actor.name}向${target.name}示好结盟，好感度上升`,
        })
        break
      case "confront":
        impacts.push({
          characterId: target.characterId,
          type: "relationship",
          detail: `${actor.name}与${target.name}对抗，好感度下降`,
        })
        break
      case "speak":
        impacts.push({
          characterId: target.characterId,
          type: "knowledge",
          detail: `${target.name}听到了${actor.name}说的话`,
        })
        break
      case "react":
        impacts.push({
          characterId: target.characterId,
          type: "sentiment",
          detail: `${actor.name}对${target.name}的行为做出了反应`,
        })
        break
    }
  }

  // 对自己的影响
  switch (action.type) {
    case "investigate":
    case "observe":
      impacts.push({
        characterId: actor.characterId,
        type: "knowledge",
        detail: `${actor.name}获取了新信息`,
      })
      break
    case "conceal":
      impacts.push({
        characterId: actor.characterId,
        type: "knowledge",
        detail: `${actor.name}隐藏了某些信息`,
      })
      break
    case "evaluate":
      impacts.push({
        characterId: actor.characterId,
        type: "sentiment",
        detail: `${actor.name}形成了看法/评价`,
      })
      break
  }

  // 公开事件对所有人产生知识影响
  if (action.visibility === "all") {
    impacts.push({
      characterId: "__all__",
      type: "knowledge",
      detail: `所有人都观察到了${actor.name}的公开行为`,
    })
  }

  return impacts
}

// ── 内部辅助：将事件应用到 Agent 记忆 ──

export function applyEventToMemory(
  agent: NovelAgent,
  event: TimelineEvent,
): void {
  agent.memory.observedEvents.push(event.id)

  // 处理影响
  for (const impact of event.impacts) {
    if (impact.characterId === "__all__" || impact.characterId === agent.characterId) {
      if (impact.type === "knowledge") {
        // 知识类影响：加入到 knowledgeScope
        if (!agent.knowledgeScope.includes(impact.detail)) {
          agent.knowledgeScope.push(impact.detail)
        }
      } else if (impact.type === "sentiment") {
        // 情感变化
        agent.emotionalState = impact.detail.includes("正面") ? "positive" : agent.emotionalState
      } else if (impact.type === "relationship" && event.targetId) {
        // 关系变化
        const current = agent.memory.sentiments.get(event.targetId) ?? 0
        let delta = 0
        if (impact.detail.includes("上升") || impact.detail.includes("结盟") || impact.detail.includes("示好")) {
          delta = 10
        } else if (impact.detail.includes("下降") || impact.detail.includes("对抗") || impact.detail.includes("冲突")) {
          delta = -10
        }
        agent.memory.sentiments.set(
          event.targetId,
          Math.max(-100, Math.min(100, current + delta)),
        )
        // 同步到旧 relationships 字段以兼容
        const oldRel = agent.relationships.get(event.targetId)
        if (oldRel) {
          oldRel.sentiment = Math.max(-100, Math.min(100, current + delta))
          oldRel.relationType = delta > 0 ? "ally" : delta < 0 ? "hostile" : oldRel.relationType
        }
      }
    }
  }

  // 记录最近决策（仅对行为发起者）
  if (event.actorId === agent.characterId) {
    agent.memory.recentDecisions.push(
      `[R${event.round + 1}] ${event.actionType}: ${event.content.slice(0, 50)}`,
    )
    if (agent.memory.recentDecisions.length > 20) {
      agent.memory.recentDecisions = agent.memory.recentDecisions.slice(-20)
    }
  }
}

// ── 内部辅助：创建时间线事件 ──

export function createTimelineEvent(
  actor: NovelAgent,
  parsed: ParsedAction,
  target: NovelAgent | undefined,
  round: number,
  nodeIndex: number,
  allAgents: Map<string, NovelAgent>,
): TimelineEvent {
  const observableBy = determineObservableBy(
    actor,
    target,
    parsed.visibility,
    allAgents,
  )
  const impacts = computeImpacts(actor, parsed, target)

  return {
    id: nextEventId(),
    round,
    nodeIndex,
    actorId: actor.characterId,
    actorName: actor.name,
    actionType: parsed.action.type,
    content: parsed.action.content,
    targetId: target?.characterId,
    targetName: target?.name,
    observableBy,
    impacts,
    timestamp: new Date().toISOString(),
  }
}

// ── 内部辅助：将 TimelineEvent 转换为旧 SimulationEvent（兼容报告生成） ──

export function timelineEventToSimulationEvent(
  tlEvent: TimelineEvent,
  agent: NovelAgent,
  parsed: ParsedAction,
  node: StoryNode,
  round: number,
): SimulationEvent {
  const stateChanges: string[] = []
  if (parsed.motivation) {
    stateChanges.push(`动机：${parsed.motivation}`)
  }
  if (parsed.plotPush) {
    stateChanges.push(`剧情推动：${parsed.plotPush}`)
  }
  for (const impact of tlEvent.impacts) {
    if (impact.characterId !== "__all__") {
      stateChanges.push(impact.detail)
    }
  }

  // 将新行为类型映射为旧 AgentAction 结构（扁平接口，直接赋值）
  const action: AgentAction = {
    type: parsed.action.type,
    content: parsed.action.content,
    target: parsed.action.target,
    visibility: parsed.action.visibility,
    motivation: parsed.motivation,
    plot_push: parsed.plotPush,
  }

  return {
    type: "agent-action",
    agent: cloneAgent(agent),
    action,
    round,
    node,
    stateChanges,
    timestamp: tlEvent.timestamp,
    timelineEvent: tlEvent,
  }
}

// ── 内部辅助：为旧 SimulationEvent 生成行为描述 ──

export function formatActionDescription(action: AgentAction, agentName: string): string {
  const { type, content, target } = action
  switch (type) {
    case "speak":
      return target
        ? `${agentName} 对 ${target} 说：「${content}」`
        : `${agentName} 说：「${content}」`
    case "evaluate":
      return `${agentName} 心中评价：${content}`
    case "pushPlot":
      return `${agentName} 采取行动：${content}`
    case "observe":
      return `${agentName} 观察到：${content}`
    case "react":
      return target
        ? `${agentName} 对 ${target} 的反应：${content}`
        : `${agentName} 做出反应：${content}`
    case "ally":
      return target
        ? `${agentName} 向 ${target} 示好结盟：${content}`
        : `${agentName} 寻求合作：${content}`
    case "confront":
      return target
        ? `${agentName} 与 ${target} 对抗：${content}`
        : `${agentName} 采取对抗姿态：${content}`
    case "conceal":
      return `${agentName} 隐瞒了内心想法：${content}`
    case "investigate":
      return `${agentName} 调查：${content}`
    case "act":
      return `${agentName} 行动：${content}`
    case "decide":
      return `${agentName} 做出决定：${content}`
    case "conflict":
      return target
        ? `${agentName} 与 ${target} 发生冲突：${content}`
        : `${agentName} 冲突：${content}`
    case "cooperate":
      return target
        ? `${agentName} 与 ${target} 合作：${content}`
        : `${agentName} 合作：${content}`
    case "withhold":
      return `${agentName} 隐瞒信息：${content}`
    default:
      return `${agentName}：${content}`
  }
}

// ── 内部辅助：按认知边界过滤全局 recentEventDescs ──
//
// recentEventDescs 三类来源混排：resume 预载 `[已保存] 名：原文`、随机 `[系统事件] 原文`、
// 实时决策 `formatActionDescription` 输出。过滤规则：
// - 系统事件（全体可见）：保留；
// - 能在 state.timelineEvents 按 actorName+content 回查到的：按 event.observableBy 判定；
// - 回查不到的（如 resume 预载跨轮残留）：保守丢弃（visibleEvents 黑板已覆盖可见部分）。
export function filterRecentDescsForAgent(
  descs: string[],
  state: SimulationState,
  visibleEventIds: Set<string>,
  agentId: string,
): string[] {
  return descs.filter((desc) => {
    if (desc.startsWith("[系统事件]")) return true
    const match = state.timelineEvents.find(
      (ev) =>
        (visibleEventIds.has(ev.id) || ev.observableBy.includes(agentId)) &&
        desc.includes(ev.actorName) &&
        ev.content.length > 0 &&
        desc.includes(ev.content.slice(0, 24)),
    )
    // 回查命中且可见 → 保留；命中但不可见 → 丢弃；回查不到 → 保守丢弃。
    if (match) return visibleEventIds.has(match.id) || match.observableBy.includes(agentId)
    const fallbackVisible = state.timelineEvents.some(
      (ev) =>
        (visibleEventIds.has(ev.id) || ev.observableBy.includes(agentId)) &&
        ev.content.length > 0 &&
        desc.includes(ev.content.slice(0, 24)),
    )
    return fallbackVisible
  })
}
