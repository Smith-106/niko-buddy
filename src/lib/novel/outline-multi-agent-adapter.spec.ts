import { describe, expect, it, vi } from "vitest"
import { runOutlineMultiAgentGeneration } from "./outline-multi-agent-adapter"
import type { ContextPack } from "./context-engine"
import type { OutlineSubAgentPlan } from "./outline-multi-agent-orchestrator"

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: vi.fn(),
  }
})

import { streamChat } from "@/lib/llm-client"

const mockStreamChat = vi.mocked(streamChat)

function makePack(): ContextPack {
  return {
    task: "生成第一卷大纲",
    chapterGoal: "",
    outline: "主线：少年觉醒",
    recentChapterContents: [],
    recentSummaries: ["第一章：觉醒"],
    previousChapterEnding: "",
    characterStates: "主角：初醒",
    soulDoc: "作品灵魂：热血成长",
    characterAuras: "",
    cognitionStates: "",
    foreshadowingStates: "伏笔：身世",
    timeline: "",
    relatedSettings: "设定：学院",
    canonRules: "硬规则：魔法守恒",
    writingStyle: "",
    searchResults: "",
    graphSearchResults: "",
    mustDo: "",
    mustAvoid: "",
    nextChapterAdvice: "",
    revisionDirectives: "",
  }
}

function makePlan(): OutlineSubAgentPlan[] {
  return [
    {
      id: "a1",
      name: "主线子智能体",
      kind: "outline",
      skillNames: ["主线大纲"],
      taskPrompt: "生成主线大纲",
      writeToolsEnabled: false,
    },
    {
      id: "a2",
      name: "角色子智能体",
      kind: "character",
      skillNames: ["角色大纲"],
      taskPrompt: "生成角色大纲",
      dependencies: ["a1"],
      writeToolsEnabled: false,
    },
  ]
}

describe("outline-multi-agent-adapter", () => {
  it("多智能体模式：子智能体输出经合并后返回", async () => {
    mockStreamChat.mockImplementation(async (_config, messages, callbacks) => {
      const prompt = String(messages[0].content)
      if (prompt.includes("你是大纲子智能体")) {
        const id = prompt.includes("主线子智能体") ? "a1" : "a2"
        callbacks.onToken?.(id === "a1" ? "## 主线大纲\n第一卷：觉醒" : "## 角色大纲\n主角：林澈")
      } else if (prompt.includes("合并")) {
        callbacks.onToken?.("## 合并大纲\n第一卷：觉醒\n主角：林澈")
      }
    })

    const result = await runOutlineMultiAgentGeneration({
      llmConfig: { provider: "mock" } as never,
      userRequest: "生成第一卷大纲",
      contextPack: makePack(),
      plan: makePlan(),
      maxConcurrency: 2,
      onStatusChange: () => {},
    })

    expect(result.mode).toBe("multi-agent")
    expect(result.finalText).toContain("合并大纲")
    expect(result.successfulAgents).toEqual(["a1", "a2"])
    expect(result.failedAgents).toEqual([])
    // 子智能体上下文裁剪：角色子智能体应注入角色状态
    const characterPrompt = mockStreamChat.mock.calls.find(
      (c) => String(c[1][0].content).includes("角色子智能体"),
    )?.[1][0].content
    expect(characterPrompt).toContain("主角：初醒")
  })

  it("全部子智能体失败时降级为单智能体（deep-outline 流水线）", async () => {
    mockStreamChat.mockImplementation(async (_config, messages, callbacks) => {
      const prompt = String(messages[0].content)
      if (prompt.includes("你是大纲子智能体")) {
        // 子智能体全部失败：不输出
      } else {
        // 降级路径（deep-outline 流水线各阶段）统一输出
        callbacks.onToken?.("## 单智能体大纲\n降级生成")
        callbacks.onDone?.()
      }
    })

    const result = await runOutlineMultiAgentGeneration({
      llmConfig: { provider: "mock" } as never,
      userRequest: "生成第一卷大纲",
      contextPack: makePack(),
      plan: makePlan(),
      maxConcurrency: 2,
      onStatusChange: () => {},
    })

    expect(result.mode).toBe("single-agent-fallback")
    expect(result.finalText).toContain("降级生成")
  })

  it("编排层：非法计划（环依赖）被拒绝", async () => {
    const { validateOutlineSubAgentPlan } = await import("./outline-multi-agent-orchestrator")
    const cyclic = [
      { id: "x", name: "x", kind: "outline", skillNames: [], taskPrompt: "t", dependencies: ["y"], writeToolsEnabled: false },
      { id: "y", name: "y", kind: "outline", skillNames: [], taskPrompt: "t", dependencies: ["x"], writeToolsEnabled: false },
    ]
    const check = validateOutlineSubAgentPlan(cyclic as OutlineSubAgentPlan[])
    expect(check.ok).toBe(false)
    expect(check.errors.length).toBeGreaterThan(0)
  })

  it("编排层：简单任务强制单 Agent", async () => {
    const { isSimpleOutlineTask } = await import("./outline-multi-agent-orchestrator")
    expect(isSimpleOutlineTask("把第三章标题改名《夜袭》")).toBe(true)
    expect(isSimpleOutlineTask("生成包含主线、角色、伏笔的完整第一卷大纲")).toBe(false)
  })
})
