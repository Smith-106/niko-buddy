import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "@/lib/agent/registry"
import { missingRequiredToolsOnce } from "@/lib/agent/required-tools-gate"
import type { AgentConfig, AgentMessage, AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { useOutlineChatStore } from "@/stores/outline-chat-store"
import { listDirectory, readFile } from "@/commands/fs"
import {
  MAIN_CONTROL_TOOLS,
  loadOutlineConversations,
  parseDraftReceipts,
  resolveMainControlGateIntent,
  resolveWikiPath,
  runMainControlAgent,
} from "./main-control"
import { routeTask } from "./task-router"
// 真实交接文案的生产者（纯字符串函数，无 React 依赖）：用例锁「生产者 → 门控」整条链。
import { buildChapterDraftGoal } from "@/components/novel/main-control-handoff"
import { setModuleHeatSink } from "./module-heat"

// F04 断言需要真实大纲目录内容（list_outlines 的默认章号只在非空清单里输出）；
// 其余文件命令保留原实现，工具注册路径不触碰 fs。
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: vi.fn(),
    readFile: vi.fn(),
  }
})

const LLM = { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" } as unknown as LlmConfig

/** 造一个假 runner：按预设顺序触发回调并发起工具调用。 */
function fakeRunner(
  plan: Array<{ id: string; name: string; arguments?: Record<string, unknown>; result?: string; error?: string }>,
  finalText = "已完成。",
): { run: (config: unknown, reg: unknown, msgs: unknown, cb: AgentRunCallbacks) => Promise<AgentRunRecord> } {
  return {
    async run(_config, _registry, _messages, callbacks) {
      const toolCalls: AgentRunRecord["toolCalls"] = []
      for (const step of plan) {
        callbacks.onToolCall({ id: step.id, name: step.name, arguments: step.arguments ?? {} })
        if (step.error) {
          callbacks.onToolError(step.id, step.error)
          toolCalls.push({
            id: step.id,
            name: step.name,
            params: step.arguments ?? {},
            result: "",
            status: "error",
            startedAt: 0,
            finishedAt: 0,
          })
          continue
        }
        callbacks.onToolResult(step.id, step.result ?? "ok")
        toolCalls.push({
          id: step.id,
          name: step.name,
          params: step.arguments ?? {},
          result: step.result ?? "ok",
          status: "done",
          startedAt: 0,
          finishedAt: 0,
        })
      }
      callbacks.onText(finalText)
      callbacks.onDone()
      return { toolCalls, roundsUsed: 2, finalText }
    },
  }
}

beforeEach(() => {
  setModuleHeatSink(null)
  vi.clearAllMocks()
  // F08 数据源隔离：store 是全局单例，逐个用例重置，避免串味。
  useOutlineChatStore.setState({ conversations: [], activeConversationId: null, loaded: false })
})

describe("parseDraftReceipts", () => {
  it("解析草稿回执的 ID、章节名与字数", () => {
    const drafts = parseDraftReceipts([
      "已生成章节草稿「第12章 旧梦」，等待确认保存。\n草稿ID: draft_1700000000_ab12cd\n字数：3200字",
      "无关回执",
    ])
    expect(drafts).toEqual([{ id: "draft_1700000000_ab12cd", chapterName: "第12章 旧梦", words: 3200 }])
  })

  it("忽略没有草稿 ID 的文本", () => {
    expect(parseDraftReceipts(["读取成功", ""])).toEqual([])
  })
})

describe("resolveWikiPath", () => {
  it("存在 <project>/wiki 时用它", async () => {
    const exists = vi.fn(async (p: string) => p === "/proj/wiki")
    await expect(resolveWikiPath("/proj", exists)).resolves.toBe("/proj/wiki")
  })

  it("缺省回退到项目根（单目录布局）", async () => {
    const exists = vi.fn(async () => false)
    await expect(resolveWikiPath("/proj/", exists)).resolves.toBe("/proj")
  })
})

describe("runMainControlAgent", () => {
  it("空目标直接失败，不调用模型", async () => {
    const run = vi.fn()
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "   ",
      llmConfig: LLM,
      deps: { runner: { run } },
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("目标")
    expect(run).not.toHaveBeenCalled()
  })

  it("注册白名单：只有只读工具 + 草稿写入，正式记忆/大纲写工具不注册", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 3 章",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).toContain("read_chapter")
    expect(names).toContain("write_chapter")
    expect(names).not.toContain("write_memory")
    expect(names).not.toContain("write_outline_node")
    // run_chapter_workflow 需要注入深章流水线，阶段 1 未注入 → 不注册
    expect(names).not.toContain("run_chapter_workflow")
    for (const name of names) expect(MAIN_CONTROL_TOOLS).toContain(name)
  })

  it("收集轨迹、解析草稿并返回终稿", async () => {
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "给第 12 章写个开头",
      llmConfig: LLM,
      deps: {
        runner: fakeRunner([
          { id: "c1", name: "list_chapters" },
          { id: "c2", name: "read_chapter", arguments: { name: "第12章" } },
          {
            id: "c3",
            name: "write_chapter",
            arguments: { name: "第12章 旧梦" },
            result: "已生成章节草稿「第12章 旧梦」，等待确认保存。\n草稿ID: draft_91_x\n字数：1800字",
          },
        ]),
      },
    })
    expect(out.ok).toBe(true)
    expect(out.steps.map((s) => s.name)).toEqual(["list_chapters", "read_chapter", "write_chapter"])
    expect(out.drafts).toEqual([{ id: "draft_91_x", chapterName: "第12章 旧梦", words: 1800 }])
    expect(out.finalText).toBe("已完成。")
    expect(out.roundsUsed).toBe(2)
  })

  it("工具失败被记录为 error 步骤，run 抛错时返回 error", async () => {
    const failing = {
      async run() {
        throw new Error("模型不可用")
      },
    }
    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 1 章",
      llmConfig: LLM,
      deps: { runner: failing, registry: new ToolRegistry() },
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain("模型不可用")
  })

  it("onStep 回调拿到每次工具调用状态", async () => {
    const seen: string[] = []
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 2 章",
      llmConfig: LLM,
      onStep: (step) => seen.push(`${step.name}:${step.status}`),
      deps: { runner: fakeRunner([{ id: "c1", name: "read_chapter" }]) },
    })
    expect(seen).toEqual(["read_chapter:running", "read_chapter:done"])
  })

  it("D5=A：onActivityEvent 进 activities 通道，不污染 steps/toolCalls", async () => {
    const baseRunner = fakeRunner([{ id: "c1", name: "read_chapter" }])
    const withActivity = {
      async run(config: unknown, reg: unknown, msgs: unknown, callbacks: AgentRunCallbacks) {
        callbacks.onActivityEvent?.({
          id: "a1",
          stageId: "s1",
          kind: "stage_started",
          title: "阶段开始",
          content: "go",
          timestamp: 5,
        })
        return baseRunner.run(config, reg, msgs, callbacks)
      },
    }
    const options = {
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 2 章",
      llmConfig: LLM,
    } as const

    const withEvent = await runMainControlAgent({ ...options, deps: { runner: withActivity } })
    expect(withEvent.activities).toHaveLength(1)
    expect(withEvent.activities?.[0].kind).toBe("stage_started")

    // steps 与不触发活动时逐字相同（activities 未进 steps；时间戳不可比，故剔去）
    const withoutEvent = await runMainControlAgent({ ...options, deps: { runner: fakeRunner([{ id: "c1", name: "read_chapter" }]) } })
    const stripTimes = (steps: typeof withEvent.steps) =>
      steps.map(({ at: _at, finishedAt: _finishedAt, ...rest }) => rest)
    expect(stripTimes(withEvent.steps)).toEqual(stripTimes(withoutEvent.steps))
    // 负例：没收到活动时结果对象不带 activities 键（不伪造空数组）
    expect("activities" in withoutEvent).toBe(false)
  })
})

