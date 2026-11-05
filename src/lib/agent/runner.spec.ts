/** C4 冒烟覆盖：src/lib/agent/runner.ts（自动生成，核心行为由专项 spec 加深） */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * TASK-009：runner 侧的必调工具门控（requiredToolsOnce）此前只有「导出存在」级冒烟，
 * 行为面覆盖为零。门控的四条真实路径都在 `AgentRunner.runHeld` 里：
 *
 *   :105  诊断骨架初始化（record.requiredToolDiagnostics）
 *   :216  forceRequiredToolsImmediately —— 先跑确定性兜底，不先问模型
 *   :479  主门控 —— 本轮零工具调用 + 仍有缺失 → 兜底 / nudge / 拒稿 / 耗尽报错
 *   :628  轮次耗尽 —— 模型一直在调别的工具，直到 maxRounds 仍未满足必调工具
 *
 * 要驱动这四条路径，必须能控制「模型这一轮到底有没有调用 run_chapter_workflow」。
 * 全仓此前没有任何 spec mock 过 `streamChat`，所以这里把它换成脚本化假流：每轮产出
 * （纯文本 / 原生 tool_call delta）由用例给定。除此之外**全部走真实实现**——真实
 * config 判定、真实 ToolRegistry + 真实 executeAgentTool、真实 required-tools-gate
 * 判定函数、真实 executeRequiredToolFallback 兜底执行器、真实诊断结构。
 */
const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock("../llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm-client")>()
  return { ...actual, streamChat: mocks.streamChat }
})

import type { StreamCallbacks } from "../llm-client"
import { AgentRunner, ModelDoesNotSupportToolsError, REQUIRED_TOOL_NUDGE_MAX } from "./runner"
import { ToolRegistry } from "./registry"
import {
  buildRequiredToolNudgeMessage,
  RequiredToolFallbackError,
  RequiredToolsNotCalledError,
} from "./required-tools-gate"
import type {
  AgentConfig,
  AgentMessage,
  AgentRunCallbacks,
  AgentRunRecord,
  RequiredToolRunDiagnostics,
  Tool,
  ToolCallDelta,
} from "./types"

describe("runner.ts smoke", () => {
  it("exports ModelDoesNotSupportToolsError", () => {
    expect(ModelDoesNotSupportToolsError).toBeDefined()
  })
  it("exports AgentRunner", () => {
    expect(AgentRunner).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 脚本化假流 harness
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_TOOL = "run_chapter_workflow"
const NUDGE_MARKER = "禁止直接输出章节终稿正文"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4o-mini",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}

interface ScriptedRound {
  /** 本轮模型输出的纯文本（走 onToken）。 */
  text?: string
  /** 本轮模型发起的原生工具调用 delta。 */
  toolCalls?: ToolCallDelta[]
}

/**
 * 让 `streamChat` 按轮脚本产出。轮次用尽后重复最后一轮，避免用例把轮数写死。
 * 返回每轮实际发给 provider 的消息快照（深拷贝——runner 后续轮会 splice 同一个数组，
 * 断言必须看到当时的内容）。
 */
function scriptStream(rounds: ScriptedRound[]): AgentMessage[][] {
  const sentMessages: AgentMessage[][] = []
  let cursor = 0
  mocks.streamChat.mockImplementation(
    async (_llm: unknown, messages: unknown, callbacks: StreamCallbacks) => {
      sentMessages.push(JSON.parse(JSON.stringify(messages)) as AgentMessage[])
      const round = rounds[Math.min(cursor, rounds.length - 1)]
      cursor += 1
      if (round.text) callbacks.onToken(round.text)
      for (const delta of round.toolCalls ?? []) callbacks.onToolCallDelta?.(delta)
      callbacks.onFinishReason?.("stop")
      callbacks.onDone()
    },
  )
  return sentMessages
}

function toolCallDelta(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): ToolCallDelta {
  return { index: 0, id, name, arguments: JSON.stringify(args) }
}

/** 真实 run_chapter_workflow 的形状（finalizesRun + 确定性兜底入口），可按用例改写。 */
function createWorkflowTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: WORKFLOW_TOOL,
    description: "运行小说章节写作工作流",
    category: "action",
    permission: "auto",
    executeTimeoutMs: 0,
    parameters: {
      userRequest: { type: "string", description: "用户原始章节写作请求", required: true },
    },
    async execute() {
      return "工作流已生成章节"
    },
    ...overrides,
  }
}

function createRegistry(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool)
  return registry
}

function createConfig(tools: Tool[], overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    maxRounds: 4,
    tools,
    systemPrompt: "你是小说写作 Agent",
    llmConfig,
    taskGoal: "写第一章",
    ...overrides,
  }
}

function createCallbacks() {
  const texts: string[] = []
  const errors: Error[] = []
  const toolCalls: string[] = []
  const toolResults: string[] = []
  let doneCount = 0
  const callbacks: AgentRunCallbacks = {
    onText: (chunk) => {
      texts.push(chunk)
    },
    onToolCall: (call) => {
      toolCalls.push(call.name)
    },
    onToolResult: (_callId, result) => {
      toolResults.push(result)
    },
    onToolError: () => {},
    onDone: () => {
      doneCount += 1
    },
    onError: (error) => {
      errors.push(error)
    },
  }
  return {
    callbacks,
    texts,
    errors,
    toolCalls,
    toolResults,
    doneCount: () => doneCount,
  }
}

function diagnosticsOf(record: AgentRunRecord): RequiredToolRunDiagnostics {
  const diagnostics = record.requiredToolDiagnostics
  if (!diagnostics) throw new Error("expected record.requiredToolDiagnostics to be recorded")
  return diagnostics
}

/** nudge 只在本轮被门控拒绝时注入，因此它是「终稿被拦下过」的可观察证据。 */
function nudgeInjected(messages: AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.includes(NUDGE_MARKER),
  )
}

const INITIAL_MESSAGES: AgentMessage[] = [{ role: "user", content: "写第一章" }]

async function runAgent(
  config: AgentConfig,
  tools: Tool[],
  messages: AgentMessage[] = INITIAL_MESSAGES,
) {
  const recorder = createCallbacks()
  const record = await new AgentRunner().run(
    config,
    createRegistry(tools),
    messages,
    recorder.callbacks,
  )
  return { record, ...recorder }
}

