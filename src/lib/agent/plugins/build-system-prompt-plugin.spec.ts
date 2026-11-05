import { describe, expect, it, vi } from "vitest"
import type { AgentConfig } from "@/lib/agent/types"
import { createBuildSystemPromptPlugin } from "./build-system-prompt-plugin"
import { normalizeUserSkill, buildOutlineFindProtocol } from "@/lib/novel"

describe("BuildSystemPromptPlugin selected skills", () => {
  it("injects selected skill prompt before final model execution", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      novelSystemPrompt: "context prompt",
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      selectedSkills: [
        normalizeUserSkill({
          id: "three-four",
          name: "三翻四抖",
          kind: ["structure"],
          stages: ["drafting"],
          modes: ["standard"],
          content: "三次转折，四次震惊。",
          source: "project",
        }),
      ],
    })

    expect(result.finalSystemPrompt).toContain("base prompt")
    expect(result.finalSystemPrompt).toContain("context prompt")
    expect(result.finalSystemPrompt).toContain("本次启用 Skill")
    expect(result.finalSystemPrompt).toContain("三翻四抖")
    expect(result.finalSystemPrompt).toContain("三次转折，四次震惊。")
    expect(result.finalSystemPrompt).toContain("task directive")
    expect(result.finalSystemRulesPrompt).toContain("base prompt")
    expect(result.finalSystemRulesPrompt).toContain("本次启用 Skill")
    expect(result.finalSystemRulesPrompt).toContain("task directive")
    expect(result.finalSystemRulesPrompt).not.toContain("context prompt")
    expect(result.stableSystemRulesPrompt).toBe("base prompt")
    expect(result.dynamicSystemRulesPrompt).toContain("本次启用 Skill")
    expect(result.dynamicSystemRulesPrompt).toContain("task directive")
    expect(result.dynamicSystemRulesPrompt).not.toContain("base prompt")
  })

  it("does not inject chapter plan protocol from standard mode unless Plan Execute is enabled", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      planExecuteEnabled: false,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt).not.toContain("章节创作计划协议")
    expect(result.finalSystemPrompt).not.toContain("chapter_plan")
  })

  it("injects chapter plan protocol when Plan Execute is enabled with standard mode", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      planExecuteEnabled: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt).toContain("章节主编策划协议")
    expect(result.finalSystemPrompt).toContain("chapter_plan")
    expect(result.finalSystemPrompt).toContain("本章策划案")
    expect(result.finalSystemPrompt).not.toContain("章节蓝图")
    expect(result.finalSystemPrompt).not.toContain("维度一")
    expect(result.finalSystemPrompt).not.toContain("维度四")
    expect(result.finalSystemPrompt).toContain("### 1. 本章目标")
    expect(result.finalSystemPrompt).toContain("### 2. 已知依据")
    expect(result.finalSystemPrompt).toContain("### 3. 执行边界")
    expect(result.finalSystemPrompt).toContain("### 4. 分场景执行计划")
    expect(result.finalSystemPrompt).toContain("### 5. 信息流与伏笔")
    expect(result.finalSystemPrompt).toContain("### 6. 验收标准")
    expect(result.finalSystemPrompt).toContain("### 7. 风险与兜底")
    expect(result.finalSystemPrompt).not.toContain("承接与边界")
    expect(result.finalSystemPrompt).not.toContain("戏剧问题与信息流")
    expect(result.finalSystemPrompt).not.toContain("执行分层")
    expect(result.finalSystemPrompt).not.toContain("结尾钩子")
    expect(result.finalSystemPrompt).toContain("1200-1800字")
    expect(result.finalSystemPrompt).toContain("S1/S2/S3")
    expect(result.finalSystemPrompt).toContain("目的、冲突、转折、输出结果、验收标准")
    expect(result.finalSystemPrompt).toContain("输出结果")
    expect(result.finalSystemPrompt).toContain("验收标准")
    expect(result.finalSystemPrompt).toContain("必须执行")
    expect(result.finalSystemPrompt).toContain("禁止违背")
    expect(result.finalSystemPrompt).toContain("可自由发挥")
    expect(result.finalSystemPrompt).toContain("planBlueprint")
    // NF-02：planBlueprint 已接线，必须保留明确的「请传入」指令（含完整透传约束）。
    expect(result.finalSystemPrompt).toContain("planBlueprint 参数传入")
    expect(result.finalSystemPrompt).toContain("不得改写")
    // NF-02：workflowMode / intent 本轮未接线，提示词不得承诺它们生效。
    expect(result.finalSystemPrompt).not.toContain("workflowMode")
    expect(result.finalSystemPrompt).not.toContain("intent")
    expect(result.finalSystemPrompt).toContain("大纲定位协议")
    expect(result.finalSystemPrompt).toContain("list_outlines")
    expect(result.finalSystemPrompt).toContain("按文件夹分流")
    expect(result.finalSystemRulesPrompt).toContain("章节主编策划协议")
    expect(result.finalSystemRulesPrompt).not.toContain("context prompt")
    const finalPrompt = result.finalSystemPrompt ?? ""
    expect(finalPrompt.length).toBeLessThan(4500)
  })

  it("injects outline find protocol for chapter writing even without Plan Execute", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })

    const result = await plugin.run({
      userMessage: "写第167章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "strict",
      planExecuteEnabled: false,
      taskRoute: {
        intent: "write_chapter",
        confidence: 0.95,
        chapterNumber: 167,
        extractedParams: { chapterNumber: "167" },
      },
    })

    expect(result.finalSystemPrompt).toContain("大纲定位协议")
    expect(result.finalSystemPrompt).toContain("本次写作目标：第 167 章")
    expect(result.finalSystemPrompt).toContain("overview")
    expect(result.finalSystemPrompt).not.toContain("章节主编策划协议")
    const occurrences = (result.finalSystemPrompt?.match(/大纲定位协议/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it("does not inject outline find protocol for non-writing intents", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
    })

    const result = await plugin.run({
      userMessage: "陈远现在知道什么",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "strict",
      taskRoute: { intent: "character_query", confidence: 0.9, extractedParams: {} },
    })

    expect(result.finalSystemPrompt).not.toContain("大纲定位协议")
  })

  it("dedupes outline find protocol already present in base system prompt", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: ["base", buildOutlineFindProtocol(1), "tail"].join("\n\n"),
    })

    const result = await plugin.run({
      userMessage: "写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      taskRoute: {
        intent: "write_chapter",
        confidence: 0.9,
        chapterNumber: 167,
        extractedParams: {},
      },
    })

    const occurrences = (result.finalSystemPrompt?.match(/大纲定位协议/g) ?? []).length
    expect(occurrences).toBe(1)
    expect(result.finalSystemPrompt).toContain("本次写作目标：第 167 章")
  })

  it.each(["fast", "standard", "strict"] as const)(
    "injects chapter plan protocol when Plan Execute is enabled with %s mode",
    async (mode) => {
      const plugin = createBuildSystemPromptPlugin({
        baseSystemPrompt: "base prompt",
        buildTaskDirectiveFn: () => "task directive",
      })

      const result = await plugin.run({
        userMessage: "帮我写下一章",
        projectPath: "/project",
        agentConfig: {} as any,
        novelMode: true,
        aiWorkflowMode: mode,
        planExecuteEnabled: true,
        taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      })

      expect(result.finalSystemPrompt).toContain("章节主编策划协议")
      expect(result.finalSystemPrompt).toContain("<!-- chapter_plan -->")
      expect(result.finalSystemPrompt).toContain("<!-- /chapter_plan -->")
      expect(result.finalSystemPrompt).toContain("等待用户确认")
    },
  )
})

