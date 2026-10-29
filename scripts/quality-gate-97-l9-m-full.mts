// L9 M 档全书基线：162 章（chapter_status=final）× 全维 × N=5 = 4860 calls
//
// 章单：全书 ch1-ch162。ch163-ch170 的 chapter_status=planned（仅大纲占位，无正文），
// 不纳入 L9 评分——对占位文本打六维分没有意义，历史 baseline 同样是 162 章。
// 口径（L9_S1_MODEL 环境覆盖，缺省 muse-spark）：
// - muse-spark = Oct-10 基线同一口径（U2 跨口径差天然消除）；
//   deepseek 池 429 配额冷却中（见 blocker doc §十三），待恢复后可选跑对照。
// - 原中转端点曾全线 503，已于 2026-10-28 弃用，不再作为口径候选。
// 断点续跑：每章完成后落盘，重启自动跳过已有 overall 的章。
// 并发：维度 × 采样池化执行（6 × 5 = 30 任务，12 路池）。实测 16 路全 200。
// 单章 440s（纯串行）→ 约 90-130s。章与章之间仍串行（每章要重新 buildContextPack）。
// 预计：4860 calls / 约 4-6 小时（原串行版约 40 小时）。
// 运行: npx tsx --import ./scripts/node-fs-register.mjs scripts/quality-gate-97-l9-m-full.mts
// 产物: ../.workflow/harvest-staging/quality-gate-97-l9-m-full.json
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmConfig, NovelConfig } from "../src/stores/wiki-store.ts"

// 单例锁（mtime 心跳制，免疫 pid 复用）：holder 每 30s 刷新 mtime；
// contender 见 mtime 在 120s 内 → 有活锁，exit 3；否则接管。
// 教训（§十八）：kill wrapper 后 node 子进程变幽灵 + 手动 rm 锁会破坏互斥，
// 且 pidfile 在 pid 复用下会 TOCTOU 误判。永远不要手动删锁，让 mtime 语义处理一切。
const LOCK = join(tmpdir(), "l9-m-full.lock")
const LOCK_TTL_MS = 120000
function lockFresh(): boolean {
  try {
    const st = statSync(LOCK)
    return Date.now() - st.mtimeMs < LOCK_TTL_MS
  } catch { return false }
}
if (lockFresh()) {
  console.error(`另一 M 档实例仍在运行（锁 ${LOCK} 在 ${LOCK_TTL_MS / 1000}s 内刷新过），拒绝启动。先 kill 干净再跑。`)
  process.exit(3)
}
writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`)
const heartbeat = setInterval(() => { try { writeFileSync(LOCK, `${process.pid}\n${new Date().toISOString()}\n`) } catch { /* ignore */ } }, 30000)
process.on("exit", () => { clearInterval(heartbeat); try { unlinkSync(LOCK) } catch { /* ignore */ } })

const PROJECT = "C:/QM-BOOK/身体都是租的，你让我修仙？"
const PROJECT_ID = "508dafa6-8006-4f6a-9219-10a58fb5e14c"
const CHAPTERS = Array.from({ length: 162 }, (_, i) => i + 1)
const SAMPLES = 5
const MODEL = process.env.L9_M_MODEL ?? "muse-spark-1.3-contributor"
const isDeepSeek = /deepseek/i.test(MODEL)
// 换模型必须换产物：同一份报告不能混模型。L9_M_OUT 缺省沿用原路径（零行为变更）。
const OUT = process.env.L9_M_OUT ?? "../.workflow/harvest-staging/quality-gate-97-l9-m-full.json"

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

// 防污染：已有产物若出自别的模型，直接拒绝续跑。
// 此前这里会把 j.model 悄悄改写成当前 MODEL——148 章 muse-spark 的分数就会被
// 贴上另一个模型的标签，且这些章因「已有 overall」被跳过，等于把两个评分器混进一份报告。
if (existsSync(OUT)) {
  const prior = JSON.parse(readFileSync(OUT, "utf8"))
  const hasScores = Object.values(prior.results ?? {}).some((r: any) => typeof r?.overall === "number")
  if (hasScores && prior.model && prior.model !== MODEL) {
    console.error(
      `FATAL: ${OUT} 已有 ${prior.model} 的分数，当前 MODEL=${MODEL}。