beforeEach(() => {
  mocks.streamChat.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 1：工具已调用 → 终稿被接受（门控不拦截）
// ─────────────────────────────────────────────────────────────────────────────

describe("必调工具门控：工具已调用 → 终稿被接受", () => {
  it("模型调用 run_chapter_workflow（真实 finalizesRun 形状）→ 工具交付的终稿直接落库，不报门控错", async () => {
    const sentMessages = scriptStream([
      {
        toolCalls: [
          toolCallDelta(WORKFLOW_TOOL, { userRequest: "写第一章" }, "call_wf_1"),
        ],
      },
    ])

    const tool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute(_params, _signal, context) {
        context?.onFinalContent?.("第一章 落雪（工作流交付的正文）")
        return "工作流已交付第一章正文"
      },
    })

    const { record, errors, doneCount, toolCalls } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 4 }),
      [tool],
    )

    // 终稿被接受：工具交付的正文成为本次 run 的 finalText，并 onDone 收尾
    expect(record.finalText).toBe("第一章 落雪（工作流交付的正文）")
    expect(doneCount()).toBe(1)
    // 门控全程未触发：没有任何 onError，也没有注入过 nudge
    expect(errors).toEqual([])
    expect(toolCalls).toEqual([WORKFLOW_TOOL])
    expect(sentMessages.some(nudgeInjected)).toBe(false)

    // 诊断出口：必调工具已满足、无缺失、没有走兜底
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.requiredTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
    expect(diagnostics.fallbackAttempted).toBe(false)
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      [WORKFLOW_TOOL, "done"],
    ])
  })

  it("模型调用 run_chapter_workflow 后自己出终稿 → :470 门控判定为「无缺失」，终稿原样放行", async () => {
    // 用不 finalize 的替身才能把断言打到 :470 门控本身：真实 run_chapter_workflow 是
    // finalizesRun，会在 :596 短路，门控根本不会被问到。
    const sentMessages = scriptStream([
      { toolCalls: [toolCallDelta(WORKFLOW_TOOL, { userRequest: "写第一章" }, "call_wf_2")] },
      { text: "第一章 落雪\n\n正文由模型在拿到工作流结果后写出。" },
    ])

    const tool = createWorkflowTool({
      async execute() {
        return "章节工作流已完成：大纲 + 场景表 + 文风约束"
      },
    })

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 4 }),
      [tool],
    )

    expect(record.finalText).toBe("第一章 落雪\n\n正文由模型在拿到工作流结果后写出。")
    expect(texts).toEqual([record.finalText])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
    expect(record.roundsUsed).toBe(2)

    // 第 2 轮（模型出终稿那轮）的消息里没有 nudge → 门控放行而非拒稿续轮
    expect(sentMessages).toHaveLength(2)
    expect(nudgeInjected(sentMessages[1])).toBe(false)

    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
    expect(diagnostics.fallbackAttempted).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 2：工具未调用 + 重试耗尽 → 明确诊断（不是静默完成）
// ─────────────────────────────────────────────────────────────────────────────

