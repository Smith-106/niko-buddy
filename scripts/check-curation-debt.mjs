#!/usr/bin/env node
// check-curation-debt.mjs — R1-d 策展闸门 IO 采集层（生成器管线接入点）。
//
// 共识来源：批准计划 r2 §R1-d，planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113。
//
// 两层门禁分工（同 R-1 先例）：本脚本 = IO 采集层（读全字段视图产物 / 组装批次 /
// 汇总债分）；纯函数判定核 = src/lib/novel/curation-gate.ts（scoreCurationBatch，
// 零 IO 可单测）。本脚本内嵌等价计债镜像（.mjs 无法 import TS），每次运行先做
// 字面同步自检：从 TS 源读上限/权重/最短摘要/必填字段，与本脚本常量逐项比对，
// 不一致即 exit 3 拒跑（防两层漂移——改一处须改另一处）。
//
// 用法：node scripts/check-curation-debt.mjs [--source <path>] [--json]
//   默认源优先级：--source > ../reference/REFERENCE-KB-VIEW.json（hub 全量面，
//   含 summary/contentDigest）> 仓内 fixture src/lib/novel/__fixtures__/reference-kb-view.content-*.json。
// 退出码：0 债分在上限内；2 债分超限（打印发现项）；3 自检/采集失败。
// ASCII only 输出（防 PS 乱码）；只读断言，不改任何产物。

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// ============================================================================
// 镜像常量（同步点：须与 src/lib/novel/curation-gate.ts 字面一致）
// ============================================================================

const CURATION_DEBT_CAP = 0
const CURATION_DEBT_WEIGHTS = {
  missing_field: 2,
  no_provenance: 1,
  short_summary: 1,
  theme_vacant: 3,
  collection_vacant: 3,
}
const CURATION_MIN_SUMMARY_CHARS = 50
const CURATION_REQUIRED_FIELDS = [
  "name",
  "collection",
  "title",
  "lang",
  "domain",
  "query_intent",
  "trust",
  "summary",
]

/** 门禁期望面（题材@collection 粒度 + collection；与 curation-gate.spec 真实产物面同口径）。 */
const EXPECT_THEMES = [
  { theme: "克苏鲁", collections: ["world_ref"] },
  { theme: "修仙", collections: ["world_ref", "lexicon"] },
  // B5-a 多流派扩容（批准计划 r3 §T1）：新流派题材@collection 同口径门禁
  { theme: "奇幻", collections: ["world_ref", "lexicon"] },
  { theme: "武侠", collections: ["world_ref", "lexicon"] },
  { theme: "科幻", collections: ["world_ref", "lexicon"] },
]
const EXPECT_COLLECTIONS = ["world_ref", "lexicon", "craft", "corpus"]
const WRITING_COLLECTIONS = EXPECT_COLLECTIONS

// ============================================================================
// 字面同步自检（防两层漂移）
// ============================================================================

function selfCheck() {
  const problems = []
  const src = readFileSync(join(ROOT, "src", "lib", "novel", "curation-gate.ts"), "utf8")
  const num = (name) => {
    const m = src.match(new RegExp(`export const ${name} = (\\d+)`))
    return m ? Number(m[1]) : null
  }
  if (num("CURATION_DEBT_CAP") !== CURATION_DEBT_CAP) {
    problems.push(`CURATION_DEBT_CAP 漂移：ts=${num("CURATION_DEBT_CAP")} mjs=${CURATION_DEBT_CAP}`)
  }
  if (num("CURATION_MIN_SUMMARY_CHARS") !== CURATION_MIN_SUMMARY_CHARS) {
    problems.push(
      `CURATION_MIN_SUMMARY_CHARS 漂移：ts=${num("CURATION_MIN_SUMMARY_CHARS")} mjs=${CURATION_MIN_SUMMARY_CHARS}`,
    )
  }
  for (const [reason, weight] of Object.entries(CURATION_DEBT_WEIGHTS)) {
    const m = src.match(new RegExp(`${reason}:\\s*(\\d+)`))
    const tsWeight = m ? Number(m[1]) : null
    if (tsWeight !== weight) {
      problems.push(`权重漂移 ${reason}：ts=${tsWeight} mjs=${weight}`)
    }
  }
  const reqBlock = src.match(/CURATION_REQUIRED_FIELDS = \[([\s\S]*?)\] as const/)
  const tsFields = reqBlock
    ? [...reqBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : []
  if (tsFields.join(",") !== CURATION_REQUIRED_FIELDS.join(",")) {
    problems.push(`必填字段漂移：ts=${tsFields.join(",")} mjs=${CURATION_REQUIRED_FIELDS.join(",")}`)
  }
  return problems
}

// ============================================================================
// 计债镜像（与 curation-gate.ts scoreCurationBatch 等价）
// ============================================================================

const isEmpty = (v) =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim().length === 0) ||
  (Array.isArray(v) && v.length === 0)

