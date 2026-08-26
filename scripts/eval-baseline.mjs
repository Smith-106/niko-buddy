#!/usr/bin/env node
/**
 * eval-baseline.mjs — F2 B 门基线脚本（eval-real-baseline-path.md §2/§4）。
 *
 * 职责:
 *   1. 读 fixtures（manifest.json + cases.jsonl + holdout.jsonl + baseline.json）
 *   2. 跑合成语料基线（eval-corpus-synth 六场景，C8 200 case）
 *      — 合成 assemble：EvalCase → AssembledContextView（gold→protected；former→former）
 *      — 算 L1/L2/L3（C1 阈值 L2≥0.99 > L1≥0.95 > L3<0.01）
 *   3. 与 baseline.json diff（L1 场景降 >1% / L2 毒类降或跌破 0.98 → blocker）
 *   4. 语料缺失显式 SKIP + exit 0 + 告警（C7，禁 synthetic 冒充 real）
 *   5. 输出 JSON 报告（--out 落盘）
 *
 * import 策略（三模型共识裁决：① 自包含镜像 + ③ 选择性直引零依赖叶子）:
 *   - eval/ 内部相对 import 无扩展名（from "./eval-metrics"）→ Node 原生 ESM 无法解析，
 *     整引必 ERR_MODULE_NOT_FOUND（实测否决）；不改产品码前提下不可行。
 *   - C4 digest 复用单一幂等原语 computeCheckpointDigestOf：checkpoint-digest.ts 零相对
 *     依赖（纯 crypto + stableStringify），显式 .ts 扩展名直引（Node ≥23.6 类型剥离默认
 *     开启），忠实 C4 勿另写 SHA-256 封装。
 *   - C8 语料唯一真源 eval-corpus-synth.ts（仅 import type → strip 后零依赖），直引保证
 *     与 TS 侧逐字节一致零漂移。
 *   - PAT-G2 镜像：computeL1/L2/L3/aggregate/layerContainsTriple/isL3CriticalFinding +
 *     合成 assemble。eval/ 对应纯函数变更须同步本脚本（同 calibrate-continuity-
 *     thresholds.mjs 纪律）。
 *
 * 用法:
 *   node scripts/eval-baseline.mjs                       读 baseline.json 做 diff（PASS）
 *   node scripts/eval-baseline.mjs --init                首次建立基线（写 baseline.json）
 *   node scripts/eval-baseline.mjs --out <path>          报告落盘
 *   node scripts/eval-baseline.mjs --fixtures <dir>      指定 fixtures 目录
 *   node scripts/eval-baseline.mjs --help
 *
 * 退出码: 0 = PASS / SKIPPED / BASELINE_ESTABLISHED（C7 语料缺失 SKIP 也 exit 0）；
 *         1 = 阈值 violation / baseline 回归 blocker；2 = 用法/IO 错误。
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
// C4：直引单一幂等原语（checkpoint-digest.ts 零相对依赖，Node 24 类型剥离安全）。
import { computeCheckpointDigestOf } from "../src/lib/novel/checkpoint-digest.ts"
// C8：合成语料唯一真源（仅 import type → strip 后零依赖）。
import { synthCorpus, EVAL_SCENARIOS } from "../src/lib/novel/eval/eval-corpus-synth.ts"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const QMAI_ROOT = resolve(SCRIPT_DIR, "..")
const DEFAULT_FIXTURES = join(QMAI_ROOT, "src", "lib", "novel", "eval", "fixtures")

// C1 阈值（与 eval-metrics.ts DEFAULT_THRESHOLDS 同步；PAT-G2 镜像）
const TH = Object.freeze({ l1Min: 0.95, l2Min: 0.99, l3Max: 0.01 })
const POISON_TYPES = ["contradiction", "temporal_inversion", "former_as_current", "crossbook_leak", "cognition_leak"]

// ──────────────────────────────────────────────────────────────────────────
// PAT-G2 镜像：eval-adapters / eval-metrics 纯函数
// ──────────────────────────────────────────────────────────────────────────

/** 镜像 eval-adapters.ts layerContainsTriple（C5：存在性断言，非 rank）。 */
function layerContainsTriple(layerTexts, subject, predicate, object) {
  return layerTexts.some((t) => t.includes(subject) && t.includes(predicate) && t.includes(object))
}

