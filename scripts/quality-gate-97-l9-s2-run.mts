// L9 S2 AB 试改写执行：ch2（带原章全文）vs ch36（仅 brief），各 N=5 复测。
//
// 前置：S1 JSON 必须含 ch2/ch36 overall（deepseek 中位 = hold 线）。
// Draft-first：只取 runDeepChapterGeneration 返回的 draftContent/finalContent
//   送复测；全程不调用 batchAccept、不写 wiki/chapters、不 ingest。
// 口径：生成用 reasoning auto（写作用思考）；复测用 reasoning off（= S1 口径）。
// Keep 门：overall ≥ hold 且 pacing 跌幅 < 0.3。
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-s2-run.json
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const S1 = "../.workflow/harvest-staging/quality-gate-97-l9-s1.json"
const OUT = "../.workflow/harvest-staging/quality-gate-97-l9-s2-run.json"
const MODEL = process.env.L9_S1_MODEL ?? "muse-spark-1.3-contributor"
const N = 5
const ARMS = [
  { chapter: 2, withFullText: true },
  { chapter: 36, withFullText: false },
]

// 单例锁（mtime 心跳制，免疫 pid 复用）：与 S1 同语义，锁名不同。
const LOCK = join(tmpdir(), "l9-s2.lock")
const LOCK_TTL_MS = 120000
function lockFresh(): boolean {
  try {
    const st = statSync(LOCK)
    return Date.now() - st.mtimeMs < LOCK_TTL_MS
  } catch { return false }
}
if (lockFresh()) {
  console.error("另一 S2 实例仍在运行（锁在 120s 内刷新过），拒绝启动。")
  process.exit(3)
}
writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`)
const heartbeat = setInterval(() => { try { writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`) } catch { /* ignore */ } }, 30000)
process.on("exit", () => { clearInterval(heartbeat); try { unlinkSync(LOCK) } catch { /* ignore */ } })

if (!existsSync(S1)) {
  console.error("S1 未完成：quality-gate-97-l9-s1.json 不存在，拒绝执行（不消耗 LLM）。")
  process.exit(2)
}
const s1 = JSON.parse(readFileSync(S1, "utf8"))
const holds: Record<number, number> = {}
for (const { chapter } of ARMS) {
  const o = (s1.results as any)?.[`ch${chapter}`]?.overall
  if (typeof o !== "number") {
    console.error(`S1 缺 ch${chapter} overall 中位，拒绝执行。请先补测。`)
    process.exit(2)
  }
  holds[chapter] = o
}
console.log(`hold 线就绪：${JSON.stringify(holds)}`)

const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))
const cpaKey: string = auth["cpa-responses"]?.key
if (!cpaKey) throw new Error("auth.json 缺 cpa-responses.key")

function baseLlm(reasoningMode: "auto" | "off"): LlmConfig {
  return {
    provider: "custom",
    apiKey: cpaKey,
    model: MODEL,
    customEndpoint: "https://cpa.nikoniko.tech/v1",
    apiMode: "chat_completions",
    maxContextSize: 200000,
    httpHeaderTimeoutMs: 120000,
    httpStreamIdleMs: 300000,
    reasoning: { mode: reasoningMode },
  }
}
const genLlm = baseLlm("auto")
// 复测口径 = S1 口径：deepseek 用 off，muse-spark 用 auto（同 S1 的 isDeepSeek 规则）。
const measureLlm = baseLlm(/deepseek/i.test(MODEL) ? "off" : "auto")

const state = JSON.parse(readFileSync("C:/Users/niko/AppData/Roaming/com.niko-buddy.app/app-state.json", "utf8")) as {
  projectNovelConfigs?: Record<string, NovelConfig>
}
const novelConfig = {
  ...(state.projectNovelConfigs?.[PROJECT_ID] ?? {}),
  reviewModel: MODEL,
  communitySummaryEnabled: false,
}
const { useWikiStore } = await import("../src/stores/wiki-store.ts")
useWikiStore.setState({ novelMode: true, llmConfig: measureLlm, novelConfig } as any)

const { buildContextPack } = await import("../src/lib/novel/context-engine.ts")
const { buildDimensionReviewPrompt, SIX_REVIEW_DIMENSIONS, SIX_REVIEW_DIMENSION_ORDER } = await import("../src/lib/novel/dimension-review-adapter.ts")
const { resolveResidualCampaignFields } = await import("../src/lib/novel/residual-campaign.ts")
const { runDeepChapterGeneration } = await import("../src/lib/novel/deep-chapter-generation.ts")
const { streamChat } = await import("../src/lib/llm-client.ts")

function stripFrontmatter(t: string): string {
  return t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
}
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}
function extractScore(text: string): number | null {
  const m = text.match(/"score"\s*:\s*([\d.]+)/)
  return m ? Number(m[1]) : null
}

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  purpose: "L9 S2 AB 试改写 + N=5 复测（deepseek 口径，复测 reasoning off = S1 口径）",
  model: MODEL,
  arms: {},
}
const armsOut = out.arms as Record<string, unknown>
function save() {
  ;(out as any).updatedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n")
}

