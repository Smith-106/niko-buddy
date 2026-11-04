import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "@/lib/agent/registry"
import { missingRequiredToolsOnce } from "@/lib/agent/required-tools-gate"
import type { AgentConfig, AgentMessage, AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { useOutlineChatStore } from "@/stores/outline-chat-store"
import { listDirectory, readFile } from "@/commands/fs"
import * as mainControl from "./main-control"
import {
  MAIN_CONTROL_TOOLS,
  loadOutlineConversations,
  parseDraftReceipts,
  resolveWikiPath,
  runMainControlAgent,
} from "./main-control"
import type { RunMainControlOptions } from "./main-control"
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
  // RV-11：`clearAllMocks` 只清调用记录、不清实现，某个用例的 `mockResolvedValue` 会泄漏到
  // 后续用例（fs mock 与各用例自建的 vi.fn 都受影响）。`resetAllMocks` 连实现一起重置，
  // 再在这里重设 fs 的两个安全默认值（空目录 / 空文本），每个用例从同一个干净起点开始。
  vi.resetAllMocks()
  vi.mocked(listDirectory).mockResolvedValue([])
  vi.mocked(readFile).mockResolvedValue("")
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
    // RV-10：钉死字面量。旧写法 `toHaveLength(MAIN_CONTROL_TOOLS.length)` 两边同源，
    // 白名单增长时断言自动跟着长，测不出边界被放大。
    // 白名单条目 13 → 12（移除 route_task），实际注册数 12 → 12：
    // 移除 route_task（−1）与 load_context 真正注册（+1）相抵，边界没有放大。
    expect(names).toHaveLength(12)
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

  it("F04：list_outlines 的默认章号来自 routeTask 的顶层 chapterNumber（装配层无补丁）", async () => {
    vi.mocked(listDirectory).mockResolvedValue([
      { name: "章纲-第12章.md", path: "/proj/wiki/outlines/章纲-第12章.md", is_dir: false },
    ])
    vi.mocked(readFile).mockResolvedValue("---\ntype: 章纲\n---\n# 第12章 旧梦\n")
    const registry = new ToolRegistry()
    // 章节页交接的真实目标文案（buildChapterDraftGoal 同一句式）。TASK-002 前该文案落在
    // `routeTask` 的 general_chat 早退分支、顶层章号为空，靠装配层 `buildMainControlTaskRoute`
    // 补回；TASK-001 让早退分支同样带顶层 `chapterNumber`，TASK-002 删掉补丁后本断言仍成立。
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

  it("非小说模式不武装（novelMode 显式关闭时不要求章节工作流）", async () => {
    const { captured, runner } = captureRunner()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal: "写第 3 章",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      // RV-08：novelMode 已是显式入参，不再读全局 wiki store（store 侧状态与本用例无关）。
      novelMode: false,
      deps: { runner, registry: new ToolRegistry() },
    })
    expect(captured.config?.requiredToolsOnce).toBeUndefined()
  })
})

/**
 * RV-01：门控武装只认**结构化意图**（`options.gateIntent ?? taskRoute.intent`），装配层不做任何文本推断。
 *
 * 旧实现在装配层用三个正则（草稿生成动词 / 章节引用 / 否定前缀）猜自由文本，
 * 复核实测 30 条反例中 13 条误命中；误武装的代价是兜底真的跑完整条深章流水线
 * （数分钟 + LLM 成本）并把正文当答案交付给提问者。现在：
 * - 不传 `gateIntent` → 只认 `routeTask` 的结构化路由结果（`taskRoute.intent`）；
 * - 交接模板「为「第N章 X」生成本章草稿」自 TASK-001 起由路由本体识别（锚定模板形状的正则），
 *   因此不需要 `gateIntent` 也武装——这是路由判定，不是文本猜测；
 * - `gateIntent` 保留给「路由本体判不出、调用方却确知意图」的场景，仍然不给就不武装。
 */
