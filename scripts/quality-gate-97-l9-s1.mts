// L9 S1 噪声复测：8 章 × 全维 × N=10 = 480 calls
//
// 章单：pilot ch1/ch84/ch162 + 深水 ch2/ch3/ch36 + near-miss ch66/ch76（8.95 最贴线）。
// 口径（L9_S1_MODEL 环境覆盖，缺省 muse-spark）：
// - muse-spark = Oct-10 基线同一口径（U2 跨口径差天然消除）；
//   deepseek 池 429 配额冷却中（见 blocker doc §十三），待恢复后可选跑对照。
// - sub2 全线 503。
// 断点续跑：每章完成后落盘，重启自动跳过已有 overall 的章。
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-s1.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-s1.json
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

// 单例锁：kill background job 时 node 子进程可能存活成幽灵，重启新实例前
// 若锁内 pid 仍存活则直接退出（exit 3），杜绝多实例并发烧 call。
const LOCK = join(tmpdir(), "l9-s1.lock")
try {
  const oldPid = Number(readFileSync(LOCK, "utf8").trim())
  if (Number.isFinite(oldPid) && oldPid > 0) {
    process.kill(oldPid, 0)
    console.error(`另一 S1 实例仍在运行 (pid=${oldPid})，拒绝启动。先 kill 干净再跑。`)
    process.exit(3)
  }
} catch { /* 无锁或 pid 已死 → 继续 */ }
writeFileSync(LOCK, String(process.pid))
process.on("exit", () => { try { if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) unlinkSync(LOCK) } catch { /* ignore */ } })

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const CHAPTERS = [1, 84, 162, 2, 3, 36, 66, 76]
const SAMPLES = 10
const MODEL = process.env.L9_S1_MODEL ?? "muse-spark-1.3-contributor"
const isDeepSeek = /deepseek/i.test(MODEL)
const OUT = "../.workflow/harvest-staging/quality-gate-97-l9-s1.json"

const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))
const cpaKey: string = auth["cpa-responses"]?.key
if (!cpaKey) throw new Error("auth.json 缺 cpa-responses.key")

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: cpaKey,
  model: MODEL,
  customEndpoint: "https://cpa.nikoniko.tech/v1",
  apiMode: "chat_completions",
  maxContextSize: 200000,
  httpHeaderTimeoutMs: 120000,
  httpStreamIdleMs: 300000,
  // 口径定义：deepseek 用 reasoning off（wire thinking disabled，能否执行看 relay）；
  // muse-spark 用 auto（off 对其无 wire 映射，auto 保留 harness 的 thinking-only
  // 自动降级重试）。S1 全 480 calls 同一设置，口径内自洽。
  reasoning: { mode: isDeepSeek ? "off" : "auto" },
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
const { buildDimensionReviewPrompt, SIX_REVIEW_DIMENSIONS, SIX_REVIEW_DIMENSION_ORDER } = await import("../src/lib/novel/dimension-review-adapter.ts")
const { createLiteraryExperimentProtocol } = await import("../src/lib/novel/literary-experiment-protocol.ts")
const { buildMeasurementFingerprint } = await import("../src/lib/novel/measurement-fingerprint.ts")
const { streamChat } = await import("../src/lib/llm-client.ts")

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
  return t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
}

const out: Record<string, unknown> = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : {
      generatedAt: new Date().toISOString(),
      purpose: `L9 S1：8 章 × 全维 × N=10 噪声复测（${MODEL} 口径，基线可比）`,
      model: llmConfig.model,
      channel: "cpa",
      samples: SAMPLES,
      chapters: CHAPTERS,
      dimensions: SIX_REVIEW_DIMENSION_ORDER,
      overallFormula: "overall = median(six dimension medians)",
      criterion: "overall median >= 9.0 (Track L9 v2)",
      results: {},
    }
const results = out.results as Record<string, unknown>
function save() {
  ;(out as any).updatedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n")
}

