/**
 * story-framework-generator 行为测试（原 C4 空壳已删除，此文件为真实专项测试）。
 *
 * 覆盖 generateStoryFramework 全管线：
 * - streamChat 多 token 累积 / onError / promise 拒绝三种传输结局
 * - JSON 解析三路：裸 JSON / ```json 代码块 / 杂文字包裹最外层 {}
 * - 空框架双回退（不可解析 / 无节点）与字段透传
 * - 节点归一化：截断、phase 推导、缺省值、involvedCharacters 数组与字符串两种形态
 * - 标题策略：userIdea 优先、premise 回退、shortTitle 显式值优先
 * - 提示词构建：角色/章节/世界规则/力量体系/伏笔/时间线/灵魂文档各分支
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import { generateStoryFramework } from "./story-framework-generator"
import type { ForeshadowingStore } from "@/lib/novel/foreshadowing-tracker"
import type { ExtractionResult } from "./types"

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
}))

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: mocks.streamChat,
  }
})

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 4096,
}

type Cb = Pick<StreamCallbacks, "onToken" | "onDone" | "onError">

/** 让 mock 的 streamChat 按多块 token 顺序回放后正常结束。 */
function replyOnce(full: string, chunkSize = 7): void {
  mocks.streamChat.mockImplementationOnce(
    (_config: unknown, _messages: unknown, cb: Cb) => {
      for (let i = 0; i < full.length; i += chunkSize) {
        cb.onToken(full.slice(i, i + chunkSize))
      }
      cb.onDone()
      return Promise.resolve()
    },
  )
}

/** 让 mock 的 streamChat 走 onError 回调（传输中失败）。 */
function failStreamOnce(err: Error): void {
  mocks.streamChat.mockImplementationOnce(
    (_config: unknown, _messages: unknown, cb: Cb) => {
      cb.onError(err)
      return Promise.resolve()
    },
  )
}

function baseExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    characters: [],
    chapterContents: [],
    memoryData: {
      characterStates: "",
      characterCognition: null,
      foreshadowingTracker: null,
      timeline: [],
      canonFacts: "",
      conflicts: "",
    },
    worldRules: "",
    powerSystem: "",
    foreshadowing: null,
    timeline: [],
    outlineContent: "",
    soulDoc: "",
    ...overrides,
  }
}

const PHASES = ["起", "承", "转", "合"] as const

function payload(
  nodeCount: number,
  premise = "少年仗剑走天涯，为师门复仇",
  shortTitle: unknown = "剑啸江湖",
): string {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    phase: PHASES[i % PHASES.length],
    title: `节点${i + 1}`,
    coreConflict: `冲突${i + 1}`,
    involvedCharacters: [`角色${i + 1}`],
    goal: `目标${i + 1}`,
    causeFromPrev: i === 0 ? "故事开端" : `承接${i}`,
    expectedOutcome: `结局${i + 1}`,
  }))
  return JSON.stringify({ premise, shortTitle, nodes })
}

function sentMessages(): ChatMessage[] {
  const calls = mocks.streamChat.mock.calls as unknown[][]
  return calls[0][1] as ChatMessage[]
}

beforeEach(() => {
  mocks.streamChat.mockReset()
})

describe("generateStoryFramework 成功路径", () => {
  it("裸 JSON：多 token 累积解析，字段透传且上报 4 次进度", async () => {
    replyOnce(payload(4), 5)
    const progress: string[] = []
    const fw = await generateStoryFramework({
      extraction: baseExtraction({
        chapterContents: [
          { chapterNumber: 1, title: "雪夜", summary: "入门", content: "正文" },
          { chapterNumber: 2, title: "风起", summary: "试炼", content: "正文" },
        ],
      }),
      mode: "event-driven",
      targetWords: 5000,
      userIdea: "复仇爽文",
      llmConfig,
      onProgress: (label) => progress.push(label),
    })

    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(fw.nodes).toHaveLength(4)
    expect(fw.nodes.map((n) => n.phase)).toEqual(["起", "承", "转", "合"])
    expect(fw.nodes[0].title).toBe("节点1")
    expect(fw.nodes[0].causeFromPrev).toBe("故事开端")
    expect(fw.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3])
    expect(fw.premise).toBe("少年仗剑走天涯，为师门复仇")
    expect(fw.shortTitle).toBe("剑啸江湖")
    expect(fw.title).toBe("复仇爽文")
    expect(fw.targetWords).toBe(5000)
    expect(fw.simulationMode).toBe("event-driven")
    expect(fw.userIdea).toBe("复仇爽文")
    expect(fw.sourceChapters).toBe(2)
    expect(fw.id.startsWith("framework-")).toBe(true)
    expect(Number.isNaN(Date.parse(fw.createdAt))).toBe(false)
    expect(progress).toEqual([
      "正在构建提示词...",
      "正在调用模型生成故事框架...",
      "正在解析框架...",
      "故事框架生成完成",
    ])
  })

  it("```json 代码块包裹：能提取并解析", async () => {
    replyOnce("```json\n" + payload(4) + "\n```")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(4)
    expect(fw.premise).toBe("少年仗剑走天涯，为师门复仇")
  })

  it("杂文字包裹：截取最外层 { } 后解析", async () => {
    replyOnce("以下是生成的故事框架，请查收：\n" + payload(4) + "\n以上是全部内容。")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "free-emergence",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(4)
  })

  it("无 onProgress 也能正常完成", async () => {
    replyOnce(payload(4))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "decision-tree",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(4)
  })

  it("节点数少于目标时不补齐空节点", async () => {
    replyOnce(payload(2))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000, // nodeCount = 4
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(2)
  })

  it("节点数超过目标时截断到目标数", async () => {
    replyOnce(payload(8))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000, // nodeCount = 4
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(4)
    expect(fw.nodes[3].title).toBe("节点4")
  })

  it("targetWords 20000 对应 6 节点目标", async () => {
    replyOnce(payload(8))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 20000, // nodeCount = 6
      llmConfig,
    })
    expect(fw.nodes).toHaveLength(6)
  })
})

