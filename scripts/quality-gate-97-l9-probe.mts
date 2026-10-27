// L9 通道探针 v2（P6 前置确认）：1 章 × 1 维 × 1 采样 = 1 次 LLM 调用
//
// 通道：CPA (https://cpa.nikoniko.tech/v1) + muse-spark-1.3-contributor，
// 与 L9 基线唯一口径一致。key 取自 ~/.pi/agent/auth.json（内存解密，不落盘）。
// 关键发现：muse-spark 非流式必 500（empty response content），流式 200 正常；
// QMAI streamChat 本就是流式，因此 harness 路径可用。
//
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-probe.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-probe.json
// 退出码: 0 = 通道可用；1 = 不可用
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const PROBE_CHAPTER = Number(process.env.L9_PROBE_CHAPTER || 1)
const PROBE_DIM = process.env.L9_PROBE_DIM || "thrill"

// CPA key：与 Pi 本体同源（~/.pi/agent/auth.json 的 cpa-responses.key），仅内存使用。
const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))
const cpaKey: string = auth["cpa-responses"]?.key
if (!cpaKey) throw new Error("auth.json 缺 cpa-responses.key")

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: cpaKey,
  model: process.env.L9_PROBE_MODEL || "muse-spark-1.3-contributor",
  customEndpoint: "https://cpa.nikoniko.tech/v1",
  apiMode: "chat_completions",
  maxContextSize: 200000,
  // CPA 推理首 token 可能慢：header 等待放宽到 120s，流 idle 300s。
  httpHeaderTimeoutMs: 120000,
  httpStreamIdleMs: 300000,
  reasoning: { mode: "auto" },
}

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  projectNovelConfigs?: Record<string, NovelConfig>
}
const novelConfig = {
  ...(state.projectNovelConfigs?.[PROJECT_ID] ?? {}),
  reviewModel: llmConfig.model,
  communitySummaryEnabled: false,
}

const { useWikiStore } = await import("../src/stores/wiki-store.ts")
useWikiStore.setState({ novelMode: true, llmConfig, novelConfig } as any)

const { buildContextPack } = await import("../src/lib/novel/context-engine.ts")
const { buildDimensionReviewPrompt, SIX_REVIEW_DIMENSIONS } = await import("../src/lib/novel/dimension-review-adapter.ts")
const { streamChat } = await import("../src/lib/llm-client.ts")

function extractScore(text: string): number | null {
  const m = text.match(/"score"\s*:\s*([\d.]+)/)
  return m ? Number(m[1]) : null
}
function stripFrontmatter(t: string): string {
  return t.replace(/^---\n.*?\n---\n/s, "")
}

const startedAt = Date.now()
const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  purpose: "P6 通道前置确认：harness 流式路径 1 次调用验证",
  channel: "cpa",
  model: llmConfig.model,
  endpoint: llmConfig.customEndpoint,
  apiMode: llmConfig.apiMode,
  chapter: PROBE_CHAPTER,
  dimension: PROBE_DIM,
}

try {
  const raw = readFileSync(`${PROJECT}/QM/chapters/chapter-${String(PROBE_CHAPTER).padStart(3, "0")}.md`, "utf8")
  const chapterText = stripFrontmatter(raw)
  const pack = await buildContextPack(PROJECT, `通道探针第${PROBE_CHAPTER}章`, PROBE_CHAPTER, {
    novelMode: true, llmConfig, novelConfig,
  })
  const dimSpec = SIX_REVIEW_DIMENSIONS[PROBE_DIM as keyof typeof SIX_REVIEW_DIMENSIONS]
  if (!dimSpec) throw new Error(`未知维度 ${PROBE_DIM}`)
  const prompt = buildDimensionReviewPrompt(pack, chapterText, dimSpec)

  let content = ""
  let streamError: Error | null = null
  await new Promise<void>((resolve) => {
    void streamChat(
      llmConfig,
      [{ role: "user", content: `${prompt}\n\n只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。` }] as any,
      {
        onToken: (t: string) => { content += t },
        onDone: () => resolve(),
        onError: (e: Error) => { streamError = e; resolve() },
      } as any,
      AbortSignal.timeout(300000),
      // max_tokens 16000：thinking 3k~7k 字符会吃掉小预算导致零正文；
      // 给足「思考 + 正文」预算，可经 L9_PROBE_MAX_TOKENS 覆盖。
      { temperature: 0.4, max_tokens: Number(process.env.L9_PROBE_MAX_TOKENS ?? 16000) } as any,
    )
  })
  if (streamError) throw streamError
  const score = extractScore(content)
  result.ok = score !== null
  result.score = score
  result.responseChars = content.length
  result.elapsedMs = Date.now() - startedAt
  if (score === null) {
    result.error = "返回中未找到 score；通道通但协议不符"
    result.responseHead = content.slice(0, 400)
  }
} catch (err) {
  result.ok = false
  result.elapsedMs = Date.now() - startedAt
  result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

writeFileSync("../.workflow/harvest-staging/quality-gate-97-l9-probe.json", JSON.stringify(result, null, 2) + "\n")
// 注意：产物不得含 key（result 对象从未写入 apiKey）。
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