describe("深章流水线工具注入", () => {
  it("G3：stageJournal 与 onActivityEvent 一路透传到 run_chapter_workflow，活动进 activities 通道", async () => {
    const registry = new ToolRegistry()
    const stageJournal = { projectId: "p1", deps: {} as never, ttlMs: 1000 }
    const runDeepChapterGeneration = vi.fn()
    // fakeRunner 内部触发一次阶段活动：证明主控收集器被工具层共用（同一函数引用）
    const runner = {
      async run(_config: unknown, _registry: unknown, _messages: unknown, callbacks: AgentRunCallbacks) {
        callbacks.onActivityEvent?.({
          id: "a1",
          stageId: "run_chapter_workflow",
          kind: "stage_output",
          title: "深章阶段产出",
          content: "任务书片段",
          timestamp: 7,
        })
        callbacks.onText("完成")
        callbacks.onDone()
        return { toolCalls: [], roundsUsed: 1, finalText: "完成" } as AgentRunRecord
      },
    }

    const out = await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      runDeepChapterGeneration,
      stageJournal,
      aiWorkflowMode: "standard",
      deps: { runner, registry },
    })

    // 工具确实注册（说明 aiWorkflowMode + runDeepChapterGeneration 组合生效）
    expect(registry.list().some((tool) => tool.name === "run_chapter_workflow")).toBe(true)
    // 活动经同一收集器回到主控通道
    expect(out.activities).toHaveLength(1)
    expect(out.activities?.[0].kind).toBe("stage_output")
  })

  it("未注入 runDeepChapterGeneration 时不注册 run_chapter_workflow", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 1 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      deps: { runner: fakeRunner([]), registry },
    })
    expect(registry.list().map((t) => t.name)).not.toContain("run_chapter_workflow")
  })

  it("注入深章流水线后注册 run_chapter_workflow，且不因此放宽正式写入边界", async () => {
    const registry = new ToolRegistry()
    const runDeepChapterGeneration = vi.fn(async () => ({ ok: true })) as never
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 1 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration,
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((t) => t.name)
    expect(names).toContain("run_chapter_workflow")
    expect(names).not.toContain("write_memory")
    expect(names).not.toContain("write_outline_node")
    expect(names).toContain("write_chapter")
  })

  it("注入 quality 与深章流水线时两套工具并存（白名单取并集）", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 1 章并评分",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: vi.fn(async () => ({ ok: true })) as never,
      quality: { scoreChapter: async () => ({ thrill: 8 }), reviseChapter: async (c) => c },
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((t) => t.name)
    for (const name of ["run_chapter_workflow", "score_chapter", "revise_chapter", "write_chapter"]) {
      expect(names).toContain(name)
    }
    for (const name of names) {
      const allowed = [...MAIN_CONTROL_TOOLS, "score_chapter", "revise_chapter", "run_chapter_workflow"]
      expect(allowed).toContain(name)
    }
  })
})

