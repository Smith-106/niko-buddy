#!/usr/bin/env node
/**
 * Export a production-shaped ContextPack from project disk WITHOUT Tauri.
 *
 * Full app `buildContextPack` uses invoke(read_file/searchWiki). Headless
 * agents cannot call Tauri. This exporter rebuilds the same *shape* and the
 * draft-first prior path that production uses when snapshots/wiki are thin:
 *   - outlines (Chapter-N-Outline-FILLED.md + optional .novel)
 *   - recent chapter draft excerpts + previousChapterEnding tail
 *   - style-exemplars.json top-K
 *   - character pages under QM/
 *   - FIX-1 canon rules
 *
 * Provenance is recorded in pack.gaps so scores are never silently compared
 * to offline-minimal fixtures as if identical.
 *
 * Usage (from QMAI/):
 *   node scripts/export-production-context-pack.mjs \
 *     --project "E:/写作/8人" --chapter 4 \
 *     --out "../.workflow/harvest-staging/.../context-pack.ch4.json"
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { dirname, resolve, join } from "node:path"

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

const project = arg("project")
const chapter = Number(arg("chapter", "0"))
const out = arg("out")
const task = arg("task", chapter ? `六维审查第${chapter}章（true-prod disk pack）` : "六维审查")

if (!project || !out || !Number.isFinite(chapter) || chapter <= 0) {
  console.error(`Usage: node scripts/export-production-context-pack.mjs --project <path> --chapter <n> --out <pack.json>`)
  process.exit(1)
}

const root = resolve(project)
const gaps = []

function readText(path, label) {
  try {
    if (!existsSync(path)) {
      gaps.push({ source: label, reason: "missing" })
      return ""
    }
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "")
  } catch (e) {
    gaps.push({ source: label, reason: String(e?.message || e) })
    return ""
  }
}

function stripFm(body) {
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3)
    if (end !== -1) return body.slice(end + 4).trim()
  }
  return body.trim()
}

function excerptChapter(body, max = 6000, head = 2200, tail = 3200) {
  const n = body.trim()
  if (n.length <= max) return n
  return `${n.slice(0, head).trimEnd()}\n\n[章节正文中段已按上下文预算省略]\n\n${n.slice(-tail).trimStart()}`
}

// Outlines
const outlineParts = []
for (let n = 1; n <= Math.max(chapter, 6); n++) {
  const p = join(root, `Chapter-${n}-Outline-FILLED.md`)
  const t = readText(p, `outline-ch${n}`)
  if (t) outlineParts.push(`## 第${n}章纲要\n${t.slice(0, n === chapter ? 8000 : 2500)}`)
}
const outline = outlineParts.join("\n\n") || "（无章纲文件）"

// Chapter goal from ch outline head
const chOutline = readText(join(root, `Chapter-${chapter}-Outline-FILLED.md`), `outline-focus-ch${chapter}`)
const chapterGoal = chOutline
  ? `第${chapter}章目标（摘自 FILLED 纲要前段）：\n${chOutline.slice(0, 600)}`
  : `第${chapter}章目标：见大纲。`

// Recent drafts 1..chapter-1
const recentChapterContents = []
const recentSummaries = []
for (let n = Math.max(1, chapter - 3); n < chapter; n++) {
  const raw = stripFm(readText(join(root, ".novel", "chapters", String(n), "draft.md"), `draft-ch${n}`))
  if (!raw) continue
  recentChapterContents.push(`## 第${n}章正文片段\n${excerptChapter(raw)}`)
  recentSummaries.push(`第${n}章摘要（draft head）：${raw.slice(0, 400).replace(/\s+/g, " ")}…`)
}

// previous ending
let previousChapterEnding = ""
if (chapter > 1) {
  const prev = stripFm(readText(join(root, ".novel", "chapters", String(chapter - 1), "draft.md"), `draft-ch${chapter - 1}-ending`))
  if (prev) previousChapterEnding = prev.slice(-1200)
}

// Character pages under QM/
const characterBits = []
const qm = join(root, "QM")
if (existsSync(qm)) {
  for (const name of readdirSync(qm)) {
    if (!name.endsWith(".md")) continue
    const t = readText(join(qm, name), `QM/${name}`)
    if (t) characterBits.push(`### ${name.replace(/\.md$/, "")}\n${t.slice(0, 1500)}`)
  }
} else {
  gaps.push({ source: "QM/", reason: "missing" })
}

// Prefer structured character-states.json (seed/ingest) before QM pages
let structuredCharacterStates = ""
const charStatePath = join(root, ".novel", "character-states.json")
const charStateRaw = readText(charStatePath, "character-states.json")
if (charStateRaw) {
  try {
    const store = JSON.parse(charStateRaw)
    const chars = Array.isArray(store?.characters) ? store.characters : []
    structuredCharacterStates = chars
      .map((c) => {
        const name = c.characterName || c.name || "?"
        const loc = c.currentLocation || "?"
        const status = c.status || ""
        const eq = Array.isArray(c.equipment) ? c.equipment.join("、") : ""
        return `- ${name}：位于${loc}，状态：${status}${eq ? `，装备：${eq}` : ""}`
      })
      .join("\n")
  } catch (e) {
    gaps.push({ source: "character-states.json", reason: `parse: ${e.message}` })
  }
}

// Snapshot-derived characterStateChanges (committed seed/ingest path)
const snapDir = join(root, ".novel", "snapshots")
const snapshotFiles = existsSync(snapDir)
  ? readdirSync(snapDir).filter((n) => n.endsWith(".snapshot.json")).sort()
  : []
const snapshotCharacterLines = []
const temporalFacts = []
const activeFromSnaps = new Set()
for (const fname of snapshotFiles) {
  try {
    const s = JSON.parse(readFileSync(join(snapDir, fname), "utf8"))
    const chN = Number(s.chapterNumber) || 0
    if (Array.isArray(s.characterStateChanges)) {
      for (const line of s.characterStateChanges) {
        if (line) snapshotCharacterLines.push(`第${chN}章：${line}`)
      }
    }
    if (Array.isArray(s.characters)) {
      for (const n of s.characters) if (n) activeFromSnaps.add(String(n))
    }
    // Mirror factsFromCommittedSnapshots shape for headless export (newCanonFacts)
    if (Array.isArray(s.newCanonFacts)) {
      s.newCanonFacts.forEach((raw, idx) => {
        if (!raw || !String(raw).trim()) return
        const trimmed = String(raw).trim()
        let subject = trimmed.slice(0, 20)
        let predicate = ""
        let object = ""
        const colon = trimmed.match(/^(.+?)[:：]\s*(.+)$/)
        if (colon) {
          subject = colon[1].trim()
          predicate = "是"
          object = colon[2].trim()
        }
        temporalFacts.push({
          id: `fact-ch${chN}-${idx}`,
          subject,
          predicate,
          object,
          validFrom: chN,
          source: `chapter-${chN}`,
        })
      })
    }
  } catch (e) {
    gaps.push({ source: fname, reason: `snapshot parse: ${e.message}` })
  }
}
if (snapshotFiles.length === 0) {
  gaps.push({ source: "snapshots/", reason: "empty — temporalFacts will be empty until seed/ingest" })
}

const characterStates = [
  structuredCharacterStates,
  snapshotCharacterLines.slice(-30).join("\n"),
  characterBits.join("\n\n"),
].filter((s) => s && String(s).trim()).join("\n\n") || "（无 character-states / snapshots / QM 角色页）"

// Style exemplars
let styleExemplars = []
const exPath = join(root, ".novel", "style-exemplars.json")
const exRaw = readText(exPath, "style-exemplars.json")
if (exRaw) {
  try {
    const parsed = JSON.parse(exRaw)
    const list = Array.isArray(parsed) ? parsed : (parsed.exemplars || parsed.items || [])
    // diversity pick top 6 by markType
    const byType = new Map()
    for (const item of list) {
      if (!item || !item.text) continue
      const mt = item.markType || "style"
      if (!byType.has(mt)) byType.set(mt, [])
      byType.get(mt).push(item)
    }
    const picked = []
    for (const [, arr] of byType) {
      if (picked.length >= 6) break
      picked.push(arr[0])
    }
    for (const item of list) {
      if (picked.length >= 6) break
      if (!picked.includes(item) && item.text) picked.push(item)
    }
    styleExemplars = picked.slice(0, 6).map((e) => ({
      exemplarId: e.exemplarId || e.id || "EX",
      chapterId: e.chapterId || "",
      text: String(e.text).slice(0, 2000),
      markType: e.markType || "style",
      createdAt: e.createdAt || new Date().toISOString(),
      note: e.note,
    }))
  } catch (e) {
    gaps.push({ source: "style-exemplars.json", reason: `parse: ${e.message}` })
  }
}

// Soul / writing style soft
const soulDoc = readText(join(root, "swarm-analysis-report.md"), "soul-proxy").slice(0, 800)
  || "悬疑、克制、现实压力、Draft-first。"

const pack = {
  task,
  chapterGoal,
  outline,
  recentChapterContents,
  recentSummaries,
  previousChapterEnding,
  characterStates,
  soulDoc: soulDoc || "项目灵魂：悬疑、克制。",
  characterAuras: characterBits.slice(0, 2).join("\n") || "",
  cognitionStates: "",
  foreshadowingStates: "数人头习惯、姐姐的教导、工牌编号、自投/清理规则（延迟揭露）。",
  timeline: `当前审查第${chapter}章；前情为第1–${Math.max(0, chapter - 1)}章 draft-first。`,
  relatedSettings: "无窗会议室、环形桌、大屏幕投票、平板黑料。",
  canonRules: "FIX-1：不得提前揭露 Offer / 最终存活者 / 机制名；Consistency > Anti-AI > Quality。",
  writingStyle: "悬疑、短句、画面感；Show don't tell。",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "评估 thril/pull/pacing 与 Track A 相关维；不得因文学分判产品 FAIL。",
  mustAvoid: "跨模型对照；截断窗结案；overall≥9 硬门；机制说明书。",
  nextChapterAdvice: "",
  revisionDirectives: "",
  gaps: [
    {
      source: "export-production-context-pack",
      reason: "headless disk rebuild of production-shaped pack; no Tauri invoke/searchWiki",
    },
    ...gaps,
  ],
  styleExemplars,
  temporalFacts,
  activeEntities: (() => {
    const names = activeFromSnaps.size
      ? [...activeFromSnaps]
      : characterBits.map((b, i) => b.match(/^### (.+)$/m)?.[1] || `entity-${i}`)
    return names.map((name) => ({
      entityId: name,
      name,
      type: "character",
      tags: ["relevance:high"],
    }))
  })(),
}

const outPath = resolve(out)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(pack, null, 2), "utf8")
console.log(JSON.stringify({
  ok: true,
  out: outPath,
  chapter,
  outlineChars: outline.length,
  recentChapters: recentChapterContents.length,
  previousEndingChars: previousChapterEnding.length,
  exemplars: styleExemplars.length,
  characterBlocks: characterBits.length,
  characterStateChars: characterStates.length,
  temporalFactsCount: temporalFacts.length,
  snapshotFiles: snapshotFiles.length,
  gaps: pack.gaps.length,
}, null, 2))