describe("generateStoryFramework 空框架回退", () => {
  const EMPTY_TITLE = "故事框架（生成失败，已回退为空框架）"

  it("空响应：回退并携带原因一", async () => {
    replyOnce("   \n  ")
    const fw = await generateStoryFramework({
      extraction: baseExtraction({
        chapterContents: [
          { chapterNumber: 1, title: "a", summary: "s", content: "c" },
          { chapterNumber: 2, title: "b", summary: "s", content: "c" },
          { chapterNumber: 3, title: "c", summary: "s", content: "c" },
        ],
      }),
      mode: "hybrid",
      targetWords: 30000,
      userIdea: "复仇",
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
    expect(fw.title).toBe(EMPTY_TITLE)
    expect(fw.shortTitle).toBe("生成失败")
    expect(fw.sourceChapters).toBe(3)
    expect(fw.targetWords).toBe(30000)
    expect(fw.userIdea).toBe("复仇")
  })

  it("乱文本（无花括号）：同样走原因一回退", async () => {
    replyOnce("抱歉我今天状态不好")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
  })

  it("JSON 标量（可解析但非对象）：走原因一回退", async () => {
    replyOnce("42")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
  })

  it("左花括号无配对：截取分支短路后走原因一回退", async () => {
    replyOnce("前言 { 不是 JSON")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
  })

  it("最外层截取仍非 JSON：截取解析失败后走原因一回退", async () => {
    replyOnce("结果：{ 不是合法 json }完毕")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
  })

  it("右花括号在左花括号之前：截取分支短路后走原因一回退", async () => {
    replyOnce("} {")
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型未返回可解析的框架内容，请重试或更换模型。")
  })

  it("nodes 缺失：回退并携带原因二", async () => {
    replyOnce(JSON.stringify({ premise: "只有前提", shortTitle: "无题" }))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型返回的框架不包含任何节点，请重试或调整目标字数。")
  })

  it("nodes 非数组：回退并携带原因二", async () => {
    replyOnce(JSON.stringify({ premise: "p", shortTitle: "s", nodes: { a: 1 } }))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes).toEqual([])
    expect(fw.premise).toBe("模型返回的框架不包含任何节点，请重试或调整目标字数。")
  })
})

describe("generateStoryFramework 传输失败", () => {
  it("onError 回调：错误向调用方抛出", async () => {
    failStreamOnce(new Error("LLM挂了"))
    await expect(
      generateStoryFramework({
        extraction: baseExtraction(),
        mode: "hybrid",
        targetWords: 5000,
        llmConfig,
      }),
    ).rejects.toThrow("LLM挂了")
  })

  it("streamChat promise 拒绝（Error）：原样抛出", async () => {
    mocks.streamChat.mockRejectedValueOnce(new Error("网络中断"))
    await expect(
      generateStoryFramework({
        extraction: baseExtraction(),
        mode: "hybrid",
        targetWords: 5000,
        llmConfig,
      }),
    ).rejects.toThrow("网络中断")
  })

  it("streamChat promise 拒绝（非 Error）：包装为 Error 抛出", async () => {
    mocks.streamChat.mockRejectedValueOnce("boom-string")
    await expect(
      generateStoryFramework({
        extraction: baseExtraction(),
        mode: "hybrid",
        targetWords: 5000,
        llmConfig,
      }),
    ).rejects.toThrow("boom-string")
  })
})

describe("节点归一化", () => {
  it("非法 phase 按位置比例推导起承转合", async () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      phase: "无效阶段",
      title: `n${i}`,
      coreConflict: "c",
      involvedCharacters: [],
      goal: "g",
      causeFromPrev: "x",
      expectedOutcome: "o",
    }))
    replyOnce(JSON.stringify({ premise: "p", shortTitle: "s", nodes }))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 50000, // nodeCount = 8
      llmConfig,
    })
    expect(fw.nodes.map((n) => n.phase)).toEqual([
      "起", "起", "承", "承", "转", "转", "合", "合",
    ])
  })

  it("缺失 phase 同样按位置推导", async () => {
    const nodes = Array.from({ length: 4 }, (_, i) => ({ title: `n${i}` }))
    replyOnce(JSON.stringify({ premise: "p", shortTitle: "s", nodes }))
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes.map((n) => n.phase)).toEqual(["起", "承", "转", "合"])
  })

  it("缺失字段填充默认值：首节点 causeFromPrev 为故事开端，其余为空", async () => {
    replyOnce(
      JSON.stringify({ premise: "p", shortTitle: "s", nodes: [{}, { title: "尾声" }] }),
    )
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes[0].title).toBe("节点 1")
    expect(fw.nodes[0].coreConflict).toBe("")
    expect(fw.nodes[0].goal).toBe("")
    expect(fw.nodes[0].expectedOutcome).toBe("")
    expect(fw.nodes[0].involvedCharacters).toEqual([])
    expect(fw.nodes[0].causeFromPrev).toBe("故事开端")
    expect(fw.nodes[1].title).toBe("尾声")
    expect(fw.nodes[1].causeFromPrev).toBe("")
  })

  it("involvedCharacters 数组：转字符串并过滤空白", async () => {
    replyOnce(
      JSON.stringify({
        premise: "p",
        shortTitle: "s",
        nodes: [
          {
            phase: "起",
            title: "t",
            coreConflict: "c",
            involvedCharacters: ["张三", "", "  ", 42],
            goal: "g",
            causeFromPrev: "故事开端",
            expectedOutcome: "o",
          },
        ],
      }),
    )
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes[0].involvedCharacters).toEqual(["张三", "42"])
  })

  it("involvedCharacters 字符串：按常见分隔符切分", async () => {
    replyOnce(
      JSON.stringify({
        premise: "p",
        shortTitle: "s",
        nodes: [
          {
            phase: "起",
            title: "t",
            coreConflict: "c",
            involvedCharacters: "张三，李四、王五;赵六；钱七\n孙八",
            goal: "g",
            causeFromPrev: "故事开端",
            expectedOutcome: "o",
          },
        ],
      }),
    )
    const fw = await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    expect(fw.nodes[0].involvedCharacters).toEqual([
      "张三", "李四", "王五", "赵六", "钱七", "孙八",
    ])
  })
})

