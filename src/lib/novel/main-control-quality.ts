/**
 * 主控 Agent 的真实 LLM 依赖装配（quality deps + 深章流水线）。
 *
 * 拆出独立模块的理由：
 * - `main-control.ts` 只负责编排与边界，不该关心「评分走哪个模型」；
 * - 真实调用需要 novelMode / provider 配置 / 上下文包，属于应用侧装配职责；
 * - 单测与真实联调可分别注入。
 *
 * Draft-first 不受影响：score_chapter 只读、revise_chapter 只返回文本不落盘、
 * run_chapter_workflow 的正文也只回到调用方，持久化仍需 write_chapter + 用户确认。
 */
import type { QualityToolDeps } from "@/lib/agent/tools/score-chapter"
import type { RunDeepChapterGeneration } from "@/lib/agent/tools/run-chapter-workflow"
import type { LlmConfig } from "@/stores/wiki-store"
import { runSixDimensionReview, reviewChapterDimension, SIX_REVIEW_DIMENSIONS } from "./dimension-review-adapter"
import type { ContextPack } from "./context-engine"
import { streamChat } from "@/lib/llm-client"

export interface MainControlQualityOptions {
  projectPath: string
  llmConfig: LlmConfig
  /** 目标章节号：用于取对应上下文包；缺省走「六维审查第?章」。 */
  chapterNumber?: number
  signal?: AbortSignal
  /**
   * 已知上下文包：给了就走「逐维 reviewChapterDimension」直评（仍是真实 LLM，只是不重建上下文包）。
   * 主控已经持有上下文（例如刚读完章节）时可避免重复检索；缺省走 runSixDimensionReview 全链。
   */
  contextPack?: ContextPack
  /** 测试注入：替代真实六维审查。 */
  review?: (args: { projectPath: string; content: string; chapterNumber?: number }) => Promise<Record<string, number>>
  /** 测试注入：替代真实重写调用。 */
  rewrite?: (content: string, brief: string) => Promise<string>
}

const REVISE_SYSTEM_PROMPT = `你是章节定向重写器。只按给定 brief 修改，未提到的维度一律保持原样：
不得增删情节事实、不得改人物设定、不得改动章节标题与序号，不得压缩或扩张篇幅到用户未要求的范围。
直接输出重写后的正文全文，不要输出解释、不要包裹代码块。`

/** 去掉模型偶尔包上的 ``` 代码围栏。 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return fence ? fence[1] : trimmed
}

/**
 * 真实六维评分：走既有 `runSixDimensionReview`（每维一个 LLM 调用 + 上下文包）。
 * 无可用户模型或非小说模式时该函数返回空对象——此时如实报错，不静默造分。
 */
async function realSixDimScore(options: MainControlQualityOptions, content: string): Promise<Record<string, number>> {
  const results = await runSixDimensionReview({
    projectPath: options.projectPath,
    chapterContent: content,
    chapterNumber: options.chapterNumber,
    llmConfig: options.llmConfig,
    signal: options.signal,
  })
  const dims: Record<string, number> = {}
  for (const [key, result] of Object.entries(results)) {
    if (result && Number.isFinite(result.score)) dims[key] = result.score
  }
  if (Object.keys(dims).length === 0) {
    throw new Error("六维评分无结果：请检查模型可用性与小说模式是否开启")
  }
  return dims
}

/** 真实定向重写：一次非流式聚合的聊天调用，只返回文本。 */
async function realRevise(options: MainControlQualityOptions, content: string, brief: string): Promise<string> {
  let text = ""
  let failure: Error | undefined
  await streamChat(
    options.llmConfig,
    [
      { role: "system", content: REVISE_SYSTEM_PROMPT },
      { role: "user", content: `修改要求（brief）：\n${brief}\n\n待改正文：\n${content}` },
    ],
    {
      onToken: (token) => {
        text += token
      },
      onDone: () => {},
      onError: (error) => {
        failure = error
      },
    },
    options.signal,
  )
  if (failure) throw failure
  const revised = stripCodeFence(text)
  if (!revised.trim()) throw new Error("定向重写返回空文本")
  return revised
}

/**
 * 逐维真实评分（给定上下文包）：不重建上下文包，每维一次两阶段 LLM 评审。
 * 一维失败不影响其它维；全部失败时与全链路径一致地报错，不静默造分。
 */
async function scoreWithContextPack(
  options: MainControlQualityOptions & { contextPack: ContextPack },
  content: string,
): Promise<Record<string, number>> {
  const results = await Promise.allSettled(
    Object.values(SIX_REVIEW_DIMENSIONS).map((dimension) =>
      reviewChapterDimension({
        llmConfig: options.llmConfig,
        contextPack: options.contextPack,
        chapterContent: content,
        dimension,
        signal: options.signal,
      }),
    ),
  )
  const dimensions = Object.values(SIX_REVIEW_DIMENSIONS)
  const dims: Record<string, number> = {}
  const failures: string[] = []
  results.forEach((outcome, index) => {
    const key = dimensions[index].key
    if (outcome.status === "fulfilled" && Number.isFinite(outcome.value.score)) {
      dims[key] = outcome.value.score
    } else {
      failures.push(outcome.status === "rejected" ? `${key}: ${String(outcome.reason)}` : `${key}: 无分数`)
    }
  })
  if (Object.keys(dims).length === 0) {
    throw new Error(`六维评分无结果：${failures.slice(0, 2).join("；") || "所有维度均无分数"}`)
  }
  return dims
}

/** 构造注入主控 Agent 的 quality deps（真实 LLM 版）。 */
export function createMainControlQualityDeps(options: MainControlQualityOptions): QualityToolDeps {
  return {
    scoreChapter: (content) => {
      if (options.review) {
        return options.review({ projectPath: options.projectPath, content, chapterNumber: options.chapterNumber })
      }
      if (options.contextPack) return scoreWithContextPack({ ...options, contextPack: options.contextPack }, content)
      return realSixDimScore(options, content)
    },
    reviseChapter: (content, brief) =>
      options.rewrite ? options.rewrite(content, brief) : realRevise(options, content, brief),
  }
}

/**
 * 取深章流水线入口。共识模式开启且配了写作模型组时用共识版，否则用单模型版；
 * 动态 import 保证关闭状态零额外模块加载。
 */
export async function resolveDeepChapterRunner(options: {
  consensusEnabled?: boolean
  consensusWritingModels?: readonly string[]
}): Promise<RunDeepChapterGeneration> {
  const consensus =
    Boolean(options.consensusEnabled) && (options.consensusWritingModels ?? []).some((m) => m.trim().length > 0)
  if (consensus) {
    const { runDeepChapterGenerationConsensus } = await import("./consensus-writing")
    return runDeepChapterGenerationConsensus
  }
  const { runDeepChapterGeneration } = await import("./deep-chapter-generation")
  return runDeepChapterGeneration
}