describe("工具白名单收窄", () => {
  it("F05：白名单只收窄不放大——不含 route_task / trim_context，保留 load_context", () => {
    expect(MAIN_CONTROL_TOOLS).toContain("load_context")
    expect(MAIN_CONTROL_TOOLS).not.toContain("route_task")
    expect(MAIN_CONTROL_TOOLS).not.toContain("trim_context")
  })

  it("F05：主控内 route_task 不再注册（结果零消费者），白名单总数不增长", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 12 章",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).not.toContain("route_task")
    expect(names).not.toContain("trim_context")
    // 白名单条目 13 → 12（移除 route_task），实际注册数 12 → 12：
    // 移除 route_task（−1）与 load_context 真正注册（+1）相抵，边界没有放大。
    expect(names).toHaveLength(MAIN_CONTROL_TOOLS.length)
  })

  it("显式点名工具后只注册这些（含依赖工具）", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "只打分",
      llmConfig: LLM,
      quality: { scoreChapter: async () => ({ thrill: 8 }), reviseChapter: async (c) => c },
      enabledToolNames: ["score_chapter", "write_chapter"],
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name).sort()
    expect(names).toEqual(["score_chapter", "write_chapter"])
  })

  it("点名未注入依赖的工具被剔除，且不能借白名单越权", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "越权尝试",
      llmConfig: LLM,
      enabledToolNames: ["revise_chapter", "run_chapter_workflow", "write_memory", "read_chapter"],
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).toEqual(["read_chapter"])
    expect(names).not.toContain("write_memory")
    expect(names).not.toContain("revise_chapter")
  })

  it("空提名回落为默认全量白名单", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "默认",
      llmConfig: LLM,
      enabledToolNames: [],
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).toContain("list_chapters")
    expect(names).toContain("write_chapter")
  })
})

