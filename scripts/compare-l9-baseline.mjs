#!/usr/bin/env node
/**
 * #155 对比分析器：新 L9 六维测量 vs 2026-10-10 历史基线。
 *
 * ## 为什么单独成脚本
 *
 * #155 的结论必须可复核：报告里的每一个数字都要能从两个 JSON 产物重新算出来。
 * 把口径写死在脚本里，并且**先自证历史基线**——脚本启动时用历史产物重算
 * 109 pass / 53 fail 与拖累维计数，对不上就 exit 2，绝不产出报告。
 *
 * ## 口径差异（必须随报告一起交付，不得省略）
 *
 *   历史基线：muse-spark-1.3-contributor-free（-free 通道，现已下线 model_not_found）
 *   本次测量：muse-spark-1.3-contributor（cpa 通道）
 *
 * 同模型不同通道，历史决策记录「同章可差 0.35」。因此逐章对比只能看**方向**
 * （翻转章的分布），不能把分差当成纯质量变化。报告里每个对比块都会带这句警告。
 *
 * ## 不完整运行的处理
 *
 * 有效章 < 162 时脚本仍然产出分析，但报告头部标记「非最终基线」，
 * 并在 exit code 上区分（0=完整，3=部分）。不允许把部分结果当最终基线落盘。
 *
 * 用法：
 *   node scripts/compare-l9-baseline.mjs [--json] [--out <dir>]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const HUB = join(HERE, "..", "..")
const STAGING = join(HUB, ".workflow", "harvest-staging")

const HIST_PATH = join(STAGING, "quality-gate-97-l9-baseline.json")
const NEW_PATH = join(STAGING, "quality-gate-97-l9-m-full.json")

const EXPECTED_CHAPTERS = 162
const PASS_LINE = 9.0
const NEAR_MISS_BAND = 0.2

/**
 * 历史基线的自证常量（来自 l9-m-full-STATUS.md「历史基线」节）。
 * 脚本必须先复现这些数字，否则说明口径理解错了，后面所有对比都无意义。
 */
const HIST_EXPECTED = {
  pass: 109,
  fail: 53,
  /** 拖累维计数：该维 median < 9.0 的章数 */
  dragCounts: { thrill: 157, pacing: 91, pull: 98, consistency: 6, continuity: 6, character: 4 },
}

function die(msg) {
  console.error(`FATAL: ${msg}`)
  process.exit(2)
}

function load(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    die(`读不到 ${label}：${path}\n  ${err instanceof Error ? err.message : String(err)}`)
  }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v)

/** 剥掉通道后缀（-free / -paid 等），只留基座模型名 */
const baseModel = (id) => String(id ?? "").replace(/-(?:free|paid|trial)$/i, "")

/** 有效章 = overall 是有限数字（overall=null 的章是未完成，不是失败） */
function validChapters(artifact) {
  const out = []
  for (const [key, row] of Object.entries(artifact.results ?? {})) {
    if (isNum(row?.overall)) out.push({ key, ...row })
  }
  out.sort((a, b) => Number(a.key.slice(2)) - Number(b.key.slice(2)))
  return out
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? null,
    belowPassLine: sorted.filter((v) => v < PASS_LINE).length,
  }
}

const round = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null)

// ── 1. 历史基线自证 ────────────────────────────────────────────────────────────

const hist = load(HIST_PATH, "历史基线")
const histValid = validChapters(hist)
const histPass = histValid.filter((c) => c.pass).length
const histFail = histValid.length - histPass

const histDrag = {}
for (const dim of hist.dimensions) {
  histDrag[dim] = histValid.filter((c) => isNum(c.dimensionMedians?.[dim]) && c.dimensionMedians[dim] < PASS_LINE).length
}

const selfCheckErrors = []
if (histValid.length !== EXPECTED_CHAPTERS) {
  selfCheckErrors.push(`历史有效章 ${histValid.length} != ${EXPECTED_CHAPTERS}`)
}
if (histPass !== HIST_EXPECTED.pass) selfCheckErrors.push(`历史 pass ${histPass} != ${HIST_EXPECTED.pass}`)
if (histFail !== HIST_EXPECTED.fail) selfCheckErrors.push(`历史 fail ${histFail} != ${HIST_EXPECTED.fail}`)
for (const [dim, expected] of Object.entries(HIST_EXPECTED.dragCounts)) {
  if (histDrag[dim] !== expected) selfCheckErrors.push(`历史拖累维 ${dim} ${histDrag[dim]} != ${expected}`)
}
if (selfCheckErrors.length > 0) {
  die(
    "历史基线自证失败——口径理解有误，拒绝产出报告：\n  " + selfCheckErrors.join("\n  "),
  )
}