describe("必调工具门控：工具未调用 + 重试耗尽 → 明确诊断", () => {
  it("模型始终不调工具、无兜底入口 → nudge 续轮后耗尽 → RequiredToolsNotCalledError，finalText 保持为空", async () => {
    const sentMessages = scriptStream([
      { text: "这是我要直接给你的章节正文（第一轮）" },
      { text: "还是直接给正文（第二轮）" },
    ])

    // 没有 buildRequiredToolFallbackParams → 兜底入口不可用，只能靠模型自己补
    const tool = createWorkflowTool()

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 2 }),
      [tool],
    )

    // 核心断言：没有静默完成。终稿没被接受、没 onDone，而是明确报错
    expect(record.finalText).toBe("")
    expect(texts).toEqual([])
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    const failure = errors[0]
    expect(failure).toBeInstanceOf(RequiredToolsNotCalledError)
    expect((failure as RequiredToolsNotCalledError).missingTools).toEqual([WORKFLOW_TOOL])
    expect(failure.message).toContain(WORKFLOW_TOOL)
    expect(failure.message).toContain("未调用必选工具")

    // 重试确实发生过：第 2 轮请求里带着 nudge（第 1 轮被拒稿并续轮）
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
    expect(nudgeInjected(sentMessages[1])).toBe(true)

    // 可观察诊断出口
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.requiredTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.satisfiedTools).toEqual([])
    expect(diagnostics.missingTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.fallbackAttempted).toBe(false)
    expect(diagnostics.fallbackStatus).toBe("unavailable")
    expect(diagnostics.roundsUsed).toBe(2)
    expect(diagnostics.provider).toBe("openai")
    expect(diagnostics.model).toBe("gpt-4o-mini")
    expect(diagnostics.observedToolCalls).toEqual([])
  })

  // ── RVF-12：nudge 注入后的消息形态不变量 ──
  //
  // 背景：nudge 的形态是「（可选的）assistant 散文 + 紧随的 role:system」。旧实现基本走不到
  // 这条路径，现在它是所有必调工具运行的主路径。真实 provider 是否接受这个形态无法在本仓
  // 内用单测证明（需真凭据），但属于**我们可以主动约束**的部分能做到：
  //   - system 消息内容非空（空 content 会被多家 provider 直接 400）；
  //   - system 不紧跟在 system 之后。
  //
  // 为什么**不**约束「相邻不得同角色」：那是错的。`runner.ts` 在 `for (const tc of …)` 里
  // push `role:"tool"`，模型一轮返回 2 个 tool call（并行调用，合法且常见）就产生两条相邻
  // tool。上一版写成全量「相邻不同角色」时，它只因脚本不产 toolCalls 而恒真 —— 既对 nudge
  // 零判别力，又给未来带工具轮次的用例埋了误红地雷。
  //
  // 断言的是「我们不主动构造非法形态」，不是「provider 一定接受」——两者不得混为一谈。
  function assertNudgeShapeInvariants(sentMessages: AgentMessage[][]): void {
    expect(sentMessages.length).toBeGreaterThan(0)
    for (const messages of sentMessages) {
      for (const message of messages) {
        if (message.role !== "system") continue
        expect(typeof message.content).toBe("string")
        expect((message.content as string).trim().length).toBeGreaterThan(0)
      }
      for (let i = 1; i < messages.length; i += 1) {
        if (messages[i].role === "system") {
          expect(messages[i - 1].role).not.toBe("system")
        }
      }
    }
  }

  it("RVF-12：nudge 注入后的消息形态满足协议级不变量", async () => {
    const sentMessages = scriptStream([
      { text: "第一轮散文，不调工具" },
      { text: "第二轮仍然不调工具" },
    ])
    const tool = createWorkflowTool()
    await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 2 }),
      [tool],
    )

    // 真发生了 nudge：第 2 轮请求里带着它
    expect(nudgeInjected(sentMessages[1])).toBe(true)
    assertNudgeShapeInvariants(sentMessages)
  })

  it("RVF-12：带并行工具调用（一轮两个 call）的消息流里不变量仍成立", async () => {
    // 这条用例让不变量在**真有 tool 消息**（且相邻两条）的消息流上被真正执行一次。
    // 如果哪个不变量错误地禁止了相邻同角色，这里就会红。
    const tool = createWorkflowTool()
    const otherTool: Tool = {
      ...createWorkflowTool(),
      name: "other_required_tool",
      execute: async () => "其他工具完成",
    }
    const sentMessages = scriptStream([
      {
        toolCalls: [
          // index 必须区分（toolCallDelta 硬编码 0，这里手写）：否则两个 delta 会按 index
          // 合并成一个调用，就构造不出「并行工具调用」这个前提。
          { index: 0, id: "call_wf_1", name: WORKFLOW_TOOL, arguments: JSON.stringify({ userRequest: "写第一章" }) },
          { index: 1, id: "call_other_1", name: "other_required_tool", arguments: JSON.stringify({ userRequest: "写第一章" }) },
        ],
      },
      { text: "第一章 落雪（终稿）" },
    ])
    await runAgent(
      createConfig([tool, otherTool], {
        requiredToolsOnce: [WORKFLOW_TOOL, "other_required_tool"],
        maxRounds: 3,
      }),
      [tool, otherTool],
    )

    // 前提成立：消息流里确实出现了相邻的两条 tool
    const roles = sentMessages[sentMessages.length - 1].map((m) => m.role)
    const hasAdjacentTool = roles.some((role, i) => i > 0 && role === "tool" && roles[i - 1] === "tool")
    expect(hasAdjacentTool).toBe(true)

    assertNudgeShapeInvariants(sentMessages)
  })

  it("RV2-002：模型连续返回空输出、连续两次 nudge → 不得产生相邻 system（nudge 并入尾部 system）", async () => {
    // 第二轮复核实测出的反例：assistant 的 push 是有条件的（本轮有文本/推理/思考块才 push），
    // 而 nudge 原本无条件 push。两轮都空输出时就会「…, system, system」。
    // 修法是让 nudge 并入尾部已有 system；不变量必须真的成立，否则断言比不写更糟。
    const sentMessages = scriptStream([{}, {}, {}])
    const tool = createWorkflowTool()
    await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 3 }),
      [tool],
    )

    // 前提成立：真的注入了两次 nudge（否则这条用例又在测空气）
    const nudgeCount = sentMessages.filter((messages) => nudgeInjected(messages)).length
    expect(nudgeCount).toBeGreaterThanOrEqual(2)

    assertNudgeShapeInvariants(sentMessages)

    // 且并入后内容没丢：带 nudge 标记的 system 只有**一条**（两次 nudge 已合并进同一条），
    // 且它就是最后一条消息 —— 证明合并没有把指令挤到中间去。
    const lastRound = sentMessages[sentMessages.length - 1]
    const nudgeSystems = lastRound.filter(
      (m) => m.role === "system" && String(m.content).includes(NUDGE_MARKER),
    )
    expect(nudgeSystems).toHaveLength(1)
    expect(lastRound[lastRound.length - 1].role).toBe("system")
    expect(String(lastRound[lastRound.length - 1].content)).toContain(NUDGE_MARKER)
  })

  it("RVF-12：nudge 内容本身非空且点名缺失工具", async () => {
    const message = buildRequiredToolNudgeMessage([WORKFLOW_TOOL])
    expect(typeof message).toBe("string")
    expect(message.trim().length).toBeGreaterThan(0)
    expect(message).toContain(WORKFLOW_TOOL)
  })

  it("模型始终不调工具、兜底入口存在但执行失败 → RequiredToolFallbackError，诊断记录兜底失败原因", async () => {
    scriptStream([{ text: "直接给正文（不打算调工作流）" }])

    const tool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute() {
        return "错误：章节工作流执行失败（项目未就绪）"
      },
    })

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 3 }),
      [tool],
    )

    expect(record.finalText).toBe("")
    expect(texts).toEqual([])
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    const failure = errors[0]
    expect(failure).toBeInstanceOf(RequiredToolFallbackError)
    expect((failure as RequiredToolFallbackError).toolName).toBe(WORKFLOW_TOOL)
    expect(failure.message).toContain("必选工作流执行失败")
    expect(failure.message).toContain("项目未就绪")

    // 兜底确实被执行过（toolCalls 里有那条确定性兜底调用），且诊断写明失败
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      [WORKFLOW_TOOL, "error"],
    ])
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(true)
    expect(diagnostics.fallbackTool).toBe(WORKFLOW_TOOL)
    expect(diagnostics.fallbackStatus).toBe("error")
    expect(diagnostics.fallbackError).toContain("项目未就绪")
    expect(diagnostics.missingTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.satisfiedTools).toEqual([])
  })

  it("模型每轮都在调别的工具 → 轮次耗尽走 :628 → RequiredToolsNotCalledError 并保留缺失诊断", async () => {
    scriptStream([
      { toolCalls: [toolCallDelta("read_chapter", { chapter: 1 }, "call_read_1")] },
      { toolCalls: [toolCallDelta("read_chapter", { chapter: 2 }, "call_read_2")] },
    ])

    const workflowTool = createWorkflowTool()
    const readTool: Tool = {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "第一章正文…"
      },
    }

    const { record, errors, doneCount } = await runAgent(
      createConfig([workflowTool, readTool], {
        requiredToolsOnce: [WORKFLOW_TOOL],
        maxRounds: 2,
      }),
      [workflowTool, readTool],
    )

    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
    expect((errors[0] as RequiredToolsNotCalledError).missingTools).toEqual([WORKFLOW_TOOL])
    expect(record.roundsUsed).toBe(2)

    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.missingTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.satisfiedTools).toEqual(["read_chapter"])
    expect(diagnostics.fallbackStatus).toBe("unavailable")
    expect(diagnostics.roundsUsed).toBe(2)
    expect(diagnostics.observedToolCalls).toEqual([
      { round: 1, index: 0, name: "read_chapter" },
      { round: 2, index: 0, name: "read_chapter" },
    ])
  })

  it("forceRequiredToolsImmediately → 不先问模型，确定性兜底直接交付终稿（:216）", async () => {
    scriptStream([{ text: "不该被请求到" }])

    const tool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute(_params, _signal, context) {
        context?.onFinalContent?.("第一章 落雪（兜底交付）")
        return "工作流已交付第一章正文"
      },
    })

    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        requiredToolsOnce: [WORKFLOW_TOOL],
        forceRequiredToolsImmediately: true,
        maxRounds: 4,
      }),
      [tool],
    )

    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(record.finalText).toBe("第一章 落雪（兜底交付）")
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])

    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(true)
    expect(diagnostics.fallbackStatus).toBe("success")
    expect(diagnostics.fallbackTool).toBe(WORKFLOW_TOOL)
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 断言 3：nudge 先、兜底后（DEC-R1=A）
//
// 旧顺序是「本轮零工具调用 → 立刻确定性兜底 → 兜底成功就 return」，模型那句散文只进
// workingMessages、从不 onText，用户看到的是静默代跑。新顺序要求：模型先看到 nudge、
// 有机会自己调工具；确实没有下一轮可用时，才轮到确定性兜底。
// ─────────────────────────────────────────────────────────────────────────────

