#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * 50ch-telemetry.js — T34 哨兵硬化：50 章 telemetry 汇总（TASK-P6-34）。
 *
 * 职责:
 *   以「墙钟全角色计入口径」（BudgetCounters 同口径：全部角色绑定调用时长求和，
 *   非单角色、非阶段最大值）汇总 50 章生成的逐章实测数据，对照三张哨兵表：
 *     1. A/B 门槛④：章级全角色墙钟 ≤45min；
 *     2. per-stage 墙钟预算分配表（装配3/拆解2/brief2/draft20/review10/
 *        revision5/gate1/缓冲2 分钟，可被 --budgets 校准覆盖）；
 *     3. 分角色 token 预算（软警告/硬封顶档位校准输入）。
 *
 * 输入格式（JSONL，每行一条 role_call 记录，字段缺省按 0 计）:
 *   {"type":"role_call","chapter":7,"role":"writer","stage":"write_draft",
 *    "wallclockMs":81234,"promptTokens":12000,"completionTokens":3000,"ts":"2026-08-22T00:00:00Z"}
 *
 * 用法:
 *   node scripts/50ch-telemetry.js                          # 扫 <cwd>/.novel/telemetry/*.jsonl
 *   node scripts/50ch-telemetry.js --input a.jsonl --input b.jsonl
 *   node scripts/50ch-telemetry.js --project /path/to/novel # 换项目根扫默认目录
 *   node scripts/50ch-telemetry.js --budgets budgets.json   # 校准覆盖 per-stage 表(分钟)
 *   node scripts/50ch-telemetry.js --json out.json          # 追加落盘聚合 JSON
 *   node scripts/50ch-telemetry.js --help
 *
 * 执行纪律:
 *   - ADR-19 机械层零 LLM / 零网络：只读本地文件，纯算术聚合。
 *   - F-34 隐私开关（本地匿名 + 默认关 + 显式同意）：本脚本不做任何自动采集与上传；
 *     仅聚合用户显式指定的本地 JSONL；输出不含正文内容，仅含计数与时延数字。
 *   - EXIT 纪律：无输入/未超预算 → EXIT 0；超预算项打印 OVER 行供人工判读
 *     （诊断工具不挡流程；--strict 时存在 OVER 则 EXIT 2，供 CI 选配）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import {
  DEFAULT_TOKEN_HARD_CAP_TOKENS,
  DEFAULT_TOKEN_SOFT_WARN_TOKENS,
  PER_STAGE_WALLCLOCK_BUDGETS_MIN,
  WALLCLOCK_BUDGET_PER_CHAPTER_MS,
  applyStageBudgetOverrides,
  compareStageBudgets,
  checkChapterWallclockGate,
} from "../src/lib/novel/budget-counters.ts"

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url))

function parseArgs(argv) {
  const args = { inputs: [], project: null, budgets: null, json: null, strict: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") args.help = true
    else if (a === "--strict") args.strict = true
    else if (a === "--input" || a === "-i") args.inputs.push(resolve(argv[++i]))
    else if (a === "--project" || a === "-p") args.project = resolve(argv[++i])
    else if (a === "--budgets" || a === "-b") args.budgets = resolve(argv[++i])
    else if (a === "--json" || a === "-j") args.json = resolve(argv[++i])
    else {
      console.error(`[50ch-telemetry] unknown arg: ${a} (--help for usage)`)
      process.exit(64)
    }
  }
  return args
}

/** 收集待读文件：显式 --input 优先；否则扫 <project>/.novel/telemetry/*.jsonl。 */
function collectInputFiles(args) {
  if (args.inputs.length > 0) return args.inputs.filter((f) => existsSync(f))
  const root = args.project ?? process.cwd()
  const dir = join(root, ".novel", "telemetry")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
}