/** 镜像 eval-adapters.ts isL3CriticalFinding（C3：仅 critical + consistency_mechanical）。 */
function isL3CriticalFinding(f) {
  return f.severity === "critical" && f.subtype === "consistency_mechanical"
}

/** 合成 assemble：EvalCase → AssembledContextView（gold→protected；former_as_current→former；其余毒不落层）。 */
function synthAssemble(caseItem) {
  const protectedCurrent = (caseItem.goldChunks || []).map((g) => `${g.subject} ${g.predicate} ${g.object}`)
  const protectedFormer = (caseItem.poisonChunks || [])
    .filter((p) => p.poisonType === "former_as_current")
    .map((p) => `${p.subject} ${p.predicate} ${p.object}`)
  return { protectedCurrent, protectedFormer, compressible: [], protectedLayerAssembled: true }
}

/** 镜像 eval-metrics.ts computeL1（C5：protected 层存在性命中率，非 rank）。 */
function computeL1(goldChunks, view) {
  if (!view.protectedLayerAssembled) return { layer: "L1", pass: false, score: 0, detail: { reason: "protected layer not assembled" } }
  if (goldChunks.length === 0) return { layer: "L1", pass: true, score: 1, detail: { hits: 0, total: 0 } }
  const hits = goldChunks.filter((g) => layerContainsTriple(view.protectedCurrent, g.subject, g.predicate, g.object)).length
  const score = hits / goldChunks.length
  return { layer: "L1", pass: score >= TH.l1Min, score, detail: { hits, total: goldChunks.length } }
}

/** 镜像 eval-metrics.ts computeL2（毒不得进 protected；former_as_current 允许落 former 层）。 */
function computeL2(poisonChunks, view) {
  if (!view.protectedLayerAssembled) return { layer: "L2", pass: false, score: 0, detail: { reason: "protected layer not assembled" } }
  if (poisonChunks.length === 0) return { layer: "L2", pass: true, score: 1, detail: { leaks: 0, total: 0 } }
  const leaks = poisonChunks.filter((p) => {
    const inProtected = layerContainsTriple(view.protectedCurrent, p.subject, p.predicate, p.object)
    if (!inProtected) return false
    if (p.poisonType === "former_as_current" && p.expectedLanding === "former") {
      return !layerContainsTriple(view.protectedFormer, p.subject, p.predicate, p.object)
    }
    return true
  }).length
  const score = 1 - leaks / poisonChunks.length
  return { layer: "L2", pass: score >= TH.l2Min, score, detail: { leaks, total: poisonChunks.length } }
}

/** 镜像 eval-metrics.ts computeL3（C3：critical + consistency_mechanical 占比；无 findings → 0）。 */
function computeL3(findings) {
  const critical = findings.filter(isL3CriticalFinding)
  const score = findings.length === 0 ? 0 : critical.length / findings.length
  return { layer: "L3", pass: score < TH.l3Max, score, detail: { critical: critical.length, total: findings.length } }
}

/** 镜像 eval-metrics.ts aggregate（A 门：L2≥0.99 > L1≥0.95 > L3<0.01）。 */
function aggregate(l1, l2, l3) {
  const overall = l1.pass && l2.pass && l3.pass
  const verdict = overall
    ? "PASS"
    : [l1.pass ? "" : `L1<${TH.l1Min}`, l2.pass ? "" : `L2<${TH.l2Min}`, l3.pass ? "" : `L3>=${TH.l3Max}`]
        .filter(Boolean).join("; ") || "FAIL"
  return { overall, layers: { L1: l1, L2: l2, L3: l3 }, verdict }
}

/** 镜像 eval-gates.ts evaluateGateA（P0 一致性 L2 优先，Consistency > Anti-AI > Quality）。 */
function evaluateGateA(agg) {
  const reasons = []
  if (!agg.layers.L2.pass) reasons.push(`L2=${agg.layers.L2.score.toFixed(4)} < ${TH.l2Min} (P0 consistency gate)`)
  if (!agg.layers.L1.pass) reasons.push(`L1=${agg.layers.L1.score.toFixed(4)} < ${TH.l1Min}`)
  if (!agg.layers.L3.pass) reasons.push(`L3=${agg.layers.L3.score.toFixed(4)} >= ${TH.l3Max}`)
  return { pass: reasons.length === 0, gate: "A", reasons }
}