// ── 2. 新产物 ──────────────────────────────────────────────────────────────────

const cur = load(NEW_PATH, "新测量产物")
const curValid = validChapters(cur)
const curAllKeys = Object.keys(cur.results ?? {})
const curNull = curAllKeys.filter((k) => !isNum(cur.results[k]?.overall))
const complete = curValid.length === EXPECTED_CHAPTERS && curNull.length === 0

// ── 3. 分析一：逐章 pass/fail 翻转 ─────────────────────────────────────────────

const histByKey = new Map(histValid.map((c) => [c.key, c]))
const flips = []
for (const row of curValid) {
  const before = histByKey.get(row.key)
  if (!before) continue
  const from = before.pass ? "pass" : "fail"
  const to = row.pass ? "pass" : "fail"
  if (from !== to) {
    flips.push({
      chapter: row.key,
      from,
      to,
      histOverall: round(before.overall),
      curOverall: round(row.overall),
      delta: round(row.overall - before.overall),
    })
  }
}
const flipFailToPass = flips.filter((f) => f.to === "pass")
const flipPassToFail = flips.filter((f) => f.to === "fail")

// 交集口径：两边都有效的章才参与 pass/fail 对比
const matchedKeys = curValid.map((c) => c.key).filter((k) => histByKey.has(k))
const matchedHistPass = matchedKeys.filter((k) => histByKey.get(k).pass).length
const matchedCurPass = matchedKeys.filter((k) => curValid.find((c) => c.key === k)?.pass).length
const matchedAggregate = {
  chapters: matchedKeys.length,
  historical: { pass: matchedHistPass, fail: matchedKeys.length - matchedHistPass },
  current: { pass: matchedCurPass, fail: matchedKeys.length - matchedCurPass },
  deltaPass: matchedCurPass - matchedHistPass,
}

// ── 4. 分析二/三：六维分布 + 拖累维排序 ────────────────────────────────────────

const dims = cur.dimensions ?? hist.dimensions
const curDist = {}
const curDrag = {}
for (const dim of dims) {
  const vals = curValid.map((c) => c.dimensionMedians?.[dim]).filter(isNum)
  curDist[dim] = describe(vals)
  curDrag[dim] = vals.filter((v) => v < PASS_LINE).length
}

/** 拖累维排序：低于 9.0 的章数降序；同数时按中位数升序（更差的排前面） */
const dragRanking = dims
  .map((dim) => ({
    dimension: dim,
    belowPassLine: curDrag[dim],
    share: curValid.length > 0 ? round(curDrag[dim] / curValid.length) : null,
    median: round(curDist[dim].median),
    histBelowPassLine: histDrag[dim],
    delta: curDrag[dim] - histDrag[dim],
  }))
  .sort((a, b) => b.belowPassLine - a.belowPassLine || (a.median ?? 99) - (b.median ?? 99))

// ── 5. 分析四：near-miss ──────────────────────────────────────────────────────

const nearMiss = curValid
  .filter((c) => c.overall < PASS_LINE && c.overall >= PASS_LINE - NEAR_MISS_BAND)
  .map((c) => ({ chapter: c.key, overall: round(c.overall), gap: round(PASS_LINE - c.overall) }))
  .sort((a, b) => a.gap - b.gap)

// ── 6. 分析五：thrill 是否仍是系统性拖累维 ─────────────────────────────────────

const curPass = curValid.filter((c) => c.pass).length
const thrillRow = dragRanking.find((d) => d.dimension === "thrill")
const secondDrag = dragRanking.find((d) => d.dimension !== "thrill")
const thrillIsTopDrag = dragRanking[0]?.dimension === "thrill"
const thrillGapToSecond = thrillRow && secondDrag ? thrillRow.belowPassLine - secondDrag.belowPassLine : null

const verdict = {
  thrillIsTopDrag,
  thrillBelowPassLine: thrillRow?.belowPassLine ?? null,
  thrillShare: thrillRow?.share ?? null,
  thrillHistBelowPassLine: thrillRow?.histBelowPassLine ?? null,
  thrillDelta: thrillRow?.delta ?? null,
  gapToSecondDrag: thrillGapToSecond,
  /** 历史判断是否仍成立：thrill 仍是最大拖累维，且与第二名的差距没有被抹平 */
  historicalClaimHolds: thrillIsTopDrag && (thrillGapToSecond ?? 0) > 0,
}

// ── 7. 输出 ────────────────────────────────────────────────────────────────────