describe("装配层：taskRoute 注入（F04）与大纲历史数据源（F08）", () => {
  it("F04：taskRoute 注入后 load_context 真正注册（注册条件就是 vtc.taskRoute 存在），轮次预算不变", async () => {
    const registry = new ToolRegistry()
    const base = fakeRunner([])
    let maxRounds: number | undefined
    const capturingRunner = {
      async run(config: unknown, reg: unknown, msgs: unknown, callbacks: AgentRunCallbacks) {
        maxRounds = (config as { maxRounds?: number }).maxRounds
        return base.run(config, reg, msgs, callbacks)
      },
    }
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 12 章",
      llmConfig: LLM,
      deps: { runner: capturingRunner, registry },
    })
    expect(registry.list().map((tool) => tool.name)).toContain("load_context")
    // 多一个可用工具不得放宽轮次预算（load_context 只是「一轮里的一个调用」）
    expect(maxRounds).toBe(8)
  })

  it("F04：list_outlines 的默认章号来自装配层注入的 taskRoute", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "章纲-第12章.md", path: "/proj/wiki/outlines/章纲-第12章.md", is_dir: false },
    ])
    vi.mocked(readFile).mockResolvedValue("---\ntype: 章纲\n---\n# 第12章 旧梦\n")
    const registry = new ToolRegistry()
    // 章节页交接的真实目标文案（buildChapterDraftGoal 同一句式）
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "为「第12章 旧梦」生成本章草稿",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const tool = registry.get("list_outlines")
    expect(tool).toBeDefined()
    const out = await tool!.execute({})
    expect(out).toContain("章纲-第12章.md")
    expect(out).toContain("本次目标章号：第 12 章")
  })

  it("F08：read_outline_history 读真实大纲会话（outline-chat-store），不再恒返回空", async () => {
    useOutlineChatStore.setState({
      conversations: [
        {
          id: "oc1",
          title: "大纲对话 10:00",
          createdAt: 1,
          messages: [
            { id: "m1", role: "user", content: "帮我排第 3 章大纲" },
            { id: "m2", role: "assistant", content: "第 3 章：旧梦重临，转折点放在结尾。" },
          ],
        },
      ],
      activeConversationId: "oc1",
      loaded: true,
    })
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 3 章大纲历史",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const tool = registry.get("read_outline_history")
    expect(tool).toBeDefined()
    const out = await tool!.execute({ conversationId: "oc1" })
    expect(out).toContain("第 3 章：旧梦重临")
    expect(out).toContain("[用户]: 帮我排第 3 章大纲")
  })

  it("F08：无大纲会话时如实返回未找到（不伪造）", async () => {
    await expect(loadOutlineConversations()).resolves.toEqual([])
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 1 章大纲历史",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const tool = registry.get("read_outline_history")
    await expect(tool!.execute({ conversationId: "missing" })).resolves.toContain("未找到大纲会话")
  })
})