describe("必调工具门控：nudge 先、兜底后", () => {
  it("第 1 轮零工具调用 → 先 nudge；第 2 轮模型自己调了必调工具 → 不再走确定性兜底，finalText 来自模型", async () => {
    const sentMessages = scriptStream([
      { text: "我先说明一下打算怎么写，但这一轮没调工作流。" },
      { toolCalls: [toolCallDelta(WORKFLOW_TOOL, { userRequest: "写第一章" }, "call_wf_self")] },
      { text: "第一章 落雪\n\n模型在拿到工作流结果后自己写出的正文。" },
    ])

    // 兜底入口是「可用」的（buildRequiredToolFallbackParams 存在），所以「没有走兜底」
    // 不是因为没有兜底可走，而是因为模型自己补上了工具调用。
    const tool = createWorkflowTool({
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute() {
        return "章节工作流已完成：大纲 + 场景表 + 文风约束"
      },
    })

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 4 }),
      [tool],
    )

    // 三轮：第 1 轮被 nudge、第 2 轮模型调工具、第 3 轮模型出终稿
    expect(mocks.streamChat).toHaveBeenCalledTimes(3)
    expect(record.roundsUsed).toBe(3)
    // 第 1 轮之后注入过 nudge（说明「先 nudge」这一步真的发生了）
    expect(nudgeInjected(sentMessages[1])).toBe(true)

    // 终稿来自模型，而不是兜底
    expect(record.finalText).toBe("第一章 落雪\n\n模型在拿到工作流结果后自己写出的正文。")
    expect(texts).toEqual([record.finalText])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])

    // 唯一那次工具调用是模型发起的（id 原样来自 tool_call），没有 required_fallback: 前缀
    expect(record.toolCalls.map((call) => [call.name, call.status, call.id])).toEqual([
      [WORKFLOW_TOOL, "done", "call_wf_self"],
    ])
    expect(record.toolCalls.some((call) => call.id.startsWith("required_fallback:"))).toBe(false)

    // 诊断出口：兜底全程没有被尝试过
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(false)
    expect(diagnostics.fallbackStatus).toBeUndefined()
    expect(diagnostics.fallbackTool).toBeUndefined()
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
  })

  it("两轮都零工具调用 → nudge 用尽后，最后一轮仍执行确定性兜底并交付终稿", async () => {
    const sentMessages = scriptStream([
      { text: "第一轮：我打算直接给你正文" },
      { text: "第二轮：我还是直接给你正文" },
    ])

    const tool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute(_params, _signal, context) {
        context?.onFinalContent?.("第一章 落雪（确定性兜底交付）")
        return "工作流已交付第一章正文"
      },
    })

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 2 }),
      [tool],
    )

    // 轮数语义未变：nudge 只是 continue，仍然只用掉 maxRounds=2 轮，没有多跑
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
    expect(record.roundsUsed).toBe(2)
    // 第 1 轮之后确实注入过 nudge（nudge 先）
    expect(nudgeInjected(sentMessages[1])).toBe(true)

    // 兜底后（第 2 轮仍不调工具）仍然交付终稿：兜底路径完整保留
    expect(record.finalText).toBe("第一章 落雪（确定性兜底交付）")
    expect(texts).toEqual([])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])

    // 交付来自确定性兜底，而不是模型：id 是 required_fallback: 前缀
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      [WORKFLOW_TOOL, "done"],
    ])
    expect(record.toolCalls[0].id.startsWith("required_fallback:")).toBe(true)

    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(true)
    expect(diagnostics.fallbackTool).toBe(WORKFLOW_TOOL)
    expect(diagnostics.fallbackStatus).toBe("success")
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
    expect(diagnostics.roundsUsed).toBe(2)
  })

  // RVF-02 成本回归：nudge 没有预算时，「必调工具永不调用」的失败模式从「1 轮 + 兜底」
  // 放大成「maxRounds 轮完整生成 + 兜底」——每轮都是整章级正文（run_chapter_workflow
  // 的 executeTimeoutMs: 0，无轮内截止）。本条用例把上界钉死在 1 + REQUIRED_TOOL_NUDGE_MAX，
  // 而不是 maxRounds。
  it("maxRounds=8 且模型始终零工具调用 → nudge 预算封顶，只请求 1 + REQUIRED_TOOL_NUDGE_MAX 次模型，随后确定性兜底交付", async () => {
    const sentMessages = scriptStream([{ text: "我打算直接给你正文（每一轮都这么说）" }])

    const tool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute(_params, _signal, context) {
        context?.onFinalContent?.("第一章 落雪（预算用尽后的确定性兜底）")
        return "工作流已交付第一章正文"
      },
    })

    const { record, errors, texts, doneCount } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 8 }),
      [tool],
    )

    // 预算常量本身的取值被钉住（预算为 0 就退回「不 nudge」的旧 bug）
    expect(REQUIRED_TOOL_NUDGE_MAX).toBe(2)
    // 成本上界：8 轮 maxRounds 只用掉 1 + 2 = 3 次模型调用，而不是 8 次
    expect(mocks.streamChat).toHaveBeenCalledTimes(1 + REQUIRED_TOOL_NUDGE_MAX)
    expect(mocks.streamChat.mock.calls.length).toBeLessThan(8)
    expect(record.roundsUsed).toBe(1 + REQUIRED_TOOL_NUDGE_MAX)

    // 两次 nudge 真的注入了：第 2、3 次请求里都带 nudge（「先 nudge」没被删）
    expect(sentMessages).toHaveLength(1 + REQUIRED_TOOL_NUDGE_MAX)
    expect(nudgeInjected(sentMessages[1])).toBe(true)
    expect(nudgeInjected(sentMessages[2])).toBe(true)

    // 预算用尽仍无 toolCalls → 确定性兜底仍然存在，并且交付终稿
    expect(record.finalText).toBe("第一章 落雪（预算用尽后的确定性兜底）")
    expect(texts).toEqual([])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      [WORKFLOW_TOOL, "done"],
    ])
    expect(record.toolCalls[0].id.startsWith("required_fallback:")).toBe(true)

    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(true)
    expect(diagnostics.fallbackTool).toBe(WORKFLOW_TOOL)
    expect(diagnostics.fallbackStatus).toBe("success")
    expect(diagnostics.satisfiedTools).toEqual([WORKFLOW_TOOL])
    expect(diagnostics.missingTools).toEqual([])
    expect(diagnostics.roundsUsed).toBe(1 + REQUIRED_TOOL_NUDGE_MAX)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 覆盖率战役增补（W-覆盖 runner）：只增补、不改动上文任何用例。
// 目标：src/lib/agent/runner.ts 行覆盖 63.9%（104 行未覆盖）→ 下降 ≥90%。
// LLM 一律经 mocks.streamChat 脚本化，不真连；断点持久化/预算裁剪用模块 spy
// 隔离 Tauri/随机抛错，不碰生产代码。
// ─────────────────────────────────────────────────────────────────────────────