` +
        `换模型必须换产物：请设置 L9_M_OUT 指向新文件，禁止混模型。`,
    )
    process.exit(2)
  }
}

const out: Record<string, unknown> = existsSync(OUT)
  ? (() => { const j = JSON.parse(readFileSync(OUT, "utf8")); j.model = MODEL; j.purpose = `L9 M 档全书基线：162 章 × 全维 × N=5（${MODEL} 口径，与 2026-10-10 baseline 逐章可比）`; j.resumedAt = new Date().toISOString(); return j })()
  : {
      generatedAt: new Date().toISOString(),
      purpose: `L9 M 档全书基线：162 章 × 全维 × N=5（${MODEL} 口径，与 2026-10-10 baseline 逐章可比）`,
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
// 冒烟用：L9_M_ONLY="2,36" 只跑指定章。缺省不过滤（零行为变更）。
const ONLY = process.env.L9_M_ONLY ? new Set(process.env.L9_M_ONLY.split(",").map((x) => Number(x.trim()))) : null
for (const ch of CHAPTERS) {
  if (ONLY && !ONLY.has(ch)) continue
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

  // 并发池：维度 × 采样 = 6 × 5 = 30 个任务，用 CONCURRENCY 路池化执行。
  // 实测 16 路全 200（墙钟 17.7s）；取 12 路留限流余量。
  // 单章串行版 440s → 池化版约 90-130s。
  const CONCURRENCY = Number(process.env.L9_M_CONCURRENCY ?? 12)
  const DIMS = SIX_REVIEW_DIMENSION_ORDER as (keyof typeof SIX_REVIEW_DIMENSIONS)[]
  const BACKOFF = [5000, 10000, 20000, 40000, 60000]

  // 终态错误：重试不会改变结果，只会白烧退避时间。典型是模型被网关下线
  // （HTTP 400 "unknown provider for model X"）、凭据失效、模型名写错。
  // 2026-10-29 实测：muse-spark-1.3-contributor 被网关下线后，脚本按 6 次退避
  // 空转，3 章就烧掉 546 次重试与数小时。终态错误必须立刻中止整轮。
  const TERMINAL_ERROR_RE = /unknown provider for model|invalid_request_error|HTTP (400|401|403)|invalid api.?key|model not found|no such model/i
  let terminalError: string | null = null

  type Task = { dim: string; s: number }
  const tasks: Task[] = []
  for (const dim of DIMS) for (let s = 0; s < SAMPLES; s++) tasks.push({ dim: dim as string, s })

  const prompts = new Map<string, string>()
  const fingerprints = new Map<string, string>()
  for (const dim of DIMS) {
    const prompt = buildDimensionReviewPrompt(pack, chapterText, SIX_REVIEW_DIMENSIONS[dim])
    prompts.set(dim as string, prompt)
    const protocol = createLiteraryExperimentProtocol({
      model: llmConfig.model || "unknown",
      samples: SAMPLES,
      label: `gate97-l9-m-ch${ch}-${dim}`,
      notes: ["Track L9 M-full; muse-spark caliber; N=5"],
    })
    fingerprints.set(dim as string, buildMeasurementFingerprint({
      protocol, pack, chapterText, packKind: "app-runtime-six-dimension",
    }))
  }

  const collected = new Map<string, { s: number; value: number | null; lastErr: string }[]>()

  async function runTask(task: Task): Promise<void> {
    const { dim, s } = task
    const prompt = prompts.get(dim)!
    let value: number | null = null
    let lastErr = ""
    for (let attempt = 1; attempt <= 6 && value === null; attempt++) {
      let content = ""
      try {
        let streamError: Error | null = null
        await new Promise<void>((resolve) => {
          void streamChat(
            llmConfig,
            [{ role: "user", content: `${prompt}