/** 解析 JSONL：坏行跳过并计数（容错，不阻断汇总）。 */
function parseRecords(file) {
  const records = []
  let badLines = 0
  const raw = readFileSync(file, "utf8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec && rec.type === "role_call") records.push(rec)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

/** 全角色口径聚合：chapter → {wallclockMs, stages{}, roles{}}。 */
function aggregate(records) {
  const chapters = new Map()
  for (const rec of records) {
    const chapter = num(rec.chapter)
    const key = String(chapter)
    if (!chapters.has(key)) {
      chapters.set(key, { chapter, wallclockMs: 0, calls: 0, stages: new Map(), roles: new Map() })
    }
    const ch = chapters.get(key)
    // 全角色口径：每条角色绑定调用的墙钟直接累加（BudgetCounters.recordRoleCall 同语义）。
    ch.wallclockMs += num(rec.wallclockMs)
    ch.calls += 1
    const stage = typeof rec.stage === "string" && rec.stage ? rec.stage : "(unknown)"
    ch.stages.set(stage, (ch.stages.get(stage) ?? 0) + num(rec.wallclockMs))
    const role = typeof rec.role === "string" && rec.role ? rec.role : "(unknown)"
    if (!ch.roles.has(role)) {
      ch.roles.set(role, { promptTokens: 0, completionTokens: 0, totalTokens: 0, wallclockMs: 0 })
    }
    const r = ch.roles.get(role)
    r.promptTokens += num(rec.promptTokens)
    r.completionTokens += num(rec.completionTokens)
    r.totalTokens += num(rec.promptTokens) + num(rec.completionTokens)
    r.wallclockMs += num(rec.wallclockMs)
  }
  return [...chapters.values()].sort((a, b) => a.chapter - b.chapter)
}

const fmtMin = (ms) => `${(ms / 60000).toFixed(2)}min`

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("usage: node scripts/50ch-telemetry.js [--input f.jsonl]... [--project path] [--budgets f.json] [--json out.json] [--strict]")
    console.log("input record: {\"type\":\"role_call\",\"chapter\":n,\"role\":r,\"stage\":s,\"wallclockMs\":ms,\"promptTokens\":p,\"completionTokens\":c}")
    return 0
  }

  // 校准覆盖（--budgets）：JSON 对象 stage -> 分钟（部分覆盖，非法值忽略——applyStageBudgetOverrides 语义）。
  let table = applyStageBudgetOverrides()
  if (args.budgets) {
    const overrides = JSON.parse(readFileSync(args.budgets, "utf8"))
    table = applyStageBudgetOverrides(overrides)
    console.log(`[50ch-telemetry] calibrated stage budgets applied from ${args.budgets}`)
  }

  const files = collectInputFiles(args)
  /** @type {{records:any[], badLines:number, file:string}[]} */
  const parsed = files.map((f) => ({ file: f, ...parseRecords(f) }))
  const records = parsed.flatMap((p) => p.records)
  const badLines = parsed.reduce((a, p) => a + p.badLines, 0)

  console.log("== 50ch telemetry summary ==")
  console.log(`[privacy:F-34] local-only aggregation, anonymous counters, opt-in by explicit --input/--project; no upload.`)
  console.log(`[input] files=${files.length} role_call_records=${records.length} skipped_lines=${badLines}`)
  if (files.length === 0) {
    console.log("[note] no telemetry input found (default scan: <cwd>/.novel/telemetry/*.jsonl). nothing to aggregate.")
    console.log("[result] PASS (empty dataset)")
    return 0
  }

  const chapters = aggregate(records)
  let overs = 0

  // 1) 章级 A/B 门槛④：全角色累计墙钟 <=45min/章。
  console.log(`\n-- chapter wallclock gate (all-role sum, budget=${fmtMin(WALLCLOCK_BUDGET_PER_CHAPTER_MS)}) --`)
  for (const ch of chapters) {
    const gate = checkChapterWallclockGate(ch.wallclockMs)
    const flag = gate.pass ? "ok" : "OVER"
    if (!gate.pass) overs += 1
    console.log(
      `ch${String(ch.chapter).padStart(3)} wallclock=${fmtMin(gate.wallclockMs)} calls=${ch.calls} [${flag}]`
        + (gate.pass ? "" : ` overBy=${fmtMin(gate.overByMs)}`),
    )
  }

  // 2) per-stage 预算比对（跨章合计 vs 分配表；校准覆盖后口径）。
  console.log("\n-- per-stage budgets (aggregate across chapters) --")
  const stageTotals = new Map()
  for (const ch of chapters) {
    for (const [stage, ms] of ch.stages) stageTotals.set(stage, (stageTotals.get(stage) ?? 0) + ms)
  }
  const measured = [...stageTotals].map(([stage, durationMs]) => ({ stage, durationMs }))
  const checks = compareStageBudgets(measured, table)
  for (const c of checks.sort((a, b) => a.stage.localeCompare(b.stage))) {
    const tag = c.unknownStage ? "UNBUDGETED" : c.status === "over" ? "OVER" : "ok"
    if (tag !== "ok") overs += 1
    console.log(
      `${c.stage.padEnd(18)} measured=${fmtMin(c.durationMs)} budget=${c.unknownStage ? "-" : fmtMin(c.budgetMs)} [${tag}]`
        + (c.overByMs > 0 ? ` overBy=${fmtMin(c.overByMs)}` : ""),
    )
  }
  console.log(
    `table_total_min=${Object.values(table).reduce((a, b) => a + b, 0)} (blueprint initial=${Object.values(PER_STAGE_WALLCLOCK_BUDGETS_MIN).reduce((a, b) => a + b, 0)})`,
  )

  // 3) 分角色 token 汇总（软警告/硬封顶档位校准输入；默认档为占位值）。
  console.log("\n-- per-role tokens (calibration input for soft/hard caps) --")
  const roleAgg = new Map()
  for (const ch of chapters) {
    for (const [role, r] of ch.roles) {
      if (!roleAgg.has(role)) roleAgg.set(role, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
      const a = roleAgg.get(role)
      a.promptTokens += r.promptTokens
      a.completionTokens += r.completionTokens
      a.totalTokens += r.totalTokens
    }
  }
  for (const [role, r] of [...roleAgg].sort((a, b) => a[0].localeCompare(b[0]))) {
    const flags = [
      r.totalTokens > DEFAULT_TOKEN_SOFT_WARN_TOKENS ? "soft-warn-range" : "",
      r.totalTokens > DEFAULT_TOKEN_HARD_CAP_TOKENS ? "hard-cap-range" : "",
    ].filter(Boolean).join("|")
    console.log(
      `${role.padEnd(10)} prompt=${r.promptTokens} completion=${r.completionTokens} total=${r.totalTokens}`
        + ` (defaults soft=${DEFAULT_TOKEN_SOFT_WARN_TOKENS} hard=${DEFAULT_TOKEN_HARD_CAP_TOKENS})`
        + (flags ? ` [${flags}]` : ""),
    )
  }
  console.log("[note] role token flags are calibration hints only; hard-cap enforcement lives in BudgetCounters.evaluateTokenGate.")

  if (args.json) {
    const payload = {
      schemaVersion: "50ch-telemetry/1.0",
      generatedAt: new Date().toISOString(),
      inputFiles: files,
      recordsCount: records.length,
      skippedLines: badLines,
      wallclockBudgetPerChapterMs: WALLCLOCK_BUDGET_PER_CHAPTER_MS,
      stageBudgetTableMin: table,
      chapters: chapters.map((ch) => ({
        chapter: ch.chapter,
        wallclockMs: ch.wallclockMs,
        calls: ch.calls,
        stages: Object.fromEntries(ch.stages),
        roles: Object.fromEntries([...ch.roles].map(([k, v]) => [k, v])),
      })),
      overCount: overs,
    }
    writeFileSync(args.json, JSON.stringify(payload, null, 2))
    console.log(`\n[json] aggregate written to ${args.json}`)
  }

  console.log(`\n[result] ${overs === 0 ? "PASS" : `${overs} over-budget finding(s)`}${args.strict && overs > 0 ? " (strict exit 2)" : ""}`)
  return args.strict && overs > 0 ? 2 : 0
}

// 入口：main() 抛错如实非零退出（EXIT 纪律），不粉饰。
try {
  process.exit(main())
} catch (error) {
  console.error(`[50ch-telemetry] FAILED: ${error?.message ?? error}`)
  process.exit(1)
}