const report = {
  generatedAt: new Date().toISOString(),
  completeness: {
    complete,
    expectedChapters: EXPECTED_CHAPTERS,
    validChapters: curValid.length,
    missingChapters: curNull,
    note: complete ? "完整运行" : "部分运行——本报告不是最终基线，缺失章补齐后需重跑本脚本",
  },
  caliber: {
    historical: { model: hist.model, samples: hist.samples },
    current: { model: cur.model, channel: cur.channel, samples: cur.samples },
    warning:
      "同模型不同通道（历史为 -free 通道，现已下线；本次为 cpa 通道）。历史决策记录「同章可差 0.35」。逐章对比只能看方向，不得把分差当作纯质量变化。",
    // 通道后缀（-free 等）不代表换了模型：基座相同、通道不同。
    // 这个区分很重要——"同模型不同通道"和"不同模型"对结论强度的影响完全不同。
    sameBaseModel: baseModel(hist.model) === baseModel(cur.model),
    sameChannel: hist.model === cur.model,
  },
  selfCheck: {
    passed: true,
    historicalPass: histPass,
    historicalFail: histFail,
    historicalDragCounts: histDrag,
  },
  aggregate: {
    // 全量口径（仅用于展示各自规模，**不可直接相减**）
    historical: { pass: histPass, fail: histFail, total: histValid.length },
    current: { pass: curPass, fail: curValid.length - curPass, total: curValid.length },
    /**
     * 交集口径：只在两边都有效的章上比。
     * 拿 162 章的历史 pass 去减 102 章的当前 pass 是无意义的，
     * 那个差值反映的是「章数不同」而不是「质量变化」。
     */
    matched: matchedAggregate,
  },
  flips: {
    total: flips.length,
    failToPass: flipFailToPass,
    passToFail: flipPassToFail,
  },
  dimensionDistribution: curDist,
  dragRanking,
  nearMiss,
  verdict,
}

