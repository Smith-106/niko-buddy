#!/usr/bin/env node
/**
 * Headless thril-only smoke: production-shaped pack + literary gold block + real LLM.
 * Loads STEP0_* from env or QMAI/.env.test.local (same keys as step0-ab-calibration.real-llm).
 *
 * Usage (from QMAI/):
 *   node scripts/smoke-thril-gold-llm.mjs \
 *     --pack ../.workflow/harvest-staging/fixtures-ch4-gold-pack-20260809/context-pack.ch4.json \
 *     --chapter-file "E:/写作/8人/.novel/chapters/4/draft.md" \
 *     --project "E:/写作/8人" \
 *     --out ../.workflow/harvest-staging/step0-ab-results-ch4-gold-thril-smoke.json \
 *     [--samples 1]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

// load .env.test.local
const envPath = resolve(__dirname, "../.env.test.local")
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(k in process.env)) process.env[k] = v
  }
}

const KEY = process.env.STEP0_REAL_LLM_KEY || ""
const BASE = process.env.STEP0_REAL_LLM_BASE || ""
const MODEL = process.env.STEP0_REAL_LLM_MODEL || "claude-sonnet-4-6"
const samples = Math.min(5, Math.max(1, Number(arg("samples", process.env.STEP0_SAMPLES || "1")) || 1))

const packPath = resolve(arg("pack"))
const chapterFile = resolve(arg("chapter-file"))
const project = resolve(arg("project", "E:/写作/8人"))
const out = resolve(arg("out", "../.workflow/harvest-staging/step0-ab-results-ch4-gold-thril-smoke.json"))

if (!KEY || !BASE || !existsSync(packPath) || !existsSync(chapterFile)) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing KEY/BASE or pack/chapter-file",
    hasKey: Boolean(KEY),
    hasBase: Boolean(BASE),
    pack: packPath,
    chapterFile,
  }, null, 2))
  process.exit(2)
}

const pack = JSON.parse(readFileSync(packPath, "utf8"))
const chapterText = readFileSync(chapterFile, "utf8").replace(/^\uFEFF/, "")
const goldPath = resolve(project, ".novel/literary-gold-anchors.json")
const gold = existsSync(goldPath) ? JSON.parse(readFileSync(goldPath, "utf8")) : { anchors: [] }
const thrilAnchors = (gold.anchors || []).filter(
  (a) => a.dimension === "thrill" && a.status === "human_confirmed" && String(a.text || "").length >= 20,
)

function formatGoldBlock(anchors, max = 3) {
  if (!anchors.length) return "【文学金标量程 · thril · 非产品硬门】\n金标未就绪"
  const lines = anchors.slice(0, max).map((a, i) => {
    const t = a.text.length > 280 ? `${a.text.slice(0, 280)}…` : a.text
    return `${i + 1}. [target≈${a.targetScore}|human_confirmed] ${t}`
  })
  return [
    "【文学金标 thril 量程参照 · human_confirmed · 非产品硬门】",
    "以下片段代表人类认可的约 9+ / 9–10 档，仅作量程锚，不得把 thril/overall≥9 写成产品硬门。",
    ...lines,
  ].join("\n")
}

const goldBlock = formatGoldBlock(thrilAnchors)
const body = chapterText.length > 12000
  ? `${chapterText.slice(0, 5000)}\n\n[中段省略]\n\n${chapterText.slice(-5000)}`
  : chapterText

const prompt = [
  `任务：${pack.task || "六维审查"}`,
  `章目标：${pack.chapterGoal || ""}`,
  `大纲摘录：\n${String(pack.outline || "").slice(0, 4000)}`,
  `角色状态：\n${String(pack.characterStates || "").slice(0, 2500)}`,
  Array.isArray(pack.temporalFacts) && pack.temporalFacts.length
    ? `时间线事实（${pack.temporalFacts.length}）：\n${pack.temporalFacts.slice(0, 12).map((f) => `- ${f.subject}${f.predicate || ""}${f.object || ""} @ch${f.validFrom}`).join("\n")}`
    : "时间线事实：（空）",
  "六维独立审查维度：爽感密度（thril）",
  "评分量程 0-10。9-10=可发表文学质量。Track B only，非产品硬门。",
  goldBlock,
  "只输出最终 JSON：{\"score\":0.0,\"status\":\"...\",\"summary\":\"...\",\"issues\":[]}",
  "章节正文：",
  body,
].join("\n\n")

async function oneCall(sample) {
  const url = BASE.replace(/\/$/, "") + "/chat/completions"
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      max_tokens: 2000,
      messages: [
        { role: "user", content: `${prompt}\n\n[sample ${sample}] 只输出 JSON。` },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  let content = ""
  try {
    const j = JSON.parse(text)
    content = j.choices?.[0]?.message?.content || j.output_text || text
  } catch {
    content = text
  }
  const m = String(content).match(/"score"\s*:\s*([\d.]+)/)
  const raw = m ? Number(m[1]) : NaN
  const score = Number.isFinite(raw) ? (raw > 10.5 ? raw / 10 : raw) : null
  return { score, content: String(content).slice(0, 4000) }
}

const scores = []
const errors = []
const samplesOut = []
for (let i = 0; i < samples; i++) {
  try {
    const r = await oneCall(i)
    samplesOut.push(r)
    scores.push(r.score)
    console.error(`[thril/s${i}] score=${r.score}`)
  } catch (e) {
    errors.push(String(e?.message || e))
    scores.push(null)
    console.error(`[thril/s${i}] error`, e?.message || e)
  }
}

const valid = scores.filter((v) => typeof v === "number" && Number.isFinite(v))
const sorted = [...valid].sort((a, b) => a - b)
const median = sorted.length
  ? (sorted.length % 2 ? sorted[(sorted.length - 1) >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
  : null

const report = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  base: BASE,
  samples,
  label: "ch4-gold-pack-thril-smoke",
  productHardGate: false,
  pack: {
    path: packPath,
    characterStateChars: String(pack.characterStates || "").length,
    temporalFactsCount: Array.isArray(pack.temporalFacts) ? pack.temporalFacts.length : 0,
  },
  gold: {
    thrilHumanConfirmed: thrilAnchors.length,
    promptContains文学金标: prompt.includes("文学金标"),
    promptContainsHumanConfirmed: prompt.includes("human_confirmed"),
    promptChars: prompt.length,
  },
  results: {
    thrill: {
      new: scores,
      newMedian: median,
      errors,
    },
  },
  samplesDetail: samplesOut.map((s) => ({ score: s.score, contentHead: s.content.slice(0, 500) })),
  ch4DebtPolicy: {
    priorTrueProdThrillMedian: 7.8,
    action: "observe_continue",
    note: "Smoke N=1 not seal-grade N≥5; keep literary_debt open/observe unless full N5 under locked packHash",
  },
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(report, null, 2), "utf8")
console.log(JSON.stringify({
  ok: valid.length > 0,
  out,
  thrilScores: scores,
  thrilMedian: median,
  goldInPrompt: report.gold.promptContains文学金标,
  packTemporal: report.pack.temporalFactsCount,
  packCharacterChars: report.pack.characterStateChars,
  errors,
}, null, 2))
process.exit(valid.length > 0 ? 0 : 3)
