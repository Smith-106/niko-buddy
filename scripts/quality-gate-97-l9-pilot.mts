// #107 L9解冻pilot: 关键章(1/84/162) 全六维 N=5, overall = 六维中位的中位
//
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-pilot.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-pilot.json
// 成本: 3章 x 6维 x 5采样 = 90 LLM calls
// 通过标准(L9 v2): 每章 overall 中位 >= 9.0
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
const CHAPTERS = [1, 84, 162]
const SAMPLES = 5

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  providerConfigs?: Record<string, LlmConfig>
  projectNovelConfigs?: Record<string, NovelConfig>
}
const xaiProvider = await decryptApiKeysInObject(state.providerConfigs?.xai ?? {})
if (!xaiProvider?.apiKey || xaiProvider.apiKey.startsWith("enc::")) throw new Error("xai key fail")
const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: xaiProvider.apiKey,
  model: xaiProvider.model || "composer-2.5",
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
const { buildDimensionReviewPrompt, SIX_REVIEW_DIMENSIONS, SIX_REVIEW_DIMENSION_ORDER } = await import("../src/lib/novel/dimension-review-adapter.ts")
const { streamChat } = await import("../src/lib/llm-client.ts")
const { buildMeasurementFingerprint } = await import("../src/lib/novel/measurement-fingerprint.ts")
const { createLiteraryExperimentProtocol } = await import("../src/lib/novel/literary-experiment-protocol.ts")

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}
function extractScore(text: string): number | null {
  const m = text.match(/"score"\s*:\s*([\d.]+)/)
  return m ? Number(m[1]) : null
}
function stripFrontmatter(t: string): string {
  return t.replace(/^---\n.*?\n---\n/s, "")
}

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  model: llmConfig.model,
  samples: SAMPLES,
  chapters: CHAPTERS,
  dimensions: SIX_REVIEW_DIMENSION_ORDER,
  overallFormula: "overall = median(six dimension medians) [step0-ab-calibration]",
  criterion: "overall median >= 9.0 (Track L9 v2)",
  results: {},
}

for (const ch of CHAPTERS) {
  const raw = readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8")
  const chapterText = stripFrontmatter(raw)
  const pack = await buildContextPack(PROJECT, `六维审查第${ch}章`, ch, {
    novelMode: true, llmConfig, novelConfig,
  })
  const dimMedians: Record<string, number | null> = {}
  const dimResults: Record<string, unknown> = {}
  for (const dim of SIX_REVIEW_DIMENSION_ORDER as (keyof typeof SIX_REVIEW_DIMENSIONS)[]) {
    const prompt = buildDimensionReviewPrompt(pack, chapterText, SIX_REVIEW_DIMENSIONS[dim])
    const protocol = createLiteraryExperimentProtocol({
      model: llmConfig.model || "unknown",
      samples: SAMPLES,
      label: `gate97-l9-pilot-ch${ch}-${dim}`,
      notes: ["Track L9 pilot; all six dims; NEW arm only"],
    })
    const fingerprint = buildMeasurementFingerprint({
      protocol, pack, chapterText, packKind: "app-runtime-six-dimension",
    })
    const scores: (number | null)[] = []
    const errors: string[] = []
    for (let s = 0; s < SAMPLES; s++) {
      let value: number | null = null
      for (let attempt = 1; attempt <= 3 && value === null; attempt++) {
        let content = ""
        try {
          await streamChat(
            llmConfig,
            [{ role: "user", content: `${prompt}\n\n只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。` }],
            { onToken: (t: string) => { content += t }, onDone: () => undefined, onError: (e: Error) => { throw e } },
            AbortSignal.timeout(300000),
            { temperature: 0.4, max_tokens: 2000 },
          )
          const rawScore = extractScore(content)
          if (rawScore !== null && !Number.isNaN(rawScore)) value = rawScore > 10.5 ? rawScore / 10 : rawScore
        } catch { /* retry */ }
        if (value === null && attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
      scores.push(value)
      if (value === null) errors.push(`[ch${ch}/${dim}/s${s}] no score after retries`)
      console.log(`[ch${ch}/${dim}/s${s}] score=${value}`)
    }
    const valid = scores.filter((v): v is number => v !== null)
    const med = valid.length ? median(valid) : null
    dimMedians[dim] = med
    dimResults[dim] = { scores, median: med, measurementFingerprint: fingerprint, errors }
  }
  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  ;(out.results as Record<string, unknown>)[`ch${ch}`] = {
    dimensions: dimResults,
    dimensionMedians: dimMedians,
    overall,
    pass: overall !== null && overall >= 9.0,
  }
  console.log(`[ch${ch}] overall=${overall} pass=${overall !== null && overall >= 9.0}`)
}

writeFileSync(
  "../.workflow/harvest-staging/quality-gate-97-l9-pilot.json",
  JSON.stringify(out, null, 2),
)
console.log(JSON.stringify({ overall: Object.fromEntries(Object.entries(out.results as object).map(([k, v]: [string, any]) => [k, v.overall])) }, null, 1))
