// L9 S3 第二轮：thrill 专攻改写（用户 2026-10-28 授权）。ch2 / ch36 各 1 稿 + N=5 复测。
//
// 背景：S2 两章 keep=true 但均 8.9 未过 9.0 线，最弱维 thrill（ch2 5.5 / ch36 7.3）。
//       S2 未落盘全文稿 → S3 无法在 S2 稿上续改，改为原章全文 + S2 dim 诊断重写，且本轮全文落盘供人工通读。
// Draft-first：只取 runDeepChapterGeneration 返回的 draftContent/finalContent；
//   不调用 batchAccept、不写 wiki/chapters、不 ingest。
// 口径：生成 reasoning auto；复测与 S1/S2 同（muse auto，temp 0.4 / max_tokens 4000 / 6 次退避）。
// Keep 门（相对 S2 稿，更严）：overall ≥ max(S1 hold, S2 overall) 且 thrill > S2 thrill
//   且 pacing 相对 S2 跌幅 < 0.3。达 9.0 另记 sealPass。
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-s3-run.json
//       ../.workflow/harvest-staging/l9-s3-drafts/ch{NNN}-s3.md（全文，供人工通读）
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const S1 = "../.workflow/harvest-staging/quality-gate-97-l9-s1.json"
const S2 = "../.workflow/harvest-staging/quality-gate-97-l9-s2-run.json"
const OUT = "../.workflow/harvest-staging/quality-gate-97-l9-s3-run.json"
const DRAFT_DIR = "../.workflow/harvest-staging/l9-s3-drafts"
const MODEL = process.env.L9_S1_MODEL ?? "muse-spark-1.3-contributor"
const N = 5
const SEAL = 9.0
const CHAPTERS = (process.env.L9_S3_CHAPTERS ?? "2,36").split(",").map((s) => Number(s.trim())).filter((n) => n > 0)

// 单例锁（mtime 心跳制），锁名独立。
const LOCK = join(tmpdir(), "l9-s3.lock")
const LOCK_TTL_MS = 120000
function lockFresh(): boolean {
  try { return Date.now() - statSync(LOCK).mtimeMs < LOCK_TTL_MS } catch { return false }
}
if (lockFresh()) {
  console.error("另一 S3 实例仍在运行（锁在 120s 内刷新过），拒绝启动。")
  process.exit(3)
}
writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`)
const heartbeat = setInterval(() => { try { writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`) } catch { /* ignore */ } }, 30000)
process.on("exit", () => { clearInterval(heartbeat); try { unlinkSync(LOCK) } catch { /* ignore */ } })

for (const f of [S1, S2]) {
  if (!existsSync(f)) { console.error(`前置产物缺失：${f}，拒绝执行（不消耗 LLM）。`); process.exit(2) }
}
const s1 = JSON.parse(readFileSync(S1, "utf8"))
const s2 = JSON.parse(readFileSync(S2, "utf8"))
type Dims = Record<string, number>
const plan: Record<number, { s1Hold: number; s2Overall: number; s2Dims: Dims; gate: number }> = {}
for (const ch of CHAPTERS) {
  const s1o = s1.results?.[`ch${ch}`]?.overall
  const arm = s2.arms?.[`ch${ch}`]
  const s2o = arm?.overall
  const s2d = arm?.rewriteDimMedians as Dims | undefined
  if (typeof s1o !== "number" || typeof s2o !== "number" || !s2d || typeof s2d.thrill !== "number" || typeof s2d.pacing !== "number") {
    console.error(`ch${ch} 缺 S1 overall 或 S2 overall/dim（thrill/pacing），拒绝执行。`)
    process.exit(2)
  }
  plan[ch] = { s1Hold: s1o, s2Overall: s2o, s2Dims: s2d, gate: Math.max(s1o, s2o) }
}
console.log(`S3 计划：${JSON.stringify(plan)}`)

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

mkdirSync(DRAFT_DIR, { recursive: true })
const out: Record<string, unknown> = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : { generatedAt: new Date().toISOString(), arms: {} }
Object.assign(out, {
  purpose: "L9 S3 第二轮 thrill 专攻改写 + N=5 复测（muse 口径，Keep 门相对 S2 稿）",
  model: MODEL,
})
const armsOut = out.arms as Record<string, unknown>
function save() {
  ;(out as any).updatedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n")
}