describe("质量闭环工具注入", () => {
  it("默认不注册 score_chapter / revise_chapter", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "读第 1 章",
      llmConfig: LLM,
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).not.toContain("score_chapter")
    expect(names).not.toContain("revise_chapter")
  })

  it("注入 quality 后注册两个工具并可被 Agent 调用", async () => {
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "把第 3 章改到 9 分",
      llmConfig: LLM,
      quality: {
        scoreChapter: async () => ({ thrill: 8, consistency: 9, pacing: 8.4, character: 9, continuity: 9, pull: 8 }),
        reviseChapter: async (content, brief) => `${content}
<!-- ${brief} -->`,
      },
      deps: { runner: fakeRunner([]), registry },
    })
    const names = registry.list().map((tool) => tool.name)
    expect(names).toContain("score_chapter")
    expect(names).toContain("revise_chapter")
    // 仍然不含正式写入工具（Draft-first 边界不因注入而放宽）
    expect(names).not.toContain("write_memory")
    expect(names).not.toContain("write_outline_node")

    const scoreTool = registry.get("score_chapter")
    const scored = await scoreTool!.execute({ content: "正文内容" })
    expect(JSON.parse(scored)).toMatchObject({ median: 8.7 })

    const reviseTool = registry.get("revise_chapter")
    await expect(reviseTool!.execute({ content: "正文", brief: "提升 pacing" })).resolves.toContain("提升 pacing")
    await expect(reviseTool!.execute({ content: "正文", brief: "" })).resolves.toContain("错误")
  })
})

/**
 * NF-01：确定性门控的**武装点**。
 *
 * 这组用例锁的是「装配层把 resolveRequiredToolsOnce 的结果真的写进 config」——
 * 门控函数本身（required-tools-gate.spec）与 runner 四道接线都不在这里重复验证。
 * 关键点：断言的是**折算后**的 armed 值，而不是硬编码数组的复制；因此每一条
 * 「不武装」的分支（fast / 未注入深章 / 非章节意图 / 白名单收窄 / 非小说模式）
 * 都能反过来证明赋值确实走了 resolveRequiredToolsOnce，而非写死。
 */