for (const { chapter: ch, withFullText } of ARMS) {
  const s1dim = (s1.results as any)[`ch${ch}`].dimensionMedians as Record<string, number>
  const fields = resolveResidualCampaignFields({
    enabled: true,
    chapterNumber: ch,
    config: { residualCampaignOverallMedian: holds[ch], residualCampaignDimMedians: s1dim } as any,
  })
  let userRequest = [
    `【L9 S2 试改写任务书】第 ${ch} 章`,
    `残余带 overall hold（deepseek S1 中位）：${holds[ch]}`,
    `dim 中位（deepseek S1）：${JSON.stringify(s1dim)}`,
    `改写模式：structure_thril_pacing + lengthPreserving`,
  ].join("\n")
  if (withFullText) {
    const full = stripFrontmatter(readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8"))
    userRequest += `\n\n【原章全文参照（改写锚点，不得照抄）】\n${full}`
  } else {
    userRequest += `\n参照模式：仅 task-brief + dim 诊断重写，不带原文。`
  }

  console.log(`[ch${ch}] 生成开始（${withFullText ? "带全文" : "仅brief"}，${userRequest.length}ch）…`)
  const gen = await runDeepChapterGeneration(
    {
      projectPath: PROJECT,
      userRequest,
      chapterNumber: ch,
      llmConfig: genLlm,
      novelConfig,
      ...(fields
        ? {
            residualOverallMedian: fields.residualOverallMedian,
            residualRewriteMode: fields.residualRewriteMode,
            residualLengthPreserving: fields.residualLengthPreserving,
            chapterStructurePlan: fields.chapterStructurePlan,
          }
        : {}),
    },
    { onThinking: () => {}, onFinalContent: () => {}, onCheckpoint: () => {} },
  )
  const draft = stripFrontmatter(gen.draftContent?.trim() ? gen.draftContent : gen.finalContent)
  console.log(`[ch${ch}] 生成完成：draft=${draft.length}ch partial=${gen.partial} revised=${gen.revised}`)
  if (!draft || gen.partial) {
    armsOut[`ch${ch}`] = { withFullText, hold: holds[ch], status: "generation-incomplete", partial: gen.partial, draftChars: draft.length }
    save()
    continue
  }

  // 复测：与 S1 同测量函数/参数（temp 0.4 / max_tokens 4000 / 6 次退避 / 样本间隔）。
  useWikiStore.setState({ novelMode: true, llmConfig: measureLlm, novelConfig } as any)
  const pack = await buildContextPack(PROJECT, `L9-S2 第${ch}章改写稿`, ch, {
    novelMode: true, llmConfig: measureLlm, novelConfig,
  })
  const dimMedians: Record<string, number | null> = {}
  for (const dim of SIX_REVIEW_DIMENSION_ORDER as (keyof typeof SIX_REVIEW_DIMENSIONS)[]) {
    const prompt = buildDimensionReviewPrompt(pack, draft, SIX_REVIEW_DIMENSIONS[dim])
    const scores: (number | null)[] = []
    for (let s = 0; s < N; s++) {
      let value: number | null = null
      const BACKOFF = [5000, 10000, 20000, 40000, 60000]
      for (let attempt = 1; attempt <= 6 && value === null; attempt++) {
        let content = ""
        try {
          let streamError: Error | null = null
          await new Promise<void>((resolve) => {
            void streamChat(
              measureLlm,
              [{ role: "user", content: `${prompt}\n\n只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。` }] as any,
              { onToken: (t: string) => { content += t }, onDone: () => resolve(), onError: (e: Error) => { streamError = e; resolve() } } as any,
              AbortSignal.timeout(300000),
              { temperature: 0.4, max_tokens: 4000 } as any,
            )
          })
          if (streamError) throw streamError
          const raw = extractScore(content)
          if (raw !== null && !Number.isNaN(raw)) value = raw > 10.5 ? raw / 10 : raw
        } catch { /* retry */ }
        if (value === null && attempt <= BACKOFF.length) await new Promise((r) => setTimeout(r, BACKOFF[attempt - 1]))
      }
      scores.push(value)
      console.log(`[ch${ch}-rewrite/${dim}/s${s}] score=${value}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
    const valid = scores.filter((v): v is number => v !== null)
    dimMedians[dim as string] = valid.length ? median(valid) : null
  }
  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  const pactDrop = typeof dimMedians.pacing === "number" && typeof s1dim.pacing === "number"
    ? s1dim.pacing - (dimMedians.pacing as number)
    : null
  const keep = overall !== null && overall >= holds[ch] && (pactDrop === null || pactDrop < 0.3)
  armsOut[`ch${ch}`] = {
    withFullText, hold: holds[ch], s1dimMedians: s1dim,
    rewriteDimMedians: dimMedians, overall, pacingDrop: pactDrop,
    keep, draftChars: draft.length, draftHead: draft.slice(0, 400),
  }
  save()
  console.log(`[ch${ch}] overall=${overall} hold=${holds[ch]} pacingDrop=${pactDrop} keep=${keep} — 已落盘`)
}
console.log("S2 DONE")
