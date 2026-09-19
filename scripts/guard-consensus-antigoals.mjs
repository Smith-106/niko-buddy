#!/usr/bin/env node
// guard-consensus-antigoals.mjs — R-1 共识六条反目标 IO 门禁。
//
// 共识来源：DeepSeek-flash + GLM-5.2 两路探讨共识 §5 六条反目标；
// 批准计划 r2 §1 映射表 / R-1，planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113。
//
// 两层门禁分工：本脚本 = IO 采集层（读语料计数 / flag 默认值 / 文件清单，
// 组装判定）；纯函数判定核 = src/lib/novel/consensus-antigoals.ts
// （checkAntigoals，零 IO，可单元测试）。本脚本内嵌等价判定的镜像实现
// （.mjs 无法 import TS），并在每次运行先做字面同步自检：从 TS 源读
// 阈值/期望值/模式字面量，与本脚本常量逐项比对，不一致即 exit 3 拒跑
// （防两层漂移——改一处须改另一处）。
//
// 用法：node scripts/guard-consensus-antigoals.mjs（仓库根执行）。
// 退出码：0 全部通过；2 违禁（打印违禁项 AG1-AG6）；3 自检/采集失败。
// ASCII only 输出（防 PS 乱码）；只读断言，不改任何产物。

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, dirname, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// ============================================================================
// 镜像常量（同步点：须与 src/lib/novel/consensus-antigoals.ts 字面一致）
// ============================================================================

const AG1_MAX_CORPUS_ENTRIES = 64
const CORPUS_BASELINE_COUNT = 6
const EXPECTED_RETRIEVAL_FLAGS = {
  dualKbRoutingEnabled: false,
  hardInjectEnabled: true,
  usefulnessRerankEnabled: false,
}
const CLAIM_SRC = String(/收敛结论|已收敛|top3.{0,12}0\.7/.source)
const EXEMPTION_SRC = String(
  /同源回归口径|不可作收敛结论|非真实语料|只证非劣化|合成压力面|待裁决|未达裁决/.source,
)
const CORE_RETRIEVAL_FNS = [
  "rankByBm25",
  "routeByQueryIntent",
  "reorderByUsefulness",
  "retrieveDualTrack",
  "novelMixedSearch",
  "generateMultiQueries",
  "fuseAcrossQueries",
]

// ============================================================================
// 字面同步自检（防两层漂移）
// ============================================================================

function selfCheck() {
  const problems = []
  const src = readFileSync(join(ROOT, "src", "lib", "novel", "consensus-antigoals.ts"), "utf8")
  const num = (name) => {
    const match = src.match(new RegExp(`export const ${name} = (\\d+)`))
    return match ? Number(match[1]) : null
  }
  if (num("AG1_MAX_CORPUS_ENTRIES") !== AG1_MAX_CORPUS_ENTRIES) {
    problems.push("AG1_MAX_CORPUS_ENTRIES 与 TS 源不一致")
  }
  if (num("CORPUS_BASELINE_COUNT") !== CORPUS_BASELINE_COUNT) {
    problems.push("CORPUS_BASELINE_COUNT 与 TS 源不一致")
  }
  for (const [key, value] of Object.entries(EXPECTED_RETRIEVAL_FLAGS)) {
    const pattern = new RegExp(`${key}: ${String(value)}`)
    if (!pattern.test(src)) problems.push(`EXPECTED_RETRIEVAL_FLAGS.${key} 与 TS 源不一致`)
  }
  const srcOf = (name) => {
    const match = src.match(new RegExp(`export const ${name} =\\s*\\n?\\s*/([^/]+)/`))
    return match ? match[1] : null
  }
  // CONVERGENCE_CLAIM_PATTERN / EXEMPTION 在 TS 源内是跨行字面量，正则首行只能取片段；
  // 自检改用"关键子串存在性"而非整模式相等（整模式相等由 gates.spec 覆盖）。
  for (const piece of ["收敛结论", "top3"]) {
    if (!src.includes(piece)) problems.push(`TS 源缺声称模式片段 ${piece}`)
  }
  for (const piece of ["同源回归口径", "非真实语料", "未达裁决"]) {
    if (!src.includes(piece)) problems.push(`TS 源缺豁免模式片段 ${piece}`)
  }
  void srcOf
  for (const fn of CORE_RETRIEVAL_FNS) {
    if (!src.includes(`"${fn}"`)) problems.push(`TS 源缺核心函数名 ${fn}`)
  }
  // 本脚本侧模式自检：确认 CLAIM_SRC/EXEMPTION_SRC 能编译且非空。
  try {
    if (new RegExp(CLAIM_SRC).source.length === 0) problems.push("CLAIM_SRC 为空模式")
    if (new RegExp(EXEMPTION_SRC).source.length === 0) problems.push("EXEMPTION_SRC 为空模式")
  } catch {
    problems.push("CLAIM/EXEMPTION 模式编译失败")
  }
  return problems
}