// ──────────────────────────────────────────────────────────────────────────
// fixtures 读取 + 场景解析
// ──────────────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return []
  const text = readFileSync(path, "utf8")
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** 场景解析：优先取 case.scenario，否则从 synth id 解析（synth-<scenario>-<seed>）。 */
function scenarioOfCase(c) {
  if (c.scenario) return c.scenario
  const m = String(c.id).match(/^synth-(.+)-(\d+)$/)
  return m ? m[1] : String(c.id)
}

function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
}

function roundMap(m) {
  const out = {}
  for (const [k, v] of Object.entries(m)) out[k] = +v.toFixed(6)
  return out
}

function aggregateLayer(results, layer) {
  if (results.length === 0) return { layer, pass: true, score: 1, detail: { skipped: true } }
  const scores = results.map((r) => r.layers[layer].score)
  const score = scores.reduce((a, b) => a + b, 0) / scores.length
  const pass = results.every((r) => r.layers[layer].pass)
  return { layer, pass, score, detail: { cases: results.length } }
}

// ──────────────────────────────────────────────────────────────────────────
// CLI + 主流程
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { init: false, fixtures: DEFAULT_FIXTURES, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--init") args.init = true
    else if (a === "--help" || a === "-h") args.help = true
    else if (a === "--fixtures") args.fixtures = resolve(process.cwd(), argv[++i] ?? args.fixtures)
    else if (a === "--out") args.out = argv[++i] ?? null
    else {
      process.stderr.write(`[eval-baseline] unknown arg: ${a}\n`)
      args.help = true
    }
  }
  return args
}

const USAGE = `eval-baseline.mjs — QMAI 评测 B 门基线 driver（F2）

用法:
  node scripts/eval-baseline.mjs                       读 baseline.json 做 diff（PASS）
  node scripts/eval-baseline.mjs --init                首次建立基线（写 baseline.json）
  node scripts/eval-baseline.mjs --out <path>          报告落盘
  node scripts/eval-baseline.mjs --fixtures <dir>      指定 fixtures 目录
  node scripts/eval-baseline.mjs --help                本帮助

共识: C1 L2≥0.99>L1≥0.95>L3<0.01 | C4 digest 复用 computeCheckpointDigestOf
      C7 语料缺失显式 SKIP+exit0+告警（禁 synthetic 冒充 real）
      C8 200 case 六场景 + 留出集 15% | C9 replayOnlyFailed（B 门跑全量基线）`