const THRILL_BRIEF = [
  "【本轮唯一主攻：thrill（爽点/张力）】其余五维已 ≥8.6，只许持平不许回落。",
  "- 爽点当章兑现：本章承诺的反击/打脸/破局必须在本章内落地，禁止把兑现留给下一章（已知系统病因：thrill 兑现后置）。",
  "- 开篇 300 字内压上可感代价（主角在意之物 / 生死 / 身份暴露），不写长说明、不铺设定。",
  "- 主角主动下注：至少一次主角自担风险的主动选择，直接造成局面反转；反转后代价当场可见。",
  "- 压抑→释放只走一条主链：新增 stakes 必须替换旧 stakes，不叠倒计时/窗口悬念（防 pacing 回落）。",
  "- 禁复读 refrain（咬舌/用同意/撕开它/根在更深 等高频句式不得循环出现）；禁外语、繁体、说书腔。",
  "- 章末钩：落在下一阶段具体期待上，不提前揭机制名。",
  "- 篇幅与原章相当（lengthPreserving），不得照抄原文句子。",
].join("\n")

for (const ch of CHAPTERS) {
  const p = plan[ch]
  const fields = resolveResidualCampaignFields({
    enabled: true,
    chapterNumber: ch,
    config: { residualCampaignOverallMedian: p.gate, residualCampaignDimMedians: p.s2Dims } as any,
  })
  const full = stripFrontmatter(readFileSync(`${PROJECT}/QM/chapters/chapter-${String(ch).padStart(3, "0")}.md`, "utf8"))
  const userRequest = [
    `【L9 S3 第二轮改写任务书】第 ${ch} 章`,
    `S1 hold：${p.s1Hold}；S2 改写稿 overall：${p.s2Overall}（未达 ${SEAL}）`,
    `S2 改写稿 dim 中位：${JSON.stringify(p.s2Dims)}`,
    `改写模式：structure_thril_pacing + lengthPreserving（thril emphasis）`,
    "",
    THRILL_BRIEF,
    "",
    `【原章全文参照（改写锚点，不得照抄）】`,
    full,
  ].join("\n")

  console.log(`[ch${ch}] S3 生成开始（${userRequest.length}ch，gate=${p.gate}）…`)
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
    armsOut[`ch${ch}`] = { status: "generation-incomplete", partial: gen.partial, draftChars: draft.length, ...p }
    save()
    continue
  }
  const draftPath = `${DRAFT_DIR}/ch${String(ch).padStart(3, "0")}-s3.md`
  writeFileSync(draftPath, draft + "\n")

  useWikiStore.setState({ novelMode: true, llmConfig: measureLlm, novelConfig } as any)
  const pack = await buildContextPack(PROJECT, `L9-S3 第${ch}章改写稿`, ch, {
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
      console.log(`[ch${ch}-s3/${dim}/s${s}] score=${value}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
    const valid = scores.filter((v): v is number => v !== null)
    dimMedians[dim as string] = valid.length ? median(valid) : null
  }
  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  const thrill = dimMedians.thrill
  const pacing = dimMedians.pacing
  // 正值 = 相对 S2 稿下跌
  const pacingDropVsS2 = typeof pacing === "number" ? p.s2Dims.pacing - pacing : null
  const thrillGainVsS2 = typeof thrill === "number" ? thrill - p.s2Dims.thrill : null
  const keep = overall !== null && overall >= p.gate
    && thrillGainVsS2 !== null && thrillGainVsS2 > 0
    && (pacingDropVsS2 === null || pacingDropVsS2 < 0.3)
  const sealPass = overall !== null && overall >= SEAL
  armsOut[`ch${ch}`] = {
    ...p, rewriteDimMedians: dimMedians, overall,
    thrillGainVsS2, pacingDropVsS2, keep, sealPass,
    draftChars: draft.length, draftPath,
  }
  save()
  console.log(`[ch${ch}] overall=${overall} gate=${p.gate} thrillGain=${thrillGainVsS2} pacingDrop=${pacingDropVsS2} keep=${keep} sealPass=${sealPass} — 已落盘`)
}
console.log("S3 DONE")
clearInterval(heartbeat)
process.exit(0)