describe("NF-01 门控武装：config.requiredToolsOnce", () => {
  /** 捕获装配层交给 runner 的 config（fakeRunner 的 config 形参是 unknown，读不到字段）。 */
  function captureRunner() {
    const captured: { config?: AgentConfig } = {}
    const runner = {
      async run(
        config: AgentConfig,
        _registry: ToolRegistry,
        _messages: AgentMessage[],
        callbacks: AgentRunCallbacks,
      ): Promise<AgentRunRecord> {
        captured.config = config
        callbacks.onText("已完成。")
        callbacks.onDone()
        return { toolCalls: [], roundsUsed: 1, finalText: "已完成。" }
      },
    }
    return { captured, runner }
  }

  /** 深章流水线注入桩：只有注入它，run_chapter_workflow 才会注册。 */
  const deepRunner = () => vi.fn(async () => ({ ok: true })) as never

  it("章节写作意图 + 深章注入 + standard：requiredToolsOnce 武装为 run_chapter_workflow", async () => {
    const { captured, runner } = captureRunner()
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      deps: { runner, registry },
    })
    expect(captured.config?.requiredToolsOnce).toEqual(["run_chapter_workflow"])
    // 武装的名字必须落在**真的注册了**的工具上：否则 missingRequiredToolsOnce 会把
    // 不可用项过滤掉，门控永远放行（等于没武装）。
    expect(captured.config?.tools.map((tool) => tool.name)).toContain("run_chapter_workflow")
  })

  it("装配 → 门控闭环：未调用该工具时 missingRequiredToolsOnce 非空", async () => {
    const { captured, runner } = captureRunner()
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "续写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "strict",
      runDeepChapterGeneration: deepRunner(),
      deps: { runner, registry },
    })
    const availableToolNames = captured.config?.tools.map((tool) => tool.name) ?? []
    const gateInput = {
      requiredToolsOnce: captured.config?.requiredToolsOnce,
      availableToolNames,
      toolsEnabled: true,
    }
    // 一次都没调用 → 拒绝无 tool 终稿
    expect(missingRequiredToolsOnce({ ...gateInput, calledToolNames: [] })).toEqual(["run_chapter_workflow"])
    // 调用过 → 放行
    expect(missingRequiredToolsOnce({ ...gateInput, calledToolNames: ["run_chapter_workflow"] })).toEqual([])
  })

  it("fast 模式不武装（快速模式允许主 Agent 直接出稿）", async () => {
    const { captured, runner } = captureRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "fast",
      runDeepChapterGeneration: deepRunner(),
      deps: { runner, registry: new ToolRegistry() },
    })
    expect(captured.config?.requiredToolsOnce).toBeUndefined()
  })

  it("未注入深章流水线不武装（工具没注册就不要求）", async () => {
    const { captured, runner } = captureRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      deps: { runner, registry: new ToolRegistry() },
    })
    expect(captured.config?.requiredToolsOnce).toBeUndefined()
    expect(captured.config?.tools.map((tool) => tool.name)).not.toContain("run_chapter_workflow")
  })

  it("非章节写作意图不武装（审稿/读取不该被要求走章节工作流）", async () => {
    const { captured, runner } = captureRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "检查第 3 章有没有矛盾",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      deps: { runner, registry: new ToolRegistry() },
    })
    expect(captured.config?.requiredToolsOnce).toBeUndefined()
  })

  it("白名单收窄掉 run_chapter_workflow 后不武装", async () => {
    const { captured, runner } = captureRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      enabledToolNames: ["read_chapter", "write_chapter"],
      deps: { runner, registry: new ToolRegistry() },
    })
    expect(captured.config?.requiredToolsOnce).toBeUndefined()
  })

  it("非小说模式不武装（novelMode 关闭时章节工作流不注册，也不该被要求）", async () => {
    const previous = useWikiStore.getState().novelMode
    useWikiStore.setState({ novelMode: false })
    try {
      const { captured, runner } = captureRunner()
      await runMainControlAgent({
        projectPath: "/proj",
        wikiPath: "/proj/wiki",
        goal: "写第 3 章",
        llmConfig: LLM,
        aiWorkflowMode: "standard",
        runDeepChapterGeneration: deepRunner(),
        deps: { runner, registry: new ToolRegistry() },
      })
      expect(captured.config?.requiredToolsOnce).toBeUndefined()
    } finally {
      useWikiStore.setState({ novelMode: previous })
    }
  })
})

/**
 * NF-01 补口：真实交接目标的门控武装（`resolveMainControlGateIntent`）。
 *
 * TASK-007 实测缺口：章节页「生成草稿」交接的目标文案
 * （`buildChapterDraftGoal` → `为「第N章 X」生成本章草稿`）被 `routeTask` 判成
 * `general_chat`（`write_chapter` 的触发式要求「动词在前、章号在后」），于是
 * `resolveRequiredToolsOnce` 直接返回 undefined —— 最典型的真实写作场景反而不武装。
 *
 * 这组用例锁两件事：
 * 1. 真实交接文案（含无「第N章」前缀的章节名）现在会武装，且武装名字真的在注册表里；
 * 2. 纯聊天/检索/提及类目标**不**被误武装（门控只放大 `general_chat → write_chapter`
 *    一条边，`taskRoute.intent` 本身不被改写）。
 */