describe("RV-01 门控武装：结构化 gateIntent，无文本推断", () => {
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
  async function armFor(goal: string, extra: Partial<RunMainControlOptions> = {}) {
    const { captured, runner } = captureArmedRunner()
    const registry = new ToolRegistry()
    await runMainControlAgent({
      projectPath: "/proj",
      wikiPath: "/proj/wiki",
      goal,
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: deepRunner(),
      ...extra,
      deps: { runner, registry },
    })
    return {
      requiredToolsOnce: captured.config?.requiredToolsOnce,
      toolNames: captured.config?.tools.map((tool) => tool.name) ?? [],
      registry,
      config: captured.config,
    }
  }

  it("装配层不再导出任何意图推断函数（回归锁：正则归一化不得复活）", () => {
    expect("resolveMainControlGateIntent" in mainControl).toBe(false)
    expect("isChapterDraftGoal" in mainControl).toBe(false)
  })

  it("章节页交接文案：显式 gateIntent 仍然可用（真实生产者文案）", async () => {
    // 用真实生产者（buildChapterDraftGoal）而不是手抄文案：文案若改，本用例立刻失败。
    const goal = buildChapterDraftGoal("第12章 旧梦")
    expect(goal).toBe("为「第12章 旧梦」生成本章草稿")
    // TASK-002：路由本体已能识别该模板（见下一条用例），但调用方显式给 gateIntent 的通道
    // 必须继续有效——它服务于「路由判不出、调用方却确知意图」的场景。
    const { requiredToolsOnce, toolNames } = await armFor(goal, { gateIntent: "write_chapter" })
    expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
    // 武装的名字必须真的注册了，否则 missingRequiredToolsOnce 会把不可用项过滤掉。
    expect(toolNames).toContain("run_chapter_workflow")
  })

  it("交接模板由路由本体识别：不给 gateIntent 也武装（路由判定，不是文本猜测）", async () => {
    const goal = buildChapterDraftGoal("第12章 旧梦")
    // TASK-001：路由本体已能判出这条交接文案（锚定模板形状的正则），且顶层章号不再是空。
    expect(routeTask(goal).intent).toBe("write_chapter")
    expect(routeTask(goal).chapterNumber).toBe(12)
    // 因此不靠 `gateIntent` 也武装——原因是路由本体识别，而不是装配层对文本做猜测放大。
    const { requiredToolsOnce, toolNames } = await armFor(goal)
    expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
    // 反证：工具确实注册了，武装是判定结果而非工具缺失。
    expect(toolNames).toContain("run_chapter_workflow")
  })

  it("路由本身判得出写作意图时仍武装（结构化回落，不需要调用方补 gateIntent）", async () => {
    const { requiredToolsOnce } = await armFor("写第 3 章")
    expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
  })

  it("复核的 7 条误命中目标：不传 gateIntent 全部不武装", async () => {
    const misfires = [
      "不需要生成本章草稿",
      "请勿生成第7章草稿",
      "暂停生成本章草稿",
      "为什么要生成本章草稿？",
      "生成本章草稿的验收标准有哪些？",
      "输出第8章草稿的字数统计",
      "他说「生成本章草稿」是什么意思",
    ]
    for (const goal of misfires) {
      const { requiredToolsOnce, toolNames } = await armFor(goal)
      // TEMP-EVIDENCE
      // eslint-disable-next-line no-console
      console.log(
        "[EVIDENCE]",
        JSON.stringify({
          goal,
          intent: routeTask(goal).intent,
          chapterNumber: routeTask(goal).chapterNumber,
          armed: requiredToolsOnce,
          toolRegistered: toolNames.includes("run_chapter_workflow"),
        }),
      )
      expect(requiredToolsOnce, goal).toBeUndefined()
      // 反证：工具在，判定为「不武装」而非「工具缺失」。
      expect(toolNames, goal).toContain("run_chapter_workflow")
    }
  })

  it("检索/提及类目标不被误武装（旧反例清单全量回归，无 gateIntent）", async () => {
    const nonArming = [
      "读第 3 章",
      "第12章 旧梦",
      "第 12 章的大纲是什么",
      "把第12章翻译成英文",
      "列出第 3 章的所有人物",
      "帮我看看第12章写得怎么样",
      "本章草稿在哪",
      "把草稿区清空",
      "写一份草稿给编辑",
    ]
    for (const goal of nonArming) {
      const { requiredToolsOnce } = await armFor(goal)
      expect(requiredToolsOnce, goal).toBeUndefined()
    }
  })

  it("意图类别回归：门控直接吃 taskRoute.intent（审稿/大纲不武装，四类写作意图武装）", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["检查第 3 章有没有矛盾", "review_chapter", false],
      // 四类章节写作意图（write/continue/rewrite/polish）都会武装，这是门控既有语义，
      // RV-01 只删了「自由文本 → 意图」的猜测层，不改 `resolveRequiredToolsOnce` 的意图集。
      ["润色第 3 章", "polish_chapter", true],
      // 「生成大纲草稿」路由到 generate_outline：不在四类章节写作意图里，不武装。
      ["生成大纲草稿", "generate_outline", false],
      ["续写第 3 章", "write_chapter", true],
      ["写第 3 章", "write_chapter", true],
    ]
    for (const [goal, intent, shouldArm] of cases) {
      expect(routeTask(goal).intent, goal).toBe(intent)
      const { requiredToolsOnce } = await armFor(goal)
      expect(requiredToolsOnce, goal).toEqual(shouldArm ? ["run_chapter_workflow"] : undefined)
    }
  })

  it("RV-07：planExecuteActive 透传——计划收集阶段不武装", async () => {
    const goal = buildChapterDraftGoal("第12章 旧梦")
    const { requiredToolsOnce } = await armFor(goal, {
      gateIntent: "write_chapter",
      planExecuteActive: true,
    })
    expect(requiredToolsOnce).toBeUndefined()
  })

  it("RV-08：novelMode 是显式入参，不再另读全局 store（store 关闭但入参开启 → 仍武装）", async () => {
    const previous = useWikiStore.getState().novelMode
    useWikiStore.setState({ novelMode: false })
    try {
      const { requiredToolsOnce } = await armFor("写第 3 章", { novelMode: true })
      expect(requiredToolsOnce).toEqual(["run_chapter_workflow"])
    } finally {
      useWikiStore.setState({ novelMode: previous })
    }
  })

  it("RV-08：novelMode: false 显式关闭时不武装（与工具注册同源）", async () => {
    const { requiredToolsOnce } = await armFor("写第 3 章", { novelMode: false })
    expect(requiredToolsOnce).toBeUndefined()
  })

  it("RV-03：getPlanBlueprint 接通到已注册的 run_chapter_workflow（不再是死代码）", async () => {
    const deepRunnerWithInput = vi.fn(async () => ({
      finalContent: "正文",
      taskBrief: "任务书",
      draftContent: "初稿",
      reviewResults: [],
      decisionGates: {},
      manualReviewRequired: false,
      retryCount: 0,
      partial: false,
      partialReason: null,
      status: "passed",
      verdict: "pass",
      findings: [],
      revised: false,
    })) as never
    const { registry } = await armFor("写第 3 章", {
      runDeepChapterGeneration: deepRunnerWithInput,
      getPlanBlueprint: () => "会话层已确认计划：场景序列 1→2→3",
    })
    const tool = registry.get("run_chapter_workflow")
    expect(tool).toBeDefined()
    await tool!.execute({ userRequest: "写第 3 章", chapterNumber: 3 })
    expect(deepRunnerWithInput).toHaveBeenCalledWith(
      expect.objectContaining({ planBlueprint: "会话层已确认计划：场景序列 1→2→3" }),
      expect.any(Object),
      undefined,
      undefined,
      expect.any(Function),
    )
  })

  it("RV-02：兜底参数携带章节号与计划（getFallbackParams 优先）", async () => {
    const { registry } = await armFor("写第 3 章", {
      getFallbackParams: () => ({ chapterNumber: 7, planBlueprint: "已确认计划：七章" }),
    })
    const tool = registry.get("run_chapter_workflow")
    expect(tool?.buildRequiredToolFallbackParams).toBeDefined()
    expect(tool!.buildRequiredToolFallbackParams!({ taskGoal: "写第 3 章" })).toEqual({
      userRequest: "写第 3 章",
      chapterNumber: 7,
      planBlueprint: "已确认计划：七章",
    })
  })

  it("RV-02：未给 getFallbackParams 时章号回落到 taskRoute，计划回落到 getPlanBlueprint", async () => {
    const { registry } = await armFor("写第 12 章", {
      getPlanBlueprint: () => "会话层计划",
    })
    const tool = registry.get("run_chapter_workflow")
    expect(tool!.buildRequiredToolFallbackParams!({ taskGoal: "写第 12 章" })).toEqual({
      userRequest: "写第 12 章",
      chapterNumber: 12,
      planBlueprint: "会话层计划",
    })
  })
})