function markdown(r) {
  const L = []
  const warn = r.caliber.warning
  L.push("# L9 六维基线对比报告（#155）")
  L.push("")
  if (!r.completeness.complete) {
    L.push("> ⚠️ **本报告不是最终基线。**")
    L.push(`> 有效章 ${r.completeness.validChapters}/${r.completeness.expectedChapters}，`)
    L.push(`> 缺失：${r.completeness.missingChapters.join(", ") || "(无)"}。`)
    L.push("> 缺失章补齐后必须重跑 `node scripts/compare-l9-baseline.mjs`。")
    L.push("")
  }
  L.push(`生成时间：${r.generatedAt}`)
  L.push("")
  L.push("## 口径差异（必读）")
  L.push("")
  L.push(`- 历史基线：\`${r.caliber.historical.model}\`，samples=${r.caliber.historical.samples}`)
  L.push(`- 本次测量：\`${r.caliber.current.model}\`，channel=${r.caliber.current.channel}，samples=${r.caliber.current.samples}`)
  L.push(
    `- 基座模型相同：**${r.caliber.sameBaseModel ? "是" : "否"}**；通道相同：**${r.caliber.sameChannel ? "是" : "否"}**`,
  )
  L.push("")
  L.push(`> ${warn}`)
  L.push("")
  L.push("## 0. 历史基线自证")
  L.push("")
  L.push("脚本用历史产物重算，必须复现文档公布的数字，否则拒绝产出报告：")
  L.push("")
  L.push(`- pass ${r.selfCheck.historicalPass} / fail ${r.selfCheck.historicalFail} ✅`)
  L.push(`- 拖累维计数：${Object.entries(r.selfCheck.historicalDragCounts).map(([d, c]) => `${d} ${c}`).join(" / ")} ✅`)
  L.push("")
  L.push("## 1. 逐章 pass/fail 对比")
  L.push("")
  const m = r.aggregate.matched
  L.push(`**按交集口径比较**（两边都有效的 ${m.chapters} 章）：`)
  L.push("")
  L.push(`| | 历史 | 本次 | Δ |`)
  L.push(`|---|---|---|---|`)
  L.push(`| pass | ${m.historical.pass} | ${m.current.pass} | ${m.deltaPass >= 0 ? "+" : ""}${m.deltaPass} |`)
  L.push(`| fail | ${m.historical.fail} | ${m.current.fail} | |`)
  L.push("")
  L.push(
    `> 各自全量规模仅作参考、不可相减：历史 ${r.aggregate.historical.total} 章（pass ${r.aggregate.historical.pass}），` +
      `本次 ${r.aggregate.current.total} 章（pass ${r.aggregate.current.pass}）。`,
  )
  L.push("")
  L.push(`翻转章共 **${r.flips.total}** 章：fail→pass ${r.flips.failToPass.length} 章，pass→fail ${r.flips.passToFail.length} 章。`)
  L.push("")
  if (r.flips.total > 0) {
    L.push("| 章 | 方向 | 历史 overall | 本次 overall | Δ |")
    L.push("|---|---|---|---|---|")
    for (const f of [...r.flips.failToPass, ...r.flips.passToFail]) {
      L.push(`| ${f.chapter} | ${f.from}→${f.to} | ${f.histOverall} | ${f.curOverall} | ${f.delta >= 0 ? "+" : ""}${f.delta} |`)
    }
    L.push("")
  }
  L.push("## 2. 六维分布")
  L.push("")
  L.push("| 维 | n | min | p25 | median | p75 | max | <9.0 章数 |")
  L.push("|---|---|---|---|---|---|---|---|")
  for (const dim of Object.keys(r.dimensionDistribution)) {
    const d = r.dimensionDistribution[dim]
    L.push(`| ${dim} | ${d.n} | ${d.min} | ${round(d.p25)} | ${round(d.median)} | ${round(d.p75)} | ${d.max} | ${d.belowPassLine} |`)
  }
  L.push("")
  L.push("## 3. 拖累维排序")
  L.push("")
  L.push("按「median < 9.0 的章数」降序；同数时按 median 升序。")
  L.push("")
  L.push("| 排序 | 维 | 本次 <9.0 | 占比 | median | 历史 <9.0 | Δ |")
  L.push("|---|---|---|---|---|---|---|")
  r.dragRanking.forEach((d, i) => {
    L.push(
      `| ${i + 1} | ${d.dimension} | ${d.belowPassLine} | ${d.share === null ? "-" : `${Math.round(d.share * 100)}%`} | ${d.median} | ${d.histBelowPassLine} | ${d.delta >= 0 ? "+" : ""}${d.delta} |`,
    )
  })
  L.push("")
  L.push("## 4. near-miss 清单（overall 距 9.0 ≤ 0.2）")
  L.push("")
  if (r.nearMiss.length === 0) {
    L.push("无。")
  } else {
    L.push("| 章 | overall | 距 9.0 |")
    L.push("|---|---|---|")
    for (const n of r.nearMiss) L.push(`| ${n.chapter} | ${n.overall} | ${n.gap} |`)
  }
  L.push("")
  L.push("## 5. 结论：thrill 是否仍是系统性拖累维")
  L.push("")
  const v = r.verdict
  L.push(`- thrill 是否为最大拖累维：**${v.thrillIsTopDrag ? "是" : "否"}**`)
  L.push(`- thrill <9.0 章数：${v.thrillBelowPassLine}（历史 ${v.thrillHistBelowPassLine}，Δ ${v.thrillDelta >= 0 ? "+" : ""}${v.thrillDelta}）`)
  L.push(`- 与第二名拖累维的差距：${v.gapToSecondDrag} 章`)
  L.push(`- **历史判断「thrill 是系统性拖累维」是否仍成立：${v.historicalClaimHolds ? "成立" : "不成立（需重写该判断）"}**`)
  L.push("")
  if (!r.completeness.complete) {
    L.push("> 以上结论基于部分章节，仅作趋势参考，不可作为基线结论。")
    L.push("")
  }
  return L.join("\n")
}

const asJson = process.argv.includes("--json")
const outIdx = process.argv.indexOf("--out")
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : STAGING

const jsonPath = join(outDir, "l9-m-full-comparison.json")
const mdPath = join(outDir, "l9-m-full-comparison.md")
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8")
writeFileSync(mdPath, markdown(report) + "\n", "utf8")

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`有效章 ${curValid.length}/${EXPECTED_CHAPTERS}${complete ? "（完整）" : "（部分，非最终基线）"}`)
  console.log(
    `交集 ${matchedAggregate.chapters} 章 pass ${matchedAggregate.historical.pass} → ${matchedAggregate.current.pass}` +
      `（Δ ${matchedAggregate.deltaPass >= 0 ? "+" : ""}${matchedAggregate.deltaPass}）`,
  )
  console.log(`翻转章 ${flips.length}：fail→pass ${flipFailToPass.length} / pass→fail ${flipPassToFail.length}`)
  console.log(`最大拖累维：${dragRanking[0]?.dimension}（${dragRanking[0]?.belowPassLine} 章 <9.0）`)
  console.log(`历史判断「thrill 是系统性拖累维」：${verdict.historicalClaimHolds ? "仍成立" : "不成立"}`)
  console.log(`\n已落盘：\n  ${mdPath}\n  ${jsonPath}`)
  if (!complete) {
    console.log(`\n⚠️  非最终基线：缺 ${curNull.length} 章（${curNull.join(", ")}）。补齐后重跑本脚本。`)
  }
}

process.exit(complete ? 0 : 3)