describe("NF-01 补口：真实交接目标武装（草稿生成意图归一化）", () => {
  function captureArmedRunner() {
    const captured: { config?: AgentConfig } = {}
    const runner = {
      async run(
        config: AgentConfig,
        _registry: ToolRegistry,
        _messages: AgentMessage[],
        callbacks: AgentRunCallbacks,
      ): Promise<AgentRunRecord> {
        captured.config = config
        callbacks.onText("已完成。")
        callbacks.onDone()
        return { toolCalls: [], roundsUsed: 1, finalText: "已完成。" }
      },
    }
    return { captured, runner }
  }

  const deepRunner = () => vi.fn(async () => ({ ok: true })) as never

  /** 走真实装配（`runMainControlAgent`），返回门控武装值与注册的工具名。 */
  async function armFor(goal: string) {
    const { captured, runner } = captureArmedRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal,
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      deps: { runner, registry: new ToolRegistry() },
    })
    return {
      requiredToolsOnce: captured.config?.requiredToolsOnce,
      toolNames: captured.config?.tools.map((tool) => tool.name) ?? [],
    }
  }

  it("章节页真实交接目标「为「第12章 旧梦」生成本章草稿」现在武装", async () => {
    // 用真实生产者（buildChapterDraftGoal）而不是手抄文案：文案若改，本用例立刻失败。
    const goal = buildChapterDraftGoal("第12章 旧梦")
    expect(goal).toBe("为「第12章 旧梦」生成本章草稿")
    const { requiredToolsOnce, toolNames } = await armFor(goal)
    expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
    // 武装的名字必须真的注册了，否则 missingRequiredToolsOnce 会把不可用项过滤掉。
    expect(toolNames).toContain("run_chapter_workflow")
  })

  it("章节名无「第N章」前缀的交接目标（为「旧梦」生成本章草稿）同样武装", async () => {
    const goal = buildChapterDraftGoal("旧梦")
    expect(goal).toBe("为「旧梦」生成本章草稿")
    const { requiredToolsOnce } = await armFor(goal)
    expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
  })

  it("归一化只喂门控：底层 routeTask 仍是 general_chat，taskRoute.intent 不被改写", () => {
    const goal = buildChapterDraftGoal("第12章 旧梦")
    const routed = routeTask(goal)
    expect(routed.intent).toBe("general_chat")
    const before = JSON.stringify(routed)
    expect(resolveMainControlGateIntent(goal, routed)).toBe("write_chapter")
    // 纯函数：入参对象未被就地改写（注入 virtualToolContext 的仍是路由原值）。
    expect(JSON.stringify(routed)).toBe(before)
    expect(routed.intent).toBe("general_chat")
  })

  it("纯聊天/检索/提及类目标不被误武装（章号存在也不够）", () => {
    const cases = [
      "读第 3 章",
      "第12章 旧梦",
      "第 12 章的大纲是什么",
      "把第12章翻译成英文",
      "列出第 3 章的所有人物",
      "帮我看看第12章写得怎么样",
      "本章草稿在哪",
      "把草稿区清空",
      "不要生成本章草稿",
      "写一份草稿给编辑",
    ]
    for (const goal of cases) {
      const routed = routeTask(goal)
      expect(routed.intent, goal).toBe("general_chat")
      expect(resolveMainControlGateIntent(goal, routed), goal).toBe("general_chat")
    }
  })

  it("已有非 general_chat 意图原样返回（审稿/润色/续写不被这一层改写）", () => {
    const cases: Array<[string, string]> = [
      ["检查第 3 章有没有矛盾", "review_chapter"],
      ["润色第 3 章", "polish_chapter"],
      // 「生成大纲草稿」路由到 generate_outline：不在四类章节写作意图里，归一化也不动它。
      ["生成大纲草稿", "generate_outline"],
      ["续写第 3 章", "write_chapter"],
      ["写第 3 章", "write_chapter"],
    ]
    for (const [goal, intent] of cases) {
      const routed = routeTask(goal)
      expect(routed.intent, goal).toBe(intent)
      expect(resolveMainControlGateIntent(goal, routed), goal).toBe(intent)
    }
  })

  it("装配层反例：纯聊天目标「读第 3 章」在 standard + 深章注入下仍不武装", async () => {
    const { requiredToolsOnce, toolNames } = await armFor("读第 3 章")
    expect(requiredToolsOnce).toBeUndefined()
    // 反证：工具确实注册了，不武装是判定结果而非工具缺失。
    expect(toolNames).toContain("run_chapter_workflow")
  })
})