describe("runner 覆盖增补：错误类型与任务目标回退", () => {
  it("ModelDoesNotSupportToolsError 构造：中文名与中文消息", () => {
    const err = new ModelDoesNotSupportToolsError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ModelDoesNotSupportToolsError")
    expect(err.message).toContain("不支持工具调用")
  })

  it("无 taskGoal + 字符串 user 消息 → 任务契约取自消息文本", async () => {
    const sentMessages = scriptStream([{ text: "终稿A" }])
    const { record, errors, doneCount, texts } = await runAgent(
      createConfig([], { taskGoal: undefined }),
      [],
      [{ role: "user", content: "请写摘要" }],
    )
    expect(record.finalText).toBe("终稿A")
    expect(texts).toEqual(["终稿A"])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
    // 任务契约是首条 system，且目标取自 user 文本（messageContentText 字符串分支）
    expect(sentMessages[0][0].role).toBe("system")
    expect(String(sentMessages[0][0].content)).toContain("请写摘要")
  })

  it("无 taskGoal + 数组内容消息 → 只取 text 块拼接", async () => {
    const sentMessages = scriptStream([{ text: "ok" }])
    const { record, errors } = await runAgent(
      createConfig([], { taskGoal: undefined }),
      [],
      [
        {
          role: "user",
          content: [
            { type: "text", text: "第一章" },
            { type: "image", mediaType: "image/png", dataBase64: "xx" },
          ],
        } as AgentMessage,
      ],
    )
    expect(record.finalText).toBe("ok")
    expect(errors).toEqual([])
    expect(String(sentMessages[0][0].content)).toContain("第一章")
  })

  it("无 taskGoal 且无 user 消息 → 任务目标回退为未命名任务，契约追加到末尾", async () => {
    const sentMessages = scriptStream([{ text: "ok" }])
    const { record, errors } = await runAgent(
      createConfig([], { taskGoal: undefined }),
      [],
      [{ role: "system", content: "sys-only" }],
    )
    expect(record.finalText).toBe("ok")
    expect(errors).toEqual([])
    // 全部是 system → 契约追加到末尾
    expect(sentMessages[0]).toHaveLength(2)
    expect(sentMessages[0][1].role).toBe("system")
    expect(String(sentMessages[0][1].content)).toContain("未命名任务")
  })
})

describe("runner 覆盖增补：断点持久化", () => {
  it("projectPath 存在 → 保存/清理断点被调用，同工具重复调用去重", async () => {
    const tbMod = await import("./task-breakpoint")
    const saveSpy = vi.spyOn(tbMod, "saveTaskBreakpoint").mockResolvedValue(undefined)
    const clearSpy = vi.spyOn(tbMod, "clearTaskBreakpoint").mockResolvedValue(undefined)
    try {
      scriptStream([
        {
          toolCalls: [
            { index: 0, id: "c1", name: "read_chapter", arguments: JSON.stringify({ chapter: 1 }) },
            { index: 1, id: "c2", name: "read_chapter", arguments: JSON.stringify({ chapter: 1 }) },
          ],
        },
        { text: "终稿" },
      ])
      const readTool: Tool = {
        name: "read_chapter",
        description: "读取章节",
        category: "read",
        permission: "auto",
        parameters: { chapter: { type: "integer", description: "章节号" } },
        async execute() {
          return "ok"
        },
      }
      const { record, errors, doneCount } = await runAgent(
        createConfig([readTool], { projectPath: "/tmp/qmai-runner-cov-test", taskGoal: "t" }),
        [readTool],
      )
      expect(errors).toEqual([])
      expect(doneCount()).toBe(1)
      expect(record.finalText).toBe("终稿")
      expect(record.toolCalls).toHaveLength(2)
      // 初始持久化 + 两次工具进度保存
      expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      saveSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

describe("runner 覆盖增补：取消信号", () => {
  function baseCallbacks() {
    const errors: Error[] = []
    let done = 0
    const callbacks: AgentRunCallbacks = {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onToolError: () => {},
      onDone: () => {
        done += 1
      },
      onError: (error) => {
        errors.push(error)
      },
    }
    return { callbacks, errors, doneCount: () => done }
  }

  it("进入即已取消 → 直接 onError，不调模型", async () => {
    const controller = new AbortController()
    controller.abort()
    let streamCalls = 0
    mocks.streamChat.mockImplementation(async () => {
      streamCalls += 1
    })
    const recorder = baseCallbacks()
    const record = await new AgentRunner().run(
      createConfig([], { taskGoal: "t" }),
      createRegistry([]),
      [{ role: "user", content: "hi" }],
      recorder.callbacks,
      controller.signal,
    )
    expect(streamCalls).toBe(0)
    expect(record.roundsUsed).toBe(1)
    expect(record.toolCalls).toEqual([])
    expect(recorder.doneCount()).toBe(0)
    expect(recorder.errors).toHaveLength(1)
    expect(recorder.errors[0].message).toContain("操作已取消")
  })

  it("第 1 轮调工具、第 2 轮流式中取消 → 第 3 轮入口结算后 onError", async () => {
    const controller = new AbortController()
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onToolCallDelta?.({ index: 0, id: "c1", name: "read_chapter", arguments: JSON.stringify({ chapter: 1 }) })
      } else {
        controller.abort()
        cb.onToken?.("第二轮散文")
      }
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const readTool: Tool = {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "ok"
      },
    }
    const workflowTool = createWorkflowTool()
    const recorder = baseCallbacks()
    const record = await new AgentRunner().run(
      createConfig([readTool, workflowTool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 3, taskGoal: "t" }),
      createRegistry([readTool, workflowTool]),
      [{ role: "user", content: "hi" }],
      recorder.callbacks,
      controller.signal,
    )
    // 第 2 轮文本走 nudge 续轮，第 3 轮入口发现已取消
    expect(n).toBe(2)
    expect(record.roundsUsed).toBe(3)
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([["read_chapter", "done"]])
    expect(recorder.doneCount()).toBe(0)
    expect(recorder.errors).toHaveLength(1)
    expect(recorder.errors[0].message).toContain("操作已取消")
  })

  it("工具执行中取消 → 本轮末尾结算后 onError", async () => {
    const controller = new AbortController()
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      cb.onToolCallDelta?.({ index: 0, id: "c1", name: "read_chapter", arguments: JSON.stringify({ chapter: 1 }) })
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const readTool: Tool = {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        controller.abort()
        return "ok"
      },
    }
    const recorder = baseCallbacks()
    const record = await new AgentRunner().run(
      createConfig([readTool], { taskGoal: "t" }),
      createRegistry([readTool]),
      [{ role: "user", content: "hi" }],
      recorder.callbacks,
      controller.signal,
    )
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([["read_chapter", "done"]])
    expect(recorder.doneCount()).toBe(0)
    expect(recorder.errors).toHaveLength(1)
    expect(recorder.errors[0].message).toContain("操作已取消")
  })
})

describe("runner 覆盖增补：流式回调全量（推理/用量/记忆/思考/诊断）", () => {
  it("一轮内同时产出推理 token、用量、记忆决策、思考块与同 index 多 delta", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onReasoningToken?.("reason-1")
        cb.onUsage?.({ input: 100, output: 50, cachedInput: 10, cacheWriteInput: 5 })
        // 同 index 三连：建项（带名）→ 无名更新（空操作）→ 具名更新（回填）
        cb.onToolCallDelta?.({ index: 0, id: "c0", name: "read_chapter", arguments: JSON.stringify({ chapter: 1 }) })
        cb.onToolCallDelta?.({ index: 0 })
        cb.onToolCallDelta?.({ index: 0, name: "read_chapter" })
        // 新 index 无名：建项但无名（覆盖 push 无名分支）
        cb.onToolCallDelta?.({ index: 1, id: "c9" })
        // 思考块：正常 thinking、有数据 redacted、无数据 redacted、仅签名 thinking、孤儿文本
        cb.onThinkingDelta?.({ kind: "block_start", index: 2, block: { type: "thinking" } })
        cb.onThinkingDelta?.({ kind: "text", index: 2, text: "think-text" })
        cb.onThinkingDelta?.({ kind: "signature", index: 2, signature: "sig-abc" })
        cb.onThinkingDelta?.({ kind: "text", index: 5, text: "orphan" })
        cb.onThinkingDelta?.({ kind: "block_start", index: 3, block: { type: "redacted_thinking", data: "enc-1" } })
        cb.onThinkingDelta?.({ kind: "block_start", index: 4, block: { type: "redacted_thinking" } })
        cb.onThinkingDelta?.({ kind: "block_start", index: 6, block: { type: "thinking", signature: "sig-only" } })
        cb.onUserMemoryDecision?.({ memoryKey: "k1", action: "accept" })
      } else {
        cb.onReasoningToken?.("reason-2")
        cb.onUsage?.({ input: 10, output: 5 })
        // 第二次记忆决策应被忽略（只保留首次）
        cb.onUserMemoryDecision?.({ memoryKey: "k2", action: "reject" })
        cb.onToken?.("终稿正文")
      }
      cb.onFinishReason?.("stop")
      cb.onDone()
    })

    const readTool: Tool = {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "第一章正文…"
      },
    }
    const reasoningTokens: string[] = []
    const memoryDecisions: Array<{ memoryKey: string; action: "accept" | "reject" } | null> = []
    const errors: Error[] = []
    let done = 0
    const sentMessages: AgentMessage[][] = []
    const origImpl = mocks.streamChat.getMockImplementation()
    mocks.streamChat.mockImplementation(async (llm: unknown, messages: unknown, cb: StreamCallbacks) => {
      sentMessages.push(JSON.parse(JSON.stringify(messages)) as AgentMessage[][] as unknown as AgentMessage[])
      return origImpl?.(llm, messages, cb)
    })
    const record = await new AgentRunner().run(
      createConfig([readTool], { requiredToolsOnce: ["read_chapter"], taskGoal: "t" }),
      createRegistry([readTool]),
      [{ role: "user", content: "hi" }],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onToolError: () => {},
        onDone: () => {
          done += 1
        },
        onError: (error) => {
          errors.push(error)
        },
        onReasoningToken: (token) => {
          reasoningTokens.push(token)
        },
        onUserMemoryDecision: (decision) => {
          memoryDecisions.push(decision)
        },
      },
    )

    expect(errors).toEqual([])
    expect(done).toBe(1)
    expect(record.finalText).toBe("终稿正文")
    // 推理 token 全部透传
    expect(reasoningTokens).toEqual(["reason-1", "reason-2"])
    // 用量：末轮快照 + 全程累加
    expect(record.lastRequestUsage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(record.usage).toEqual({
      inputTokens: 110,
      outputTokens: 55,
      totalTokens: 165,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
    })
    // 记忆决策只保留首次
    expect(record.userMemoryDecision).toEqual({ memoryKey: "k1", action: "accept" })
    expect(memoryDecisions).toEqual([{ memoryKey: "k1", action: "accept" }])
    // 诊断：同 index 更新回填名、新 index 无名建项
    expect(diagnosticsOf(record).observedToolCalls).toEqual([
      { round: 1, index: 0, name: "read_chapter" },
      { round: 1, index: 1 },
    ])
    expect(diagnosticsOf(record).satisfiedTools).toEqual(["read_chapter"])
    // 工具记录：具名调用成功、空名调用报未知工具
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      ["read_chapter", "done"],
      ["", "error"],
    ])
    // 思考块回放：空洞跳过、无签名 thinking 丢弃、无数据 redacted 丢弃
    const assistantWithTools = sentMessages[1].find(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    )
    expect(assistantWithTools?.thinking_blocks).toEqual([
      { type: "thinking", thinking: "think-text", signature: "sig-abc" },
      { type: "redacted_thinking", data: "enc-1" },
      { type: "thinking", thinking: "", signature: "sig-only" },
    ])
  })
})

