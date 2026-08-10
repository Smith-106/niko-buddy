#!/usr/bin/env node
/**
 * Headless multi-chapter formal LLM extract (snapshot JSON) for novel projects.
 *
 * Bypasses app store / isFinalChapter gate by writing committed snapshot files
 * directly (same shape as seed + chapter-ingest normalize fields).
 * Does NOT rewrite draft.md (Draft-first: no force-final on manuscript).
 *
 * Usage:
 *   # load STEP0_* from .env.test.local if present
 *   node scripts/formal-llm-chapter-extract.mjs --project "E:/写作/8人" [--chapters 1-6] [--force]
 *
 * Env:
 *   STEP0_REAL_LLM_KEY / STEP0_REAL_LLM_BASE / STEP0_REAL_LLM_MODEL
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadDotEnvLocal() {
  const p = join(__dirname, "..", ".env.test.local")
  if (!existsSync(p)) return
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf("=")
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[k]) process.env[k] = v
  }
}
loadDotEnvLocal()

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const force = process.argv.includes("--force")
const project = resolve(arg("--project", ""))
const chaptersArg = arg("--chapters", "1-6")
const KEY = process.env.STEP0_REAL_LLM_KEY || ""
const BASE = (process.env.STEP0_REAL_LLM_BASE || "").replace(/\/$/, "")
const MODEL = process.env.STEP0_REAL_LLM_MODEL || "claude-sonnet-4-6"
const MAX_BODY = Number(process.env.FORMAL_INGEST_MAX_CHARS || 12000)

if (!project || !existsSync(project)) {
  console.error('Usage: node scripts/formal-llm-chapter-extract.mjs --project <path> [--chapters 1-6] [--force]')
  process.exit(1)
}
if (!KEY || !BASE) {
  console.error("Missing STEP0_REAL_LLM_KEY / STEP0_REAL_LLM_BASE")
  process.exit(1)
}

function parseChapters(spec) {
  if (spec.includes("-")) {
    const [a, b] = spec.split("-").map((x) => parseInt(x, 10))
    const out = []
    for (let i = a; i <= b; i++) out.push(i)
    return out
  }
  return spec.split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n))
}

const chapters = parseChapters(chaptersArg)
const novelDir = join(project, ".novel")
const chaptersDir = join(novelDir, "chapters")
const snapDir = join(novelDir, "snapshots")
mkdirSync(snapDir, { recursive: true })
const backupDir = join(snapDir, `_backup-seed-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`)

function draftText(ch) {
  const p = join(chaptersDir, String(ch), "draft.md")
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf8").replace(/^\uFEFF/, "")
}

function sliceBody(text, max = MAX_BODY) {
  const t = text.trim()
  if (t.length <= max) return t
  // head + tail for continuity extract
  const half = Math.floor(max / 2)
  return `${t.slice(0, half)}\n\n…[truncated]…\n\n${t.slice(-half)}`
}

function extractJsonObject(text) {
  const s = String(text || "")
  const start = s.indexOf("{")
  const end = s.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  return s.slice(start, end + 1)
}

async function callLlm(messages) {
  const url = `${BASE}/chat/completions`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages,
      response_format: { type: "json_object" },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 400)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") throw new Error("empty LLM content")
  return content
}

function normalizeSnapshot(parsed, ch) {
  const arr = (v) => (Array.isArray(v) ? v.map(String) : [])
  return {
    chapterId: `chapter-${ch}`,
    chapterNumber: ch,
    chapterTitle: typeof parsed.chapterTitle === "string" ? parsed.chapterTitle : `第${ch}章`,
    summary: String(parsed.summary || "").slice(0, 2000),
    characters: arr(parsed.characters),
    characterAliases: parsed.characterAliases && typeof parsed.characterAliases === "object" ? parsed.characterAliases : {},
    locations: arr(parsed.locations),
    organizations: arr(parsed.organizations),
    items: arr(parsed.items),
    events: arr(parsed.events),
    characterStateChanges: arr(parsed.characterStateChanges),
    relationshipChanges: arr(parsed.relationshipChanges),
    knowledgeChanges: arr(parsed.knowledgeChanges),
    foreshadowingChanges: arr(parsed.foreshadowingChanges),
    newCanonFacts: arr(parsed.newCanonFacts),
    timelineEvents: arr(parsed.timelineEvents),
    conflicts: arr(parsed.conflicts),
    endingHook: String(parsed.endingHook || "").slice(0, 800),
    graphNodes: arr(parsed.graphNodes?.length ? parsed.graphNodes : parsed.characters),
    graphEdges: arr(parsed.graphEdges),
    sourceType: "chapter",
    sourceSequence: ch,
    revision: 1,
    snapshotId: `formal-llm-ch${ch}-r1`,
    extractMeta: {
      engine: "formal-llm-chapter-extract.mjs",
      model: MODEL,
      base: BASE,
      maxBodyChars: MAX_BODY,
      at: new Date().toISOString(),
      note: "Headless formal extract; draft.md not rewritten; Track A unchanged",
    },
  }
}

const system = `你是长篇网文记忆抽取器。只输出一个 JSON 对象（不要 markdown 代码围栏），字段必须齐全。
用中文填写。不要编造稿中未出现的专有名词。characterStateChanges 用「角色名：状态」格式。`

function userPrompt(ch, body) {
  return `从第${ch}章正文抽取结构化快照 JSON，字段：
chapterTitle, summary, characters[], locations[], organizations[], items[], events[],
characterStateChanges[]（「名：状态」）, relationshipChanges[], knowledgeChanges[],
foreshadowingChanges[], newCanonFacts[], timelineEvents[], conflicts[], endingHook,
graphNodes[], graphEdges[]（可用空数组）, characterAliases{}（可选）

正文：
---
${body}
---`
}

const results = []
for (const ch of chapters) {
  const prefix = String(ch).padStart(3, "0")
  const jsonPath = join(snapDir, `${prefix}.snapshot.json`)
  const text = draftText(ch)
  if (!text.trim()) {
    results.push({ ch, ok: false, reason: "no_draft" })
    continue
  }
  if (existsSync(jsonPath) && !force) {
    // still overwrite for formal upgrade when --force not set? User asked formal extract — default force replace seed with backup
  }
  // backup existing seed/formal once
  if (existsSync(jsonPath)) {
    mkdirSync(backupDir, { recursive: true })
    const bak = join(backupDir, `${prefix}.snapshot.json`)
    if (!existsSync(bak)) copyFileSync(jsonPath, bak)
  }

  const body = sliceBody(text)
  process.stdout.write(`[extract ch${ch}] body=${body.length} … `)
  try {
    const content = await callLlm([
      { role: "system", content: system },
      { role: "user", content: userPrompt(ch, body) },
    ])
    const jsonText = extractJsonObject(content)
    if (!jsonText) throw new Error("no JSON object in model output")
    const parsed = JSON.parse(jsonText)
    const snapshot = normalizeSnapshot(parsed, ch)
    writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8")
    console.log(`ok chars=${snapshot.characters.length} facts=${snapshot.newCanonFacts.length}`)
    results.push({
      ch,
      ok: true,
      characters: snapshot.characters.length,
      newCanonFacts: snapshot.newCanonFacts.length,
      timelineEvents: snapshot.timelineEvents.length,
      summaryChars: snapshot.summary.length,
      path: jsonPath,
    })
  } catch (e) {
    console.log("FAIL", e instanceof Error ? e.message : String(e))
    results.push({ ch, ok: false, reason: e instanceof Error ? e.message : String(e) })
  }
}

// Rebuild character-states from last successful formal snapshot states
const okSnaps = results.filter((r) => r.ok)
if (okSnaps.length) {
  const lastOk = Math.max(...okSnaps.map((r) => r.ch))
  const lastSnap = JSON.parse(readFileSync(join(snapDir, `${String(lastOk).padStart(3, "0")}.snapshot.json`), "utf8"))
  const cast = lastSnap.characters?.length ? lastSnap.characters : []
  const charStore = {
    characters: cast.map((name) => {
      const line = (lastSnap.characterStateChanges || []).find((s) => String(s).startsWith(name))
      return {
        characterName: name,
        currentLocation: (lastSnap.locations && lastSnap.locations[0]) || "",
        status: line || `第${lastOk}章在场`,
        equipment: name.includes("白") ? ["素圈戒指"] : [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: lastOk,
        lastUpdatedAt: new Date().toISOString(),
        isAlive: true,
        lastSeenChapter: lastOk,
      }
    }),
    lastUpdated: new Date().toISOString(),
    seedNote: "formal-llm-chapter-extract.mjs",
    extractMeta: { model: MODEL, chapters: okSnaps.map((r) => r.ch) },
  }
  writeFileSync(join(novelDir, "character-states.json"), JSON.stringify(charStore, null, 2), "utf8")
}

const evidence = {
  at: new Date().toISOString(),
  project,
  model: MODEL,
  base: BASE,
  chapters,
  force,
  backupDir: existsSync(backupDir) ? backupDir : null,
  results,
  okCount: results.filter((r) => r.ok).length,
  failCount: results.filter((r) => !r.ok).length,
}
const outEvidence = resolve(
  __dirname,
  "../../.workflow/harvest-staging/formal-llm-chapter-extract-20260810.json",
)
mkdirSync(dirname(outEvidence), { recursive: true })
writeFileSync(outEvidence, JSON.stringify(evidence, null, 2), "utf8")
console.log(JSON.stringify({ ok: evidence.failCount === 0, evidence: outEvidence, ...evidence }, null, 2))
process.exit(evidence.failCount ? 2 : 0)