const mockAgentConfig: AgentConfig = {
  maxRounds: 4,
  tools: [],
  // 本文件的用例都假定 agent 侧无自定义 systemPrompt（无任务指令时结果应为空串）
  systemPrompt: "",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    model: "test-model",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  },
}

describe("BuildSystemPromptPlugin 覆盖补齐（残留分支）", () => {
  const baseInput = {
    userMessage: "hi",
    projectPath: "/project",
    agentConfig: mockAgentConfig,
  }

  it("非 novel 模式直接返回空对象", async () => {
    const plugin = createBuildSystemPromptPlugin({
      baseSystemPrompt: "base prompt",
      buildTaskDirectiveFn: () => "task directive",
    })
    await expect(plugin.run({ ...baseInput, novelMode: false })).resolves.toEqual({})
  })

  it("无 taskRoute 时跳过任务指令注入", async () => {
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: () => "task directive",
    })
    const result = await plugin.run({ ...baseInput, novelMode: true })
    expect(result.finalSystemPrompt).toBe("")
    expect(result.finalSystemRulesPrompt).toBe("")
  })

  it("空指令字符串不注入（非写作意图，无大纲协议干扰）", async () => {
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: () => "",
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "character_query", confidence: 0.9, extractedParams: {} },
    })
    expect(result.finalSystemPrompt).toBe("")
  })

  it("missingSkillNames 注入路由诊断并过滤非字符串", async () => {
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: () => "task directive",
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      missingSkillNames: ["ghost-skill", 123 as never, null as never],
    })
    expect(result.finalSystemPrompt).toContain("Skill 路由诊断")
    expect(result.finalSystemPrompt).toContain("ghost-skill")
    expect(result.finalSystemPrompt).not.toContain("123")
    expect(result.dynamicSystemRulesPrompt).toContain("ghost-skill")
  })

  it("空 missingSkillNames 不注入诊断", async () => {
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: () => "task directive",
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      missingSkillNames: [],
    })
    expect(result.finalSystemPrompt).not.toContain("Skill 路由诊断")
  })

  it("指令构建抛错 → onError 收到 Error 并返回空对象", async () => {
    const onError = vi.fn()
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: () => {
        throw new Error("directive boom")
      },
      onError,
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })
    expect(result).toEqual({})
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0] as Error[])[0]).toBeInstanceOf(Error)
  })

  it("非 Error 抛错被包装为 Error 交给 onError", async () => {
    const onError = vi.fn()
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: (() => {
        throw "boom-string"
      }) as never,
      onError,
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })
    expect(result).toEqual({})
    expect(onError).toHaveBeenCalledTimes(1)
    const err = (onError.mock.calls[0] as Error[])[0]
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("boom-string")
  })

  it("非 Error 抛错被包装后吞掉（无 onError 不崩）", async () => {
    const plugin = createBuildSystemPromptPlugin({
      buildTaskDirectiveFn: (() => {
        throw "boom-string"
      }) as never,
    })
    const result = await plugin.run({
      ...baseInput,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
    })
    expect(result).toEqual({})
  })
})