describe("runner 覆盖增补：工具不支持降级与重试", () => {
  function readTool(): Tool {
    return {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "ok"
      },
    }
  }

  function baseRun(configTools: Tool[], overrides: Partial<AgentConfig> = {}) {
    const errors: Error[] = []
    const texts: string[] = []
    let done = 0
    const run = () =>
      new AgentRunner().run(
        createConfig(configTools, { taskGoal: "t", ...overrides }),
        createRegistry(configTools),
        [{ role: "user", content: "hi" }],
        {
          onText: (chunk) => {
            texts.push(chunk)
          },
          onToolCall: () => {},
          onToolResult: () => {},
          onToolError: () => {},
          onDone: () => {
            done += 1
          },
          onError: (error) => {
            errors.push(error)
          },
        },
      )
    return { run, errors, texts, doneCount: () => done }
  }

  it("首轮抛工具不支持错误 → 去工具重试成功，终稿落盘", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) throw new Error("This model does not support function calls")
      cb.onToken?.("ok")
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const { run, errors, texts, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.roundsUsed).toBe(1)
    expect(record.finalText).toBe("ok")
    expect(texts).toEqual(["ok"])
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
  })

  it("首轮抛工具不支持、重试再抛 → ModelDoesNotSupportToolsError", async () => {
    mocks.streamChat.mockImplementation(async () => {
      throw new Error("tools are not supported by this model")
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ModelDoesNotSupportToolsError)
  })

  it("首轮抛非工具错误 → 直接 onError，不重试", async () => {
    mocks.streamChat.mockImplementation(async () => {
      throw new Error("socket hang up")
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("socket hang up")
  })

  it("首轮 onError 上报工具不支持 → 去工具重试成功", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onError?.(new Error("tool_choice is not supported"))
        cb.onDone()
        return
      }
      cb.onToken?.("recovered")
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.finalText).toBe("recovered")
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
  })

  it("首轮 onError 上报工具不支持、重试抛错 → ModelDoesNotSupportToolsError", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onError?.(new Error("不支持工具调用"))
        cb.onDone()
        return
      }
      throw new Error("retry-down")
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ModelDoesNotSupportToolsError)
  })

  it("去工具重试后流式再报错 → 直接报模型不支持工具", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) throw new Error("function call is not supported")
      cb.onError?.(new Error("downstream-boom"))
      cb.onDone()
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ModelDoesNotSupportToolsError)
  })

  it("推理独占错误且推理未禁用 → 关推理重试成功", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onError?.(new Error("模型只输出了 500 字符的思考内容，但没有输出正文"))
        cb.onDone()
        return
      }
      cb.onToken?.("正文")
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.finalText).toBe("正文")
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
  })

  it("推理独占错误但重试抛错 → 转发重试错误", async () => {
    let n = 0
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onError?.(new Error("模型只输出了 300 字符的思考内容，但没有输出正文"))
        cb.onDone()
        return
      }
      throw new Error("retry-boom")
    })
    const { run, errors, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(n).toBe(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("retry-boom")
  })

  it("推理独占错误但推理已禁用 → 不重试，直接透传原错", async () => {
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      cb.onError?.(new Error("模型只输出了 300 字符的思考内容，但没有输出正文"))
      cb.onDone()
    })
    const { run, errors, doneCount } = baseRun([readTool()], {
      llmConfig: { ...llmConfig, reasoning: { mode: "off" } },
    })
    const record = await run()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("没有输出正文")
  })

  it("输出截断且有部分正文 → 保留部分正文再报错", async () => {
    mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      cb.onToken?.("half-")
      cb.onError?.(new Error("Response truncated at max_tokens"))
      cb.onDone()
    })
    const { run, errors, texts, doneCount } = baseRun([readTool()])
    const record = await run()
    expect(record.finalText).toBe("half-")
    expect(texts).toEqual(["half-"])
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/truncated/i)
  })

  it("预算裁剪抛错 → 透出可读的上下文不足错误", async () => {
    const budgetMod = await import("../chat-request-budget")
    const trimSpy = vi.spyOn(budgetMod, "trimChatMessagesToTokenBudget").mockImplementationOnce(() => {
      throw new Error("boom-budget")
    })
    try {
      mocks.streamChat.mockImplementation(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
        cb.onToken?.("hi")
        cb.onDone()
      })
      const { run, errors, doneCount } = baseRun([readTool()])
      const record = await run()
      expect(mocks.streamChat).not.toHaveBeenCalled()
      expect(record.finalText).toBe("")
      expect(doneCount()).toBe(0)
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain("模型上下文不足")
    } finally {
      trimSpy.mockRestore()
    }
  })
})

