#!/usr/bin/env node
/**
 * Seed committed chapter snapshots for projects with drafts but empty
 * `.novel/snapshots/` so temporalFacts + characterStates can be non-empty
 * without full LLM ingest.
 *
 * Usage:
 *   node scripts/seed-committed-snapshots-from-drafts.mjs --project "E:/写作/8人" [--force]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const force = process.argv.includes("--force")
const project = resolve(arg("--project", ""))
if (!project || !existsSync(project)) {
  console.error("Usage: node scripts/seed-committed-snapshots-from-drafts.mjs --project <path> [--force]")
  process.exit(1)
}

const novelDir = join(project, ".novel")
const chaptersDir = join(novelDir, "chapters")
const snapDir = join(novelDir, "snapshots")
mkdirSync(snapDir, { recursive: true })

function listChapterNumbers() {
  if (!existsSync(chaptersDir)) return []
  return readdirSync(chaptersDir)
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
}

function draftText(ch) {
  const p = join(chaptersDir, String(ch), "draft.md")
  if (!existsSync(p)) return ""
  return readFileSync(p, "utf8").replace(/^\uFEFF/, "")
}

function excerptEnding(text, max = 400) {
  const t = text.trim()
  if (t.length <= max) return t
  return t.slice(-max)
}

function summaryFrom(text, max = 280) {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** Heuristic cast for 8人-like casts; empty-safe for other projects. */
const KNOWN = [
  "白砚",
  "李昭然",
  "陈烬",
  "陆织锦",
  "苏未晞",
  "王迦",
  "赵默",
  "周屿",
  "潘多拉",
]

function presentNames(text) {
  return KNOWN.filter((n) => text.includes(n))
}

function stateLine(name, ch, text) {
  const bits = [`第${ch}章在场`]
  if (text.includes("投票")) bits.push("参与/目击投票局")
  if (text.includes("清理")) bits.push("清理程序压力可见")
  if (name === "白砚") bits.push("观察者/弃投或信息差持有者倾向")
  if (name === "陈烬" && ch === 1) bits.push("违规后社死清理风险")
  if (name === "李昭然" && ch >= 2) bits.push("自投/出局风险上升")
  if (name === "苏未晞" && ch >= 3) bits.push("最高票未走/门口滞留")
  return `${name}：${bits.join("；")}`
}

function canonFacts(ch, text, names) {
  const facts = []
  facts.push(`地点：无窗会议室（终面密室）`)
  if (text.includes("投票")) facts.push(`规则：票数最高者清理出局`)
  if (text.includes("平板") || text.includes("资料")) facts.push(`物品：每人资料平板可用`)
  if (names.includes("白砚")) facts.push(`白砚：持有姐姐素圈戒指接口线索`)
  if (ch === 1 && text.includes("清理")) facts.push(`陈烬：触发违规清理程序`)
  if (ch === 2 && text.includes("李昭然")) facts.push(`李昭然：第二轮票数最高含自投`)
  if (ch === 3 && text.includes("清理程序")) facts.push(`苏未晞：最高票但清理被暂停`)
  if (ch >= 4) facts.push(`人数：中后轮残局压力上升`)
  return facts
}

const chapters = listChapterNumbers()
const written = []
const skipped = []

for (const ch of chapters) {
  const prefix = String(ch).padStart(3, "0")
  const jsonPath = join(snapDir, `${prefix}.snapshot.json`)
  if (existsSync(jsonPath) && !force) {
    skipped.push(ch)
    continue
  }
  const text = draftText(ch)
  if (!text.trim()) {
    skipped.push(ch)
    continue
  }
  const names = presentNames(text)
  const snapshot = {
    chapterId: `chapter-${ch}`,
    chapterNumber: ch,
    chapterTitle: `第${ch}章`,
    summary: summaryFrom(text),
    characters: names,
    locations: ["无窗会议室"],
    organizations: ["矩阵科技"],
    items: text.includes("平板") ? ["资料平板"] : [],
    events: text.includes("投票") ? ["投票轮次"] : [],
    characterStateChanges: names.map((n) => stateLine(n, ch, text)),
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: canonFacts(ch, text, names),
    timelineEvents: [`第${ch}章：终面流程推进`],
    conflicts: text.includes("投票") ? ["票选清理冲突"] : [],
    endingHook: excerptEnding(text, 220),
    graphNodes: names,
    graphEdges: [],
    sourceType: "chapter",
    sourceSequence: ch,
    revision: 1,
    snapshotId: `seed-ch${ch}-r1`,
  }
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8")
  written.push(ch)
}

// Character states store (for characterStates pack field / continuity)
const charPath = join(novelDir, "character-states.json")
const lastCh = chapters[chapters.length - 1] || 1
const lastText = draftText(lastCh)
const cast = presentNames(lastText).length ? presentNames(lastText) : KNOWN.slice(0, 6)
const charStore = {
  characters: cast.map((name) => ({
    characterName: name,
    currentLocation: "无窗会议室",
    status: stateLine(name, lastCh, lastText),
    equipment: name === "白砚" ? ["素圈戒指"] : [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: lastCh,
    lastUpdatedAt: new Date().toISOString(),
    isAlive: true,
    lastSeenChapter: lastCh,
  })),
  lastUpdated: new Date().toISOString(),
  seedNote: "seed-committed-snapshots-from-drafts.mjs — heuristic seed, not LLM ingest",
}
if (!existsSync(charPath) || force) {
  writeFileSync(charPath, JSON.stringify(charStore, null, 2), "utf8")
}

// Projection ledger: mark snapshot projection committed per chapter
const ledgerPath = join(novelDir, "projection-status.json")
const now = new Date().toISOString()
const chaptersLedger = {}
for (const ch of written.length ? written : chapters) {
  chaptersLedger[String(ch)] = {
    snapshot: {
      projection: "snapshot",
      category: "single_snapshot_idempotent",
      status: "committed",
      updated_at: now,
      last_error: "",
    },
  }
}
const ledger = {
  projections: {
    snapshot: "single_snapshot_idempotent",
    character: "fold_rebuildable",
  },
  chapters: chaptersLedger,
  seedNote: "seed-committed-snapshots-from-drafts.mjs",
}
if (!existsSync(ledgerPath) || force) {
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8")
}

console.log(
  JSON.stringify(
    {
      ok: true,
      project,
      chaptersFound: chapters,
      snapshotsWritten: written,
      snapshotsSkipped: skipped,
      characterStates: charPath,
      projectionLedger: ledgerPath,
      force,
    },
    null,
    2,
  ),
)