只输出最终 JSON 对象（含 score、status、summary、issues），不要输出解释。` }] as any,
            {
              onToken: (t: string) => { content += t },
              onDone: () => resolve(),
              onError: (e: Error) => { streamError = e; resolve() },
            } as any,
            AbortSignal.timeout(300000),
            { temperature: 0.4, max_tokens: 16000 } as any,
          )
        })
        if (streamError) throw streamError
        const rawScore = extractScore(content)
        if (rawScore !== null && !Number.isNaN(rawScore)) value = rawScore > 10.5 ? rawScore / 10 : rawScore
        else lastErr = `no score(${content.length}ch): ${content.slice(0, 120).replace(/\n/g, " ")}`
      } catch (e) { lastErr = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : String(e).slice(0, 160) }
      // 终态错误立刻记下并跳出重试循环（不再退避）
      if (value === null && TERMINAL_ERROR_RE.test(lastErr)) {
        terminalError = lastErr
        console.log(`[ch${ch}/${dim}/s${s}] TERMINAL error, aborting run: ${lastErr.slice(0, 140)}`)
        break
      }
      if (value === null && attempt <= BACKOFF.length) {
        console.log(`[ch${ch}/${dim}/s${s}] attempt${attempt} failed, retry in ${BACKOFF[attempt - 1] / 1000}s: ${lastErr.slice(0, 100)}`)
        await new Promise((r) => setTimeout(r, BACKOFF[attempt - 1]))
      }
    }
    const arr = collected.get(dim) ?? []
    arr.push({ s, value, lastErr })
    collected.set(dim, arr)
    doneCalls++
    console.log(`[ch${ch}/${dim}/s${s}] score=${value}${value === null ? ` ERR:${lastErr}` : ""} (累计 ${doneCalls}/4860)`)
  }

  // 池化执行
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (true) {
      if (terminalError) break
      const idx = cursor++
      if (idx >= tasks.length) break
      await runTask(tasks[idx])
    }
  })
  await Promise.all(workers)

  // 终态错误：不写该章的无效结果，直接以非零码退出，让调用方看到真实原因。
  // 已完成的章保持落盘，续跑时自动跳过。
  if (terminalError) {
    save()
    console.error(`FATAL: 不可重试的错误，已中止。${terminalError}`)
    console.error('已完成的章保留在产物中；修复模型/凭据后重跑会自动续跑。')
    try { unlinkSync(LOCK) } catch { /* 锁已不存在 */ }
    process.exit(2)
  }

  for (const dim of DIMS) {
    const arr = (collected.get(dim as string) ?? []).slice().sort((a, b) => a.s - b.s)
    const scores: (number | null)[] = arr.map((x) => x.value)
    const errors: string[] = arr.filter((x) => x.value === null).map((x) => `[ch${ch}/${dim}/s${x.s}] no score after retries: ${x.lastErr}`)
    const valid = scores.filter((v): v is number => v !== null)
    const med = valid.length ? median(valid) : null
    dimMedians[dim as string] = med
    dimResults[dim as string] = { scores, median: med, measurementFingerprint: fingerprints.get(dim as string), errors }
  }

  const medVals = Object.values(dimMedians).filter((v): v is number => v !== null)
  const overall = medVals.length === 6 ? median(medVals) : null
  results[`ch${ch}`] = {
    dimensions: dimResults,
    dimensionMedians: dimMedians,
    overall,
    pass: overall !== null && overall >= 9.0,
    judgeModel: MODEL,
  }
  save()
  console.log(`[ch${ch}] overall=${overall} pass=${overall !== null && overall >= 9.0} — 已落盘`)
}

console.log(JSON.stringify({ overall: Object.fromEntries(Object.entries(results).map(([k, v]: [string, any]) => [k, v.overall])) }, null, 1))
clearInterval(heartbeat)
process.exit(0)