describe("runner 覆盖增补：文本工具调用与参数校验", () => {
  function readTool(): Tool {
    return {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "第一章正文…"
      },
    }
  }

  it("cursor-cli 文本桥接：正文内 JSON 工具调用被解析执行", async () => {
    const sentMessages = scriptStream([
      { text: `前言 {"name":"read_chapter","arguments":{"chapter":2}} 后记` },
      { text: "收尾" },
    ])
    void sentMessages
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        taskGoal: "t",
        llmConfig: { ...llmConfig, provider: "cursor-cli" },
      }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("收尾")
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([["read_chapter", "done"]])
    expect(record.roundsUsed).toBe(2)
  })

  it("cursor-cli 下纯散文无 JSON → 直接按终稿接受", async () => {
    scriptStream([{ text: "纯散文，无工具" }])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        taskGoal: "t",
        llmConfig: { ...llmConfig, provider: "cursor-cli" },
      }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("纯散文，无工具")
    expect(record.toolCalls).toEqual([])
  })

  it("工具参数是 JSON 但非对象 → 拒绝执行并记录错误", async () => {
    scriptStream([
      { toolCalls: [{ index: 0, id: "e1", name: "read_chapter", arguments: '"just-a-string"' }] },
      { text: "done15a" },
    ])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], { taskGoal: "t" }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("done15a")
    expect(record.toolCalls).toHaveLength(1)
    expect(record.toolCalls[0].status).toBe("error")
    expect(record.toolCalls[0].result).toContain("必须是 JSON 对象")
  })

  it("工具参数不是合法 JSON → 拒绝执行并记录错误", async () => {
    scriptStream([
      { toolCalls: [{ index: 0, id: "e2", name: "read_chapter", arguments: '{"chapter":' }] },
      { text: "done15b" },
    ])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], { taskGoal: "t" }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("done15b")
    expect(record.toolCalls).toHaveLength(1)
    expect(record.toolCalls[0].status).toBe("error")
    expect(record.toolCalls[0].result).toContain("不是合法 JSON")
  })

  it("工具调用无参数 → 默认空对象并正常执行", async () => {
    scriptStream([
      { toolCalls: [{ index: 0, id: "e3", name: "read_chapter" }] },
      { text: "done15c" },
    ])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], { taskGoal: "t" }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("done15c")
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([["read_chapter", "done"]])
    expect(record.toolCalls[0].params).toEqual({})
  })
})

describe("runner 覆盖增补：轮次耗尽与兜底收敛", () => {
  function readTool(name = "read_chapter"): Tool {
    return {
      name,
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "第一章正文…"
      },
    }
  }

  it("无必调工具、每轮都调普通工具 → 耗尽后报最大轮次", async () => {
    scriptStream([
      { toolCalls: [toolCallDelta("read_chapter", { chapter: 1 }, "call_r1")] },
      { toolCalls: [toolCallDelta("read_chapter", { chapter: 2 }, "call_r2")] },
    ])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], { maxRounds: 2, taskGoal: "t" }),
      [tool],
    )
    expect(record.roundsUsed).toBe(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("最大调用轮次")
    expect(record.toolCalls.map((call) => call.status)).toEqual(["done", "done"])
  })

  it("轮次耗尽时兜底成功 → 直接返回终稿（:680 成功分支）", async () => {
    scriptStream([
      { toolCalls: [toolCallDelta("read_other", { chapter: 1 }, "call_other")] },
    ])
    const workflowTool = createWorkflowTool({
      finalizesRun: true,
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute(_params, _signal, context) {
        context?.onFinalContent?.("兜底终稿（轮次耗尽）")
        return "工作流已交付"
      },
    })
    const otherTool = readTool("read_other")
    const { record, errors, doneCount } = await runAgent(
      createConfig([workflowTool, otherTool], {
        requiredToolsOnce: [WORKFLOW_TOOL],
        maxRounds: 1,
        taskGoal: "t",
      }),
      [workflowTool, otherTool],
    )
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(record.finalText).toBe("兜底终稿（轮次耗尽）")
    expect(doneCount()).toBe(1)
    expect(errors).toEqual([])
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackStatus).toBe("success")
    expect(diagnostics.satisfiedTools).toEqual(["read_other", WORKFLOW_TOOL])
  })

  it("force 且必调工具不在注册表 → 缺失为空，兜底直接成功且不调模型", async () => {
    scriptStream([{ text: "不该被请求到" }])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        requiredToolsOnce: ["ghost_tool"],
        forceRequiredToolsImmediately: true,
        maxRounds: 2,
        taskGoal: "t",
      }),
      [tool],
    )
    expect(mocks.streamChat).not.toHaveBeenCalled()
    expect(record.toolCalls).toEqual([])
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toEqual([])
    // 门控按可用性判定无需兜底（缺失为空），但诊断仍如实列出未满足的必调工具
    expect(diagnosticsOf(record).missingTools).toEqual(["ghost_tool"])
  })

  it("force 时兜底不可用 → 主循环内第二次兜底命中收敛标记", async () => {
    const sentMessages = scriptStream([
      { text: "第一轮散文" },
      { text: "第二轮散文" },
    ])
    void sentMessages
    const tool = createWorkflowTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        requiredToolsOnce: [WORKFLOW_TOOL],
        forceRequiredToolsImmediately: true,
        maxRounds: 2,
        taskGoal: "t",
      }),
      [tool],
    )
    // force 那次 + 第 2 轮末轮那次（第二次命中 fallbackConvergenceChecked）
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
    expect(record.finalText).toBe("")
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
  })

  it("末轮非终结型兜底成功但无终稿 → 仍视为不可用并拒稿（fallback 成功无终稿时 attempted:false）", async () => {
    scriptStream([{ text: "散文" }])
    const tool = createWorkflowTool({
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute() {
        return "工作流完成（非终结）"
      },
    })
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        requiredToolsOnce: [WORKFLOW_TOOL],
        maxRounds: 1,
        taskGoal: "t",
      }),
      [tool],
    )
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    // 兜底执行成功但无终稿交付：fallback 返回 attempted:false，runner 判为不可用
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([[WORKFLOW_TOOL, "done"]])
    const diagnostics = diagnosticsOf(record)
    expect(diagnostics.fallbackAttempted).toBe(false)
    expect(diagnostics.fallbackStatus).toBe("unavailable")
    expect(diagnostics.satisfiedTools).toEqual([])
  })

  it("末轮兜底部分成功仍有缺失 → 返回不可用并拒稿", async () => {
    scriptStream([{ text: "散文" }])
    const w1 = createWorkflowTool({ name: "w1" })
    const w2 = createWorkflowTool({
      name: "w2",
      buildRequiredToolFallbackParams: ({ taskGoal }) => ({ userRequest: taskGoal }),
      async execute() {
        return "w2 完成（非终结）"
      },
    })
    const { record, errors, doneCount } = await runAgent(
      createConfig([w1, w2], {
        requiredToolsOnce: ["w1", "w2"],
        maxRounds: 1,
        taskGoal: "t",
      }),
      [w1, w2],
    )
    expect(doneCount()).toBe(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
    // 拒稿携带的是兜底前快照（w1、w2 均缺）；诊断在兜底后刷新，只剩 w1
    expect((errors[0] as RequiredToolsNotCalledError).missingTools).toEqual(["w1", "w2"])
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([["w2", "done"]])
    expect(diagnosticsOf(record).fallbackStatus).toBe("unavailable")
    // attempted:false 时兜底带回的 satisfied 被丢弃，诊断保持兜底前快照
    expect(diagnosticsOf(record).satisfiedTools).toEqual([])
    expect(diagnosticsOf(record).missingTools).toEqual(["w1", "w2"])
  })
})