function skippedReport(reason, warnings, source) {
  const report = {
    tool: "eval-baseline",
    generatedAt: new Date().toISOString(),
    status: "SKIPPED",
    source: source ?? "unknown",
    reason,
    warnings,
    layers: null,
    aggregate: null,
    perScenarioL1: {},
    perPoisonL2: {},
    diff: { blockers: [], notes: [] },
    gateA: null,
  }
  process.stderr.write(`[eval-baseline] WARN: ${reason}（C7 显式 SKIP，exit 0，禁 synthetic 冒充）\n`)
  for (const w of warnings) process.stderr.write(`[eval-baseline] WARN: ${w}\n`)
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE + "\n")
    return 0
  }

  const manifestPath = join(args.fixtures, "manifest.json")
  const casesPath = join(args.fixtures, "cases.jsonl")
  const holdoutPath = join(args.fixtures, "holdout.jsonl")
  const baselinePath = join(args.fixtures, "baseline.json")

  if (!existsSync(manifestPath)) {
    return skippedReport("manifest.json 缺失", ["fixtures 目录未找到评测清单，依 C7 显式 SKIP"], "unknown")
  }
  const manifest = readJson(manifestPath)
  const warnings = []

  // C7：real 语料需 F3 真实 assemble 接线（buildContextPack/checkContinuity），纯 node 不支持
  if (manifest.source === "real") {
    return skippedReport(
      "manifest.source=real 但纯 node 脚本无真实 assemble 接线（需 F3 buildContextPack/checkContinuity）",
      ["C7：real 基线门由 eval:l3（REAL_LLM=1）承接，禁 synthetic 冒充；显式 SKIP + exit 0"],
      manifest.source,
    )
  }

  let cases = readJsonl(casesPath)
  // C7：语料整体缺失 → 显式 SKIP + exit 0
  if (cases.length === 0) {
    return skippedReport("cases.jsonl 为空/缺失（语料缺失）", ["C7：绝不静默 PASS，显式 SKIP"], manifest.source)
  }
  // C7：manifest 标 real 却含 synthetic case → 冒充禁止
  if (cases.some((c) => c.source !== "synthetic" && c.source !== manifest.source)) {
    return skippedReport(
      "manifest.source 与 case.source 不一致（疑似 synthetic 冒充 real）",
      ["C7：禁 synthetic 冒充 real，显式 SKIP"],
      manifest.source,
    )
  }

  // C8：synthetic 语料不足 manifest.totalCases 时用生成器补足（唯一真源，零漂移）
  if (cases.length < manifest.totalCases) {
    warnings.push(
      `fixtures cases.jsonl=${cases.length} < manifest.totalCases=${manifest.totalCases}，用 eval-corpus-synth 生成器补足冒烟`,
    )
    const regen = synthCorpus()
    cases = [...regen.cases, ...regen.holdout]
  }

  const holdout = readJsonl(holdoutPath)
  const caseById = new Map(cases.map((c) => [c.id, c]))

  // 逐 case：合成 assemble → L1/L2/L3（合成语料无 L3 信号 → findings=[]）
  const results = []
  for (const c of cases) {
    const view = synthAssemble(c)
    const l1 = computeL1(c.goldChunks || [], view)
    const l2 = computeL2(c.poisonChunks || [], view)
    const l3 = computeL3([])
    results.push({ caseId: c.id, layers: { L1: l1, L2: l2, L3: l3 } })
  }

  const l1 = aggregateLayer(results, "L1")
  const l2 = aggregateLayer(results, "L2")
  const l3 = aggregateLayer(results, "L3")
  const agg = aggregate(l1, l2, l3)
  const gateA = evaluateGateA(agg)

  // 逐场景 L1（C8 六场景分层 diff）
  const perScenarioL1 = {}
  for (const sc of manifest.scenarios || EVAL_SCENARIOS) {
    const inSc = results.filter((r) => scenarioOfCase(caseById.get(r.caseId)) === sc)
    if (inSc.length === 0) {
      warnings.push(`场景 ${sc} 无 case 加载（语料缺失），依 C7 显式 SKIP 该场景 diff`)
      continue
    }
    perScenarioL1[sc] = mean(inSc.map((r) => r.layers.L1.score))
  }
  // 逐毒类 L2（C1：分毒类 ≥0.98）
  const perPoisonL2 = {}
  for (const pt of POISON_TYPES) {
    const withP = results.filter((r) => (caseById.get(r.caseId).poisonChunks || []).some((p) => p.poisonType === pt))
    if (withP.length === 0) continue
    perPoisonL2[pt] = mean(withP.map((r) => r.layers.L2.score))
  }

  const corpusDigest = await computeCheckpointDigestOf(cases) // C4

  // ── B 门 diff / 建立 ──
  const blockers = []
  const notes = []
  let establishment = false

  // C1 硬阈值（不可覆盖；L2 = P0 一致性门）
  if (!agg.layers.L1.pass) blockers.push(`C1 硬阈值：L1=${l1.score.toFixed(4)} < ${TH.l1Min}`)
  if (!agg.layers.L2.pass) blockers.push(`C1 硬阈值：L2=${l2.score.toFixed(4)} < ${TH.l2Min}（P0 一致性门，不可覆盖）`)
  if (!agg.layers.L3.pass) blockers.push(`C1 硬阈值：L3=${l3.score.toFixed(4)} >= ${TH.l3Max}`)
  // C1：L2 分毒类 ≥0.98 任一跌破 = 防线击穿 blocker
  for (const [pt, s] of Object.entries(perPoisonL2)) {
    if (s < 0.98) blockers.push(`C1 分毒类击穿：${pt} L2=${s.toFixed(4)} < 0.98`)
  }

  if (args.init || !existsSync(baselinePath)) {
    establishment = true
    notes.push(args.init ? "显式 --init：建立基线" : "baseline.json 缺失：建立基线")
  } else {
    const base = readJson(baselinePath)
    const baseSc = base.perScenarioL1 || {}
    const basePo = base.perPoisonL2 || {}
    // L1 场景降 >1%（绝对百分点）
    for (const [sc, cur] of Object.entries(perScenarioL1)) {
      const b = baseSc[sc]
      if (b === undefined) {
        notes.push(`L1 场景 ${sc}：无基线，跳过 diff`)
        continue
      }
      if (b - cur > 0.01) blockers.push(`B 门：L1 场景 ${sc} 降 ${(b - cur).toFixed(4)} > 0.01（基线 ${b.toFixed(4)} → 当前 ${cur.toFixed(4)}）`)
    }
    // L2 毒类降
    for (const [pt, cur] of Object.entries(perPoisonL2)) {
      const b = basePo[pt]
      if (b !== undefined && b - cur > 0.01) blockers.push(`B 门：L2 毒类 ${pt} 降 ${(b - cur).toFixed(4)} > 0.01`)
    }
    if (!base.perScenarioL1 && !base.perPoisonL2) {
      warnings.push("baseline.json 缺逐场景/逐毒类明细，仅做聚合 diff；建议 --init 重建带明细基线")
    }
  }

  const status = blockers.length > 0 ? "FAIL" : establishment ? "BASELINE_ESTABLISHED" : "PASS"

  const report = {
    tool: "eval-baseline",
    generatedAt: new Date().toISOString(),
    status,
    source: manifest.source,
    corpusDigest,
    totalCases: cases.length,
    holdoutCases: holdout.length,
    scenarios: manifest.scenarios || EVAL_SCENARIOS,
    layers: {
      L1: { score: +l1.score.toFixed(6), pass: l1.pass },
      L2: { score: +l2.score.toFixed(6), pass: l2.pass },
      L3: { score: +l3.score.toFixed(6), pass: l3.pass },
    },
    aggregate: { overall: agg.overall, verdict: agg.verdict },
    perScenarioL1: roundMap(perScenarioL1),
    perPoisonL2: roundMap(perPoisonL2),
    diff: { blockers, notes },
    warnings,
    gateA,
  }

  // 建立基线：写 baseline.json（带逐场景/逐毒类明细，供后续 diff）
  if (establishment) {
    const baselineOut = {
      version: manifest.version || "1.0.0",
      generatedAt: report.generatedAt,
      source: manifest.source,
      baseline: {
        L1: report.layers.L1,
        L2: report.layers.L2,
        L3: report.layers.L3,
        verdict: agg.verdict,
      },
      perScenarioL1: report.perScenarioL1,
      perPoisonL2: report.perPoisonL2,
      corpusDigest,
      note: "由 scripts/eval-baseline.mjs 建立（C4 digest 复用 computeCheckpointDigestOf）",
    }
    writeFileSync(baselinePath, JSON.stringify(baselineOut, null, 2) + "\n")
    process.stderr.write(`[eval-baseline] 基线已建立并写入 ${baselinePath}\n`)
  }

  // 文本摘要到 stderr；JSON 报告到 stdout
  process.stderr.write(`[eval-baseline] source=${manifest.source} cases=${cases.length} digest=${corpusDigest.slice(0, 16)}...\n`)
  process.stderr.write(`[eval-baseline] L1=${report.layers.L1.score.toFixed(4)} L2=${report.layers.L2.score.toFixed(4)} L3=${report.layers.L3.score.toFixed(4)} verdict=${agg.verdict}\n`)
  for (const w of warnings) process.stderr.write(`[eval-baseline] WARN: ${w}\n`)
  for (const n of notes) process.stderr.write(`[eval-baseline] NOTE: ${n}\n`)
  for (const b of blockers) process.stderr.write(`[eval-baseline] BLOCKER: ${b}\n`)
  process.stderr.write(`[eval-baseline] status=${status}\n`)
  if (args.out) {
    writeFileSync(resolve(process.cwd(), args.out), JSON.stringify(report, null, 2) + "\n")
    process.stderr.write(`[eval-baseline] 报告落盘: ${args.out}\n`)
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")

  // 退出码：SKIPPED(C7)/PASS/ESTABLISHED → 0；blocker → 1
  return blockers.length > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[eval-baseline] ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