describe("标题策略", () => {
  async function genWithResult(result: unknown, opts?: { userIdea?: string }): Promise<ReturnType<typeof generateStoryFramework>> {
    replyOnce(JSON.stringify(result))
    return generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      ...(opts?.userIdea !== undefined ? { userIdea: opts.userIdea } : {}),
      llmConfig,
    })
  }

  it("显式 shortTitle：去空白并截断到 10 字", async () => {
    const fw = await genWithResult({ premise: "p", shortTitle: "  指认风波疑云重重难辨真假  ", nodes: [{ title: "t" }] })
    expect(fw.shortTitle).toBe("指认风波疑云重重难辨真假".slice(0, 10))
  })

  it("shortTitle 为空白：回退到 userIdea 前 8 字", async () => {
    const fw = await genWithResult(
      { premise: "少年复仇记", shortTitle: "   ", nodes: [{ title: "t" }] },
      { userIdea: "复仇爽文之怒火重燃" },
    )
    expect(fw.shortTitle).toBe("复仇爽文之怒火重燃".slice(0, 8))
  })

  it("shortTitle 缺失且无 userIdea：回退到 premise 前 8 字", async () => {
    const fw = await genWithResult({ premise: "少年仗剑走天涯复仇", nodes: [{ title: "t" }] })
    expect(fw.shortTitle).toBe("少年仗剑走天涯复仇".slice(0, 8))
  })

  it("premise 与 userIdea 都缺失：shortTitle 为故事框架", async () => {
    const fw = await genWithResult({ nodes: [{ title: "t" }] })
    expect(fw.shortTitle).toBe("故事框架")
  })

  it("超长 userIdea：title 截断到 30 字并加省略号", async () => {
    const idea = "这是一个非常非常长的用户思路需要被截断到三十个字符以内才行啊啊啊"
    expect(idea.length).toBeGreaterThan(30)
    const fw = await genWithResult(
      { premise: "p", shortTitle: "s", nodes: [{ title: "t" }] },
      { userIdea: idea },
    )
    expect(fw.title).toBe(`${idea.slice(0, 30)}…`)
  })

  it("无 userIdea 时 title 取 premise；premise 为空时取故事框架", async () => {
    const fromPremise = await genWithResult({ premise: "短前提", shortTitle: "s", nodes: [{ title: "t" }] })
    expect(fromPremise.title).toBe("短前提")
    const fallback = await genWithResult({ premise: "   ", shortTitle: "s", nodes: [{ title: "t" }] })
    expect(fallback.title).toBe("故事框架")
  })
})