describe("runner 覆盖增补：工具通道关闭与 nudge 形态", () => {
  function readTool(): Tool {
    return {
      name: "read_chapter",
      description: "读取章节",
      category: "read",
      permission: "auto",
      parameters: { chapter: { type: "integer", description: "章节号" } },
      async execute() {
        return "第一章正文…"
      },
    }
  }

  it("函数调用开关关闭 → 无工具请求体，散文直接按终稿接受", async () => {
    const sentMessages = scriptStream([{ text: "plain-final" }])
    const tool = readTool()
    const { record, errors, doneCount, texts } = await runAgent(
      createConfig([tool], {
        taskGoal: "t",
        llmConfig: { ...llmConfig, functionCallingEnabled: false } as LlmConfig,
      }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("plain-final")
    expect(texts).toEqual(["plain-final"])
    // 未带 tools/tool_choice 的请求体
    const firstRequest = (mocks.streamChat.mock.calls[0][4] ?? {}) as Record<string, unknown>
    expect(firstRequest).not.toHaveProperty("tools")
    expect(firstRequest).not.toHaveProperty("toolChoice")
    void sentMessages
  })

  it("工具开关关闭时必调门控不拦截 → 缺失工具也不报错", async () => {
    scriptStream([{ text: "plain-final" }])
    const tool = readTool()
    const { record, errors, doneCount } = await runAgent(
      createConfig([tool], {
        taskGoal: "t",
        requiredToolsOnce: ["read_chapter"],
        llmConfig: { ...llmConfig, functionCallingEnabled: false } as LlmConfig,
      }),
      [tool],
    )
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("plain-final")
    // 门控按 toolsEnabled=false 放行，但诊断仍如实列出未满足项
    expect(diagnosticsOf(record).missingTools).toEqual(["read_chapter"])
  })

  it("空工具列表 → 终稿直接接受", async () => {
    scriptStream([{ text: "t-final" }])
    const { record, errors, doneCount } = await runAgent(createConfig([], { taskGoal: "t" }), [])
    expect(errors).toEqual([])
    expect(doneCount()).toBe(1)
    expect(record.finalText).toBe("t-final")
  })

  it("nudge 时携带推理与思考块 → assistant 回放保留两者", async () => {
    const sentMessages = scriptStream([
      { text: "散文R1" },
      { text: "散文R2" },
    ])
    // 首轮额外注入推理 token 与思考块（scriptStream 只产文本，这里叠加第二层实现）
    const prevImpl = mocks.streamChat.getMockImplementation()
    let n = 0
    mocks.streamChat.mockImplementation(async (llm: unknown, messages: unknown, cb: StreamCallbacks) => {
      n += 1
      if (n === 1) {
        cb.onReasoningToken?.("r1")
        cb.onThinkingDelta?.({ kind: "block_start", index: 0, block: { type: "thinking" } })
        cb.onThinkingDelta?.({ kind: "text", index: 0, text: "nt" })
        cb.onThinkingDelta?.({ kind: "signature", index: 0, signature: "ns" })
      }
      return prevImpl?.(llm, messages, cb)
    })
    const tool = createWorkflowTool()
    const { record, errors } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 2, taskGoal: "t" }),
      [tool],
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
    expect(record.finalText).toBe("")
    const assistants = sentMessages[1].filter((message) => message.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0].reasoning_content).toBe("r1")
    expect(assistants[0].thinking_blocks).toEqual([{ type: "thinking", thinking: "nt", signature: "ns" }])
    expect(
      sentMessages[1].some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes(NUDGE_MARKER),
      ),
    ).toBe(true)
  })

  it("尾部 system 内容非字符串 → nudge 另起一条而非合并", async () => {
    const sentMessages = scriptStream([{ text: "散文2" }])
    // 首轮空输出：只 onDone，不产生 assistant，尾部保持初始的数组 system
    mocks.streamChat.mockImplementationOnce(async (_llm: unknown, _messages: unknown, cb: StreamCallbacks) => {
      cb.onFinishReason?.("stop")
      cb.onDone()
    })
    const tool = createWorkflowTool()
    const { errors } = await runAgent(
      createConfig([tool], { requiredToolsOnce: [WORKFLOW_TOOL], maxRounds: 2, taskGoal: "t" }),
      [tool],
      [
        { role: "user", content: "u" },
        { role: "system", content: [{ type: "text", text: "sys-array" }] } as AgentMessage,
      ],
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RequiredToolsNotCalledError)
    // 首轮 Once 实现不经过 scriptStream 的快照，只有第 2 轮请求被记录
    const systems = sentMessages[0].filter((message) => message.role === "system")
    expect(systems).toHaveLength(3)
    // 首条是任务契约（字符串），中间是原数组 system（保持数组），末条是 nudge
    expect(Array.isArray(systems[1].content)).toBe(true)
    expect(String(systems[2].content)).toContain(NUDGE_MARKER)
  })
})