function scoreBatch(entries) {
  const findings = []
  for (const entry of entries) {
    const label = entry.name || "(unnamed)"
    const missing = CURATION_REQUIRED_FIELDS.filter((f) => isEmpty(entry[f]))
    if (missing.length > 0) {
      findings.push({
        reason: "missing_field",
        debt: CURATION_DEBT_WEIGHTS.missing_field,
        name: label,
        detail: `missing ${missing.join("/")}`,
      })
    }
    const upstream = String(entry.upstream ?? "").trim()
    const digest = String(entry.contentDigest ?? "").trim()
    if ((upstream.length === 0 || upstream === "UNKNOWN") && !digest.startsWith("sha256-")) {
      findings.push({
        reason: "no_provenance",
        debt: CURATION_DEBT_WEIGHTS.no_provenance,
        name: label,
        detail: "no provenance (upstream UNKNOWN/empty and no contentDigest)",
      })
    }
    const summary = String(entry.summary ?? "").trim()
    if (summary.length > 0 && summary.length < CURATION_MIN_SUMMARY_CHARS) {
      findings.push({
        reason: "short_summary",
        debt: CURATION_DEBT_WEIGHTS.short_summary,
        name: label,
        detail: `summary ${summary.length} < ${CURATION_MIN_SUMMARY_CHARS}`,
      })
    }
  }
  for (const collection of EXPECT_COLLECTIONS) {
    if (!entries.some((e) => (e.collection || "") === collection)) {
      findings.push({
        reason: "collection_vacant",
        debt: CURATION_DEBT_WEIGHTS.collection_vacant,
        target: collection,
        detail: `collection vacant: ${collection}`,
      })
    }
  }
  const scoped = entries.filter((e) => EXPECT_COLLECTIONS.includes(e.collection || ""))
  for (const scope of EXPECT_THEMES) {
    for (const collection of scope.collections) {
      const hit = scoped.some((e) => {
        if ((e.collection || "") !== collection) return false
        return [e.name || "", e.title || "", (e.domain || []).join(" "), e.summary || ""]
          .join(" ")
          .toLowerCase()
          .includes(scope.theme.toLowerCase())
      })
      if (!hit) {
        findings.push({
          reason: "theme_vacant",
          debt: CURATION_DEBT_WEIGHTS.theme_vacant,
          target: `${scope.theme}@${collection}`,
          detail: `theme vacant: ${scope.theme} in ${collection}`,
        })
      }
    }
  }
  return { totalDebt: findings.reduce((s, f) => s + f.debt, 0), findings, entryCount: entries.length }
}

// ============================================================================
// 采集层
// ============================================================================

function parseArgs(argv) {
  const opts = { source: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") opts.source = argv[++i]
    else if (argv[i] === "--json") opts.json = true
  }
  return opts
}

function resolveSource(explicit) {
  if (explicit) {
    const p = resolve(process.cwd(), explicit)
    return existsSync(p) ? p : null
  }
  const hub = resolve(ROOT, "..", "reference", "REFERENCE-KB-VIEW.json")
  if (existsSync(hub)) return hub
  const dir = join(ROOT, "src", "lib", "novel", "__fixtures__")
  if (!existsSync(dir)) return null
  const hit = readdirSync(dir).find((f) => f.startsWith("reference-kb-view.content-"))
  return hit ? join(dir, hit) : null
}

function collectEntries(view, sourcePath) {
  const collections = view.collections ?? {}
  const out = []
  if (view.entries && Array.isArray(view.entries)) {
    // fixture 形态：条目已展平且带 collection
    for (const e of view.entries) {
      if (WRITING_COLLECTIONS.includes(e.collection)) out.push(e)
    }
    return out
  }
  for (const [collection, list] of Object.entries(collections)) {
    if (!WRITING_COLLECTIONS.includes(collection)) continue
    for (const entry of list) out.push({ ...entry, collection })
  }
  return out
}

function main(argv) {
  const opts = parseArgs(argv)
  const problems = selfCheck()
  if (problems.length > 0) {
    process.stderr.write(`[curation-debt] SELF-CHECK FAILED (ts/mjs drift):\n`)
    for (const p of problems) process.stderr.write(`  - ${p}\n`)
    return 3
  }
  const sourcePath = resolveSource(opts.source)
  if (!sourcePath) {
    process.stderr.write(`[curation-debt] source unreadable (hub view and fixture both missing)\n`)
    return 3
  }
  let view
  try {
    view = JSON.parse(readFileSync(sourcePath, "utf8"))
  } catch (err) {
    process.stderr.write(`[curation-debt] parse failed: ${sourcePath} (${err?.message ?? err})\n`)
    return 3
  }
  const entries = collectEntries(view, sourcePath)
  if (entries.length === 0) {
    process.stderr.write(`[curation-debt] no entries collected from ${sourcePath}\n`)
    return 3
  }
  const score = scoreBatch(entries)
  const withinCap = score.totalDebt <= CURATION_DEBT_CAP
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          source: sourcePath,
          builtFrom: view.builtFrom ?? null,
          entryCount: score.entryCount,
          totalDebt: score.totalDebt,
          cap: CURATION_DEBT_CAP,
          withinCap,
          findings: score.findings,
        },
        null,
        2,
      ) + "\n",
    )
  }
  if (!withinCap) {
    process.stderr.write(
      `[curation-debt] OVER CAP: debt=${score.totalDebt} > cap=${CURATION_DEBT_CAP} ` +
        `(${score.entryCount} entries, ${sourcePath})\n`,
    )
    for (const f of score.findings.slice(0, 40)) {
      process.stderr.write(`  - [${f.reason}+${f.debt}] ${f.target ?? f.name ?? "-"}: ${f.detail}\n`)
    }
    if (score.findings.length > 40) {
      process.stderr.write(`  ... ${score.findings.length - 40} more findings\n`)
    }
    return 2
  }
  if (!opts.json) {
    process.stdout.write(
      `[curation-debt] PASS: debt=${score.totalDebt} <= cap=${CURATION_DEBT_CAP} ` +
        `entries=${score.entryCount} builtFrom=${view.builtFrom ?? "n/a"}\n`,
    )
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
