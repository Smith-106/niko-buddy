// #108 L9全书测量基线: 162章 x 全六维 x N=5, overall = 六维中位的中位
//
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-baseline.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-baseline.json
// 模型: muse-spark-1.3-contributor-free（deepseek provider 经 resolveModelConfig 等价构造；probe-musespark.mts 已验证）
// 2026-10-10 起全量重跑：composer-2.5 口径已归档 quality-gate-97-l9-baseline-composer-2.5.json（含 pilot seed 3 章）
// 全量重跑时设 SKIP_PILOT_SEED=1，pilot 3 章同样用 Muse Spark 重测，保证单一口径
// 断点续跑: 每章落盘一次；重启自动跳过已有 overall 的章节；overall==null 章自动重跑
// 并发: 2 维并行 x 每维 5 采样并行 = 峰值 10 并发（用户要求控制并发；探针 10/10 全通。30/45/60 会 429）
// 通过标准(L9 v2): 每章 overall 中位 >= 9.0；本脚本只测量不改稿
import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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
const CHAPTERS = Array.from({ length: 162 }, (_, i) => i + 1)
const SAMPLES = 5
const OUT_PATH = "../.workflow/harvest-staging/quality-gate-97-l9-baseline.json"
const PILOT_PATH = "../.workflow/harvest-staging/quality-gate-97-l9-pilot.json"

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  providerConfigs?: Record<string, LlmConfig>
  projectNovelConfigs?: Record<string, NovelConfig>
}
const dsProvider = (await decryptApiKeysInObject(state.providerConfigs?.deepseek ?? {})) as any
if (!dsProvider?.apiKey || dsProvider.apiKey.startsWith("enc::")) throw new Error("deepseek key fail")
// 等价于 resolveModelConfig("deepseek/muse-spark-1.3-contributor-free") 的 resolved 结果
const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: dsProvider.apiKey,
  model: "muse-spark-1.3-contributor-free",
  customEndpoint: dsProvider.baseUrl || "https://cpa.nikoniko.tech/v1",
  apiMode: dsProvider.apiMode ?? "chat_completions",
  maxContextSize: dsProvider.maxContextSize ?? 262144,
  reasoning: dsProvider.reasoning ?? { mode: "max" },
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

// 恢复或初始化输出（含 pilot seed）
let out: Record<string, unknown>
if (existsSync(OUT_PATH)) {
  out = JSON.parse(readFileSync(OUT_PATH, "utf8"))
  console.log(`[resume] loaded baseline with ${Object.keys((out.results ?? {}) as object).length} chapters done`)
} else {
  out = {
    generatedAt: new Date().toISOString(),
    model: llmConfig.model,
    samples: SAMPLES,
    chapters: CHAPTERS,
    dimensions: SIX_REVIEW_DIMENSION_ORDER,
    overallFormula: "overall = median(six dimension medians) [step0-ab-calibration]",
    criterion: "overall median >= 9.0 (Track L9 v2); measure-only, no rewrite",
    results: {},
  }
  if (process.env.SKIP_PILOT_SEED === "1") {
    console.log("[seed] skipped (SKIP_PILOT_SEED=1): pilot chapters will be re-measured with current model")
  } else if (existsSync(PILOT_PATH)) {
    const pilot = JSON.parse(readFileSync(PILOT_PATH, "utf8")) as { results: Record<string, unknown> }
    for (const [k, v] of Object.entries(pilot.results)) {
      ;(out.results as Record<string, unknown>)[k] = { ...(v as object), seededFrom: "quality-gate-97-l9-pilot.json" }
    }
    console.log(`[seed] seeded ${Object.keys(pilot.results).length} pilot chapters`)
  }
}

function save() {
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
}