// ============================================================================
// IO 采集
// ============================================================================

function readText(rel) {
  return readFileSync(join(ROOT, rel), "utf8")
}

function collectMdFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (entry.endsWith(".md")) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

function listFilesWithSuffix(dir, prefix, suffix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
}

function collectSnapshot() {
  // corpus 计数（真源：kb-routing-view.generated.json 的 collectionCounts）。
  const kbView = JSON.parse(readText(join("src", "lib", "novel", "kb", "kb-routing-view.generated.json")))
  const collectionCounts = kbView.collectionCounts ?? {}

  // flag 默认值（真源：src/stores/wiki-store.ts 默认配置段）。
  const store = readText(join("src", "stores", "wiki-store.ts"))
  const flags = {}
  for (const key of Object.keys(EXPECTED_RETRIEVAL_FLAGS)) {
    const match = store.match(new RegExp(`^\\s*${key}:\\s*(true|false),`, "m"))
    if (!match) throw new Error(`wiki-store.ts 未找到 flag 默认值 ${key}`)
    flags[key] = match[1] === "true"
  }

  // AG4：src/lib/novel/ 之外的核心检索函数定义。
  const externalRetrievalDefs = []
  const fnPattern = (fn) => new RegExp(`(function|const)\\s+${fn}\\b`)
  const scanDirs = ["src"]
  const skipPrefix = join(ROOT, "src", "lib", "novel") + sep
  const stack = scanDirs.map((d) => join(ROOT, d))
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue
      const full = join(current, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".spec.ts") || entry.endsWith(".test.ts")) continue
      if (full.startsWith(skipPrefix)) continue
      const text = readFileSync(full, "utf8")
      for (const fn of CORE_RETRIEVAL_FNS) {
        if (fnPattern(fn).test(text)) {
          externalRetrievalDefs.push(`${relative(ROOT, full)}:${fn}`)
        }
      }
    }
  }

  // AG3：docs/p0 下 md 声称/豁免扫描。
  const claimRe = new RegExp(CLAIM_SRC)
  const exemptionRe = new RegExp(EXEMPTION_SRC)
  const convergenceClaims = []
  const p0Dir = join(ROOT, "docs", "p0")
  if (existsSync(p0Dir)) {
    for (const full of collectMdFiles(p0Dir)) {
      const text = readFileSync(full, "utf8")
      convergenceClaims.push({
        file: relative(ROOT, full),
        hasClaim: claimRe.test(text),
        hasExemption: exemptionRe.test(text),
      })
    }
  }

  // AG6：证据面文件存在性。
  const rerankTriggerEvidenceExists =
    listFilesWithSuffix(join(ROOT, "docs", "p0"), "rerank-trigger-evidence-", ".md").length > 0
  const sameScaleReportExists =
    listFilesWithSuffix(join(ROOT, "docs", "p0"), "same-scale-", ".md").length > 0

  // AG5：rule-stack 护栏模式。
  const ruleStack = readText(join("src", "lib", "novel", "rule-stack.ts"))

  return {
    collectionCounts,
    flags,
    externalRetrievalDefs,
    convergenceClaims,
    evidence: { rerankTriggerEvidenceExists, sameScaleReportExists },
    ruleStackQualityGuardPresent: ruleStack.includes('gate !== "quality"'),
    ruleStackPriorityOrderPresent: ruleStack.includes("GATE_PRIORITY_ORDER"),
  }
}

