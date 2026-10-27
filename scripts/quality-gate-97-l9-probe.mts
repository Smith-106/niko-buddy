// L9 通道探针（P6 前置确认）：1 章 × 1 维 × 1 采样 = 1 次 LLM 调用
//
// 用途：在开 S/M/L 战役前确认 CPA/sub2 通道可用、模型存在、返回可解析。
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-probe.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-probe.json
// 退出码: 0 = 通道可用；1 = 不可用（不消耗战役预算）
import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { readFileSync, writeFileSync } from "node:fs"
import { decryptApiKeysInObject } from "../src/lib/crypto.ts"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

const deviceFingerprint = createHash("sha256")
  .update(`qmai::${process.env.COMPUTERNAME || hostname()}::${process.env.USERNAME || userInfo().username}::windows::device-key-v1`)
  .digest("hex")
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => key === "niko_buddy_fallback_fingerprint" ? deviceFingerprint : null,
    setItem: () => {},
    removeItem: () => {},
  },
})

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const PROBE_CHAPTER = Number(process.env.L9_PROBE_CHAPTER || 1)
const PROBE_DIM = process.env.L9_PROBE_DIM || "thrill"
const PROBE_MODEL = process.env.L9_PROBE_MODEL || ""

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  providerConfigs?: Record<string, LlmConfig>
  projectNovelConfigs?: Record<string, NovelConfig>
}
const xaiProvider = await decryptApiKeysInObject(state.providerConfigs?.xai ?? {})
if (!xaiProvider?.apiKey || xaiProvider.apiKey.startsWith("enc::")) throw new Error("xai key fail")
const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: xaiProvider.apiKey,
  model: PROBE_MODEL || xaiProvider.model || "composer-2.5",
  customEndpoint: xaiProvider.customEndpoint || "https://sub2.nikoniko.tech/v1",
  apiMode: "responses",
  maxContextSize: xaiProvider.maxContextSize ?? 200000,
  reasoning: xaiProvider.reasoning ?? { mode: "auto" },
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
  purpose: "P6 通道前置确认：1 次调用验证模型存在 + 返回可解析",
  model: llmConfig.model,
  endpoint: llmConfig.customEndpoint,
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
      [{ role: "user", content: prompt }] as any,
      {
        onToken: (t: string) => { content += t },
        onDone: () => resolve(),
        onError: (e: Error) => { streamError = e; resolve() },
      } as any,
    )
  })
  if (streamError) throw streamError
  const score = extractScore(content)
  result.ok = score !== null
  result.score = score
  result.responseChars = content.length
  result.elapsedMs = Date.now() - startedAt
  result.responseHead = content.slice(0, 400)
  if (score === null) {
    result.error = "返回中未找到 \"score\": <number>，通道可用但协议不符"
  }
} catch (err) {
  result.ok = false
  result.elapsedMs = Date.now() - startedAt
  result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

writeFileSync("../.workflow/harvest-staging/quality-gate-97-l9-probe.json", JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