let done = 0
for (const ch of CHAPTERS) {
  const key = `ch${ch}`
  const existing = (out.results as Record<string, unknown>)[key] as { overall?: number | null } | undefined
  if (existing && existing.overall !== null && existing.overall !== undefined) {
    done++
    continue
  }
  const raw = readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8")
  const chapterText = stripFrontmatter(raw)
  const pack = await buildContextPack(PROJECT, `六维审查第${ch}章`, ch, {
    novelMode: true, llmConfig, novelConfig,
  })
  const dimMedians: Record<string, number | null> = {}
  const dimResults: Record<string, unknown> = {}
// 维度级并行：2 维并行 x 每维 5 采样并行 = 峰值 10 并发（探针已验证：10 全通 / 15 降质）
  async function runDimension(dim: keyof typeof SIX_REVIEW_DIMENSIONS) {
    const prompt = buildDimensionReviewPrompt(pack, chapterText, SIX_REVIEW_DIMENSIONS[dim])
    const protocol = createLiteraryExperimentProtocol({
      model: llmConfig.model || "unknown",
      samples: SAMPLES,
      label: `gate97-l9-baseline-ch${ch}-${dim}`,
      notes: ["Track L9 full-book baseline; all six dims; NEW arm only; measure-only"],
    })
    const fingerprint = buildMeasurementFingerprint({
      protocol, pack, chapterText, packKind: "app-runtime-six-dimension",
    })
    async function runSample(s: number): Promise<number | null> {
      let value: number | null = null
      for (let attempt = 1; attempt <= 3 && value === null; attempt++) {
        let content = ""
        try {
          await streamChat(
            llmConfig,
            [{ role: "user", content: `${prompt}\n\n只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。` }],
            { onToken: (t: string) => { content += t }, onDone: () => undefined, onError: (e: Error) => { throw e } },
            AbortSignal.timeout(300000),
            // Muse Spark：reasoning off + 8000 tokens（全量 prompt 下 max 会吃光 max_tokens；单发对照已验证）
            { temperature: 0.4, max_tokens: 8000, reasoning: { mode: "off" } as any },
          )
          const rawScore = extractScore(content)
          if (rawScore !== null && !Number.isNaN(rawScore)) value = rawScore > 10.5 ? rawScore / 10 : rawScore
        } catch (e) { console.log(`[ch${ch}/${dim}/s${s}] err=${String(e).slice(0, 180)}`) }
        if (value === null && attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
      console.log(`[ch${ch}/${dim}/s${s}] score=${value}`)
      return value
    }
    // 采样级并行：同维度 5 采样并发；重试/指纹/公式/落盘逻辑不动
    const scores = await Promise.all(Array.from({ length: SAMPLES }, (_, s) => runSample(s)))
    const errors: string[] = []
    scores.forEach((value, s) => {
      if (value === null) errors.push(`[ch${ch}/${dim}/s${s}] no score after retries`)
    })
    const valid = scores.filter((v): v is number => v !== null)
    const med = valid.length ? median(valid) : null
    dimMedians[dim] = med
    dimResults[dim] = { scores, median: med, measurementFingerprint: fingerprint, errors }
    return med
  }
  const DIM_ORDER = SIX_REVIEW_DIMENSION_ORDER as (keyof typeof SIX_REVIEW_DIMENSIONS)[]
  // 峰值 10 并发：2 维 x 5 采样。不做章节级并行。
  for (let d = 0; d < DIM_ORDER.length; d += 2) {
    await Promise.all(DIM_ORDER.slice(d, d + 2).map((dim) => runDimension(dim)))
  }
  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  ;(out.results as Record<string, unknown>)[key] = {
    dimensions: dimResults,
    dimensionMedians: dimMedians,
    overall,
    pass: overall !== null && overall >= 9.0,
  }
  done++
  save()
  console.log(`[ch${ch}] overall=${overall} pass=${overall !== null && overall >= 9.0} (${done}/162)`)
}

const summary = Object.fromEntries(Object.entries(out.results as object).map(([k, v]: [string, any]) => [k, v.overall]))
const passCount = Object.values(summary).filter((v) => typeof v === "number" && v >= 9.0).length
console.log(JSON.stringify({ done: Object.keys(summary).length, passCount }, null, 1))