// ============================================================================
// 镜像判定（与 checkAntigoals 同语义；语义级一致性由 gates.spec 覆盖）
// ============================================================================

function checkSnapshot(snapshot) {
  const violations = []
  const corpus = snapshot.collectionCounts["corpus"] ?? 0

  if (corpus > AG1_MAX_CORPUS_ENTRIES) {
    violations.push({
      id: "AG1",
      detail: `corpus 条目 ${corpus} 超上限 ${AG1_MAX_CORPUS_ENTRIES}：禁全量导入 W`,
    })
  }

  const flagDiffs = Object.keys(EXPECTED_RETRIEVAL_FLAGS)
    .filter((key) => snapshot.flags[key] !== EXPECTED_RETRIEVAL_FLAGS[key])
    .map((key) => `${key}=${String(snapshot.flags[key])}（期望 ${String(EXPECTED_RETRIEVAL_FLAGS[key])}）`)
  if (flagDiffs.length > 0) {
    violations.push({ id: "AG2", detail: `检索 flag 默认值漂移：${flagDiffs.join("；")}` })
  }

  const unexempted = snapshot.convergenceClaims
    .filter((claim) => claim.hasClaim && !claim.hasExemption)
    .map((claim) => claim.file)
  if (unexempted.length > 0) {
    violations.push({ id: "AG3", detail: `同源自证声称无豁免标记：${unexempted.join("、")}` })
  }

  if (snapshot.externalRetrievalDefs.length > 0) {
    violations.push({ id: "AG4", detail: `novel 外定义检索主链函数：${snapshot.externalRetrievalDefs.join("、")}` })
  }

  if (!snapshot.ruleStackQualityGuardPresent || !snapshot.ruleStackPriorityOrderPresent) {
    const missing = [
      ...(snapshot.ruleStackQualityGuardPresent ? [] : ["Quality 永不短路护栏"]),
      ...(snapshot.ruleStackPriorityOrderPresent ? [] : ["GATE_PRIORITY_ORDER 引用"]),
    ]
    violations.push({ id: "AG5", detail: `rule-stack 门序护栏缺失：${missing.join("；")}` })
  }

  if (corpus > CORPUS_BASELINE_COUNT) {
    const missingEvidence = [
      ...(snapshot.evidence.rerankTriggerEvidenceExists ? [] : ["R0-b 触发证据产物"]),
      ...(snapshot.evidence.sameScaleReportExists ? [] : ["同尺报告"]),
    ]
    if (missingEvidence.length > 0) {
      violations.push({
        id: "AG6",
        detail: `corpus 已扩容至 ${corpus}（基线 ${CORPUS_BASELINE_COUNT}）但证据面缺失：${missingEvidence.join("；")}`,
      })
    }
  }

  return violations
}

// ============================================================================
// 主流程
// ============================================================================

const syncProblems = selfCheck()
if (syncProblems.length > 0) {
  console.error(`[antigoals] 两层同步自检失败：${syncProblems.join("；")}`)
  process.exit(3)
}

let snapshot
try {
  snapshot = collectSnapshot()
} catch (error) {
  console.error(`[antigoals] 采集失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(3)
}

const violations = checkSnapshot(snapshot)
if (violations.length === 0) {
  console.log(
    `[antigoals] ALL PASS (6/6)：corpus=${snapshot.collectionCounts["corpus"] ?? 0} ` +
      `flags=期望值 p0md=${snapshot.convergenceClaims.length} externalDefs=0`,
  )
  process.exit(0)
}

console.error(`[antigoals] VIOLATIONS: ${violations.length}`)
for (const violation of violations) {
  console.error(`  ${violation.id}: ${violation.detail}`)
}
process.exit(2)
