// @vitest-environment jsdom
/**
 * 面板契约：命中技能/缺口必须真的渲染；未装载技能库时不许把行画成「无缺口」。
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { projectAgentCapabilityMatrix } from "@/lib/novel"

import { AgentCapabilityMatrixPanel } from "./agent-capability-matrix-panel"

const INPUT = {
  skills: [
    { name: "人物设计", kinds: ["character"] },
    { name: "伏笔管理", kinds: ["foreshadowing"] },
    { name: "节奏控制", stages: ["draft"] },
    { name: "无人问津", kinds: ["sound"] },
  ],
  roles: [
    { id: "character-agent", label: "人物 Agent", kinds: ["character"] },
    { id: "outline-agent", label: "大纲 Agent", kinds: ["foreshadowing", "topic"] },
  ],
}

afterEach(cleanup)

describe("AgentCapabilityMatrixPanel", () => {
  it("渲染每个角色的可用技能与缺口", () => {
    render(<AgentCapabilityMatrixPanel input={INPUT} />)
    const character = screen.getByTestId("agent-capability-row-character-agent")
    expect(character.textContent).toContain("人物设计")
    const outline = screen.getByTestId("agent-capability-row-outline-agent")
    expect(outline.textContent).toContain("伏笔管理")
    expect(screen.getByTestId("agent-capability-missing-outline-agent").textContent).toContain("topic")
  })

  it("全局缺口与冗余候选分开展示", () => {
    render(<AgentCapabilityMatrixPanel input={INPUT} />)
    expect(screen.getByTestId("agent-capability-global-missing").textContent).toContain("topic")
    expect(screen.getByTestId("agent-capability-unused").textContent).toContain("无人问津")
  })

  it("未装载技能库 → 不显示「无缺口」结论，N/A 写清原因", () => {
    render(<AgentCapabilityMatrixPanel input={{ ...INPUT, skillsLoaded: false }} />)
    expect(screen.queryByTestId("agent-capability-global-missing")).toBeNull()
    expect(screen.queryByTestId("agent-capability-unused")).toBeNull()
    expect(screen.getByTestId("agent-capability-na").textContent).toContain("技能库未装载")
  })

  it("没有角色定义时明确说「不是不需要技能」", () => {
    render(<AgentCapabilityMatrixPanel input={{ skills: INPUT.skills, roles: [] }} />)
    expect(screen.getByTestId("agent-capability-empty").textContent).toContain("不需要技能")
  })

  it("注入 projection 优先（不再重算）", () => {
    const projection = projectAgentCapabilityMatrix({ skills: [], roles: [], skillsLoaded: false })
    render(<AgentCapabilityMatrixPanel projection={projection} input={INPUT} />)
    expect(screen.getByTestId("agent-capability-empty")).toBeTruthy()
  })

  it("scope 文案不越界承诺（不生成技能、不决定模型路由）", () => {
    render(<AgentCapabilityMatrixPanel input={INPUT} />)
    const scope = screen.getByTestId("agent-capability-scope").textContent ?? ""
    expect(scope).toContain("不生成技能")
    expect(scope).toContain("不决定模型路由")
  })
})