let doneCalls = 0
for (const ch of CHAPTERS) {
  if ((results[`ch${ch}`] as any)?.overall !== undefined && (results[`ch${ch}`] as any)?.overall !== null) {
    console.log(`[ch${ch}] 已有结果，跳过`)
    continue
  }
  // 续跑：该章已有部分维度则保留（本版按章 checkpoint，章内重跑）。
  const raw = readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8")
  const chapterText = stripFrontmatter(raw)
  const pack = await buildContextPack(PROJECT, `L9-S1 第${ch}章`, ch, {
    novelMode: true, llmConfig, novelConfig,
  })
  const dimMedians: Record<string, number | null> = {}
  const dimResults: Record<string, unknown> = {}
  for (const dim of SIX_REVIEW_DIMENSION_ORDER as (keyof typeof SIX_REVIEW_DIMENSIONS)[]) {
    const prompt = buildDimensionReviewPrompt(pack, chapterText, SIX_REVIEW_DIMENSIONS[dim])
    const protocol = createLiteraryExperimentProtocol({
      model: llmConfig.model || "unknown",
      samples: SAMPLES,
      label: `gate97-l9-s1-ch${ch}-${dim}`,
      notes: ["Track L9 S1; deepseek caliber; N=10"],
    })
    const fingerprint = buildMeasurementFingerprint({
      protocol, pack, chapterText, packKind: "app-runtime-six-dimension",
    })
    const scores: (number | null)[] = []
    const errors: string[] = []
    for (let s = 0; s < SAMPLES; s++) {
      let value: number | null = null
      let lastErr = ""
      // CPA injector 阵发 502（upstream connection refused）：6 次指数退避
      // （5/10/20/40/60s），穿过风暴而非在风暴里烧掉样本。
      const BACKOFF = [5000, 10000, 20000, 40000, 60000]
      for (let attempt = 1; attempt <= 6 && value === null; attempt++) {
        let content = ""
        try {
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
              // max_tokens 16000（canary 9 实证）：thinking 常输出 3k~7k 字符，
              // 2000/4000 预算会被思考吃光导致零正文；16k 让「思考 + 正文」共存。
              // 残余失败模式是传输 stall（300s 超时），由外层 6 次退避吸收。
              { temperature: 0.4, max_tokens: 16000 } as any,
            )
          })
          if (streamError) throw streamError
          const rawScore = extractScore(content)
          if (rawScore !== null && !Number.isNaN(rawScore)) value = rawScore > 10.5 ? rawScore / 10 : rawScore
          else lastErr = `无score(${content.length}ch): ${content.slice(0, 120).replace(/\n/g, " ")}`
        } catch (e) { lastErr = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : String(e).slice(0, 160) }
        if (value === null && attempt <= BACKOFF.length) {
          console.log(`[ch${ch}/${dim}/s${s}] attempt${attempt} 失败，${BACKOFF[attempt - 1] / 1000}s 后重试：${lastErr.slice(0, 100)}`)
          await new Promise((r) => setTimeout(r, BACKOFF[attempt - 1]))
        }
      }
      // 样本间 3s 间隔，避免 плотный hammer 触发网关限流。
      await new Promise((r) => setTimeout(r, 3000))
      scores.push(value)
      doneCalls++
      if (value === null) errors.push(`[ch${ch}/${dim}/s${s}] no score after retries: ${lastErr}`)
      console.log(`[ch${ch}/${dim}/s${s}] score=${value}${value === null ? ` ERR:${lastErr}` : ""} (累计 ${doneCalls}/480)`)
    }
    const valid = scores.filter((v): v is number => v !== null)
    const med = valid.length ? median(valid) : null
    dimMedians[dim as string] = med
    dimResults[dim as string] = { scores, median: med, measurementFingerprint: fingerprint, errors }
  }
  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  results[`ch${ch}`] = {
    dimensions: dimResults,
    dimensionMedians: dimMedians,
    overall,
    pass: overall !== null && overall >= 9.0,
  }
  save()
  console.log(`[ch${ch}] overall=${overall} pass=${overall !== null && overall >= 9.0} — 已落盘`)
}

console.log(JSON.stringify({ overall: Object.fromEntries(Object.entries(results).map(([k, v]: [string, any]) => [k, v.overall])) }, null, 1))