describe("提示词构建", () => {
  it("system 消息要求起承转合四段 JSON，user 消息携带任务参数", async () => {
    replyOnce(payload(4))
    await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "event-driven",
      targetWords: 5000,
      userIdea: "复仇爽文",
      llmConfig,
    })
    const [system, user] = sentMessages()
    expect(system.role).toBe("system")
    expect(system.content).toContain("起")
    expect(system.content).toContain("承")
    expect(system.content).toContain("转")
    expect(system.content).toContain("合")
    expect(system.content).toContain("JSON")
    expect(user.role).toBe("user")
    expect(user.content).toContain("目标字数：5000")
    expect(user.content).toContain("需要生成的节点数量：4")
    expect(user.content).toContain("仿真模式：event-driven")
    expect(user.content).toContain("用户思路：复仇爽文")
    expect(user.content).toContain("生成 4 个节点的故事框架")
  })

  it("空提取结果：各分区显示暂无/未提取占位", async () => {
    replyOnce(payload(4))
    await generateStoryFramework({
      extraction: baseExtraction(),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    const [, user] = sentMessages()
    expect(user.content).toContain("暂无已提取角色")
    expect(user.content).toContain("暂无已写章节")
    expect(user.content).toContain("未提取到世界规则")
    expect(user.content).toContain("未提取到力量体系")
    expect(user.content).toContain("暂无伏笔记录")
    expect(user.content).toContain("暂无时间线事件")
    expect(user.content).toContain("未提取到灵魂文档")
    expect(user.content).not.toContain("用户思路")
  })

  it("完整提取结果：角色全字段/章节摘要与正文回退/各设定分区齐备", async () => {
    replyOnce(payload(4))
    await generateStoryFramework({
      extraction: baseExtraction({
        characters: [
          {
            id: "c1",
            name: "张三",
            profile: `前朝太子${"x".repeat(3000)}`,
            aura: {
              id: "aura-1",
              builtIn: true,
              name: "金色帝王光环",
              sourceNote: "内置",
              corpus: "",
              styleDescription: "",
              behaviorRules: "",
              boundaries: "",
              notes: "",
            },
            cognition: { knows: ["秘密A"], doesNotKnow: ["秘密B"] },
            soul: `隐忍${"y".repeat(2000)}`,
            skillContent: `剑法${"z".repeat(2000)}`,
          },
          { id: "c2", name: "李四", profile: "", aura: null, cognition: null, soul: "", skillContent: "" },
        ],
        chapterContents: [
          { chapterNumber: 2, title: "风起", summary: "", content: `正文内容${"w".repeat(1000)}` },
          { chapterNumber: 1, title: "雪夜", summary: "少年入门", content: "旧正文" },
        ],
        worldRules: "灵气复苏",
        powerSystem: "练气九层",
        foreshadowing: { items: ["伏笔1"] } as unknown as ForeshadowingStore,
        timeline: ["太子出生", "师门被灭"],
        soulDoc: "魂doc",
      }),
      mode: "hybrid",
      targetWords: 5000,
      llmConfig,
    })
    const [, user] = sentMessages()
    expect(user.content).toContain("## 张三")
    expect(user.content).toContain("档案：")
    expect(user.content).toContain("光环：")
    expect(user.content).toContain("认知：知道[秘密A]；不知道[秘密B]")
    expect(user.content).toContain("技能：")
    expect(user.content).toContain("灵魂：")
    // 超长字段被截断并加省略号
    expect(user.content).toContain("…")
    // 字段为空的角色不渲染空行
    expect(user.content).toContain("## 李四")
    // 无摘要章节回退到正文截断，有摘要章节直接用摘要
    expect(user.content).toContain("第2章《风起》：正文内容")
    expect(user.content).toContain("第1章《雪夜》：少年入门")
    expect(user.content).toContain("灵气复苏")
    expect(user.content).toContain("练气九层")
    expect(user.content).toContain("伏笔1")
    expect(user.content).toContain("1. 太子出生\n2. 师门被灭")
    expect(user.content).toContain("魂doc")
  })
})
