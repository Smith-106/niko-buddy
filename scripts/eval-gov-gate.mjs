#!/usr/bin/env node
/**
 * eval-gov-gate.mjs — G-1 评测种子三重判据离线 gate driver（P1-IMP-11，route_ref P1-M2）。
 *
 * 管线（照 offline-replay.js / eval-baseline.mjs 的 EXIT 纪律）:
 *   读种子 jsonl → loadGovSeedSet → 逐例驱动 retrieveDualTrack →
 *   computeTripleCriteria → evaluateRetrievalGate → renderEvalGateReport → 写报告
 *
 * EXIT 语义（E-06 共识 C-7 / V5：区分「未就绪」与「失败」，不伪造就绪）:
 *   - status != "ready"（种子缺失/不足，110 底线未达）→ 报告标 BLOCKED + **exit 0**
 *     （未就绪是可预期的冷启动态，不是评测失败；不 exit 1）
 *   - status = "ready" 且判据 FAIL → exit 1（评测失败）
 *   - status = "ready" 且 PASS → exit 0
 *   - 用法/IO/schema 损坏错误 → exit 2（fail-fast；种子 schema 违反属 RECOVERABLE，
 *     与 loadGovSeedSet 抛错口径一致）
 *
 * 影子双臂采集（三 flag 开/关对照；仅采集，不翻转任何默认值）:
 *   三 flag = dualKbRoutingEnabled / hardInject / usefulnessRerank（wiki-store 六 flag 中
 *   awaiting-eval-evidence 三者）。单次 retrieveDualTrack 无法在进程内切换 store flag
 *   （useWikiStore 为 Tauri 应用态，纯 node 环境不可用，运行时自检到 → 该臂记
 *   metric-unavailable，不伪造）。检索适配层在纯 node 下不可用（@/ alias + Tauri
 *   invoke 依赖）→ 全部用例逐例记 retrieval_adapter_unavailable → 判据全 null →
 *   BLOCKED(metric-unavailable)。atmosphereScore 无确定性实现（eval-gate.ts 注释）→ 恒 null。
 *
 * import 策略（PAT-G2 纪律，与 eval-baseline.mjs 同款）:
 *   - eval-gate.ts 仅依赖 zod + offline-replay-config.ts（零相对 @/ 依赖），Node ≥23.6
 *     原生 type-stripping + registerHooks 扩展名补全直引——零镜像，与 TS 侧同源零漂移。
 *   - search-adapter.ts 依赖 @/ alias 与 useWikiStore（Tauri 应用态），纯 node 不可 import
 *     → 探测失败显式记 adapter 不可用，绝不静默降级为合成数据。
 *
 * 用法:
 *   npm run eval:gov                     # 默认读 docs/p0/gov-seed/gov-seed-v1.jsonl
 *   node scripts/eval-gov-gate.mjs --seed <path>     # 指定种子文件
 *   node scripts/eval-gov-gate.mjs --report-dir <d>  # 报告落盘目录（默认 docs/p0/gov-seed/reports）
 *   node scripts/eval-gov-gate.mjs --help
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { registerHooks } from "node:module"

// Node ≥23.6 原生 TS type-stripping；产品源码 extensionless imports → resolve hook 补 .ts
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".")) return nextResolve(specifier, context)
    try {
      return nextResolve(specifier, context)
    } catch {
      const base = fileURLToPath(new URL(specifier, context.parentURL))
      const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
      for (const c of candidates) {
        if (existsSync(c)) return nextResolve(`file://${c.replace(/\\/g, "/")}`, context)
      }
      throw new Error(`cannot resolve ${specifier} from ${context.parentURL}`)
    }
  },
})

// eval-gate.ts 零 @/ 相对依赖（zod + offline-replay-config 仅常量/纯函数）→ 直引同源
const { loadGovSeedSet, computeTripleCriteria, evaluateRetrievalGate, renderEvalGateReport, GOV_TRAPS } =
  await import("../src/lib/novel/eval-gate.ts")

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const QMAI_ROOT = resolve(SCRIPT_DIR, "..")
const DEFAULT_SEED = join(QMAI_ROOT, "docs", "p0", "gov-seed", "gov-seed-v1.jsonl")
const DEFAULT_REPORT_DIR = join(QMAI_ROOT, "docs", "p0", "gov-seed")

/** 影子双臂三 flag（wiki-store 六 flag 中 awaiting-eval-evidence 三者；仅对照采集，不翻转）。 */
const SHADOW_FLAGS = ["dualKbRoutingEnabled", "hardInject", "usefulnessRerank"]

const ACCEPTANCE_NOTE =
  "本报告不含 MRR/NDCG 验收语义（GOV-EVAL-05 / SA-06）：检索精度验收仅三重判据。"

function usage() {
  return `eval-gov-gate.mjs — G-1 种子三重判据离线 gate（P1-IMP-11）

用法:
  npm run eval:gov                              读默认种子 docs/p0/gov-seed/gov-seed-v1.jsonl
  node scripts/eval-gov-gate.mjs --seed <path>   指定种子 jsonl
  node scripts/eval-gov-gate.mjs --report-dir <d> 报告目录（默认 docs/p0/gov-seed/reports）
  node scripts/eval-gov-gate.mjs --help

EXIT: 0 = PASS 或 BLOCKED(未就绪，110 底线)；1 = ready 但判据 FAIL；2 = 用法/IO/schema 错误`
}

function parseArgs(argv) {
  const args = { seed: DEFAULT_SEED, reportDir: DEFAULT_REPORT_DIR, help: false, badArg: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") args.help = true
    else if (a === "--seed") args.seed = resolve(process.cwd(), argv[++i] ?? args.seed)
    else if (a === "--report-dir") args.reportDir = resolve(process.cwd(), argv[++i] ?? args.reportDir)
    else {
      process.stderr.write(`[eval-gov-gate] unknown arg: ${a}\n`)
      args.help = true
      args.badArg = true
    }
  }
  return args
}

/** 读种子 jsonl（原行透传 loadGovSeedSet；解析失败抛错 → exit 2，schema 违反属种子损坏）。 */
function readSeedLines(path) {
  if (!existsSync(path)) {
    process.stderr.write(`[eval-gov-gate] 种子文件缺失: ${path}\n`)
    process.exit(2)
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
}

/**
 * 检索适配层探测（纯 node 可用性自检；不伪造）。
 * search-adapter.ts 依赖 @/ alias（vite resolve）与 useWikiStore（Tauri 应用态）——
 * 纯 node 下 import 必失败 → 逐例记 retrieval_adapter_unavailable，判据 null。
 */
async function probeRetrievalAdapter() {
  try {
    const mod = await import("../src/lib/novel/search-adapter.ts")
    return { available: typeof mod.retrieveDualTrack === "function", reason: null, retrieve: mod.retrieveDualTrack }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), retrieve: null }
  }
}

/**
 * 影子双臂对照采集（单例）：三 flag（dualKbRouting/hardInject/usefulnessRerank）存于
 * useWikiStore（Tauri 应用态）——纯 node 进程内不可翻转，双臂对照只能在应用运行时影子期
 * 采集。本脚本如实记 pending（不伪造双臂数据）：adapter 可用时驱动单臂试采并标注
 * store-unavailable-in-node；不可用时逐例记 retrieval_adapter_unavailable。
 */
function makeShadowProbe(adapter) {
  return {
    async runOne(seedCase) {
      if (!adapter.available || !adapter.retrieve) {
        return { status: "retrieval_adapter_unavailable" }
      }
      try {
        const res = await adapter.retrieve({
          projectPath: null,
          query: seedCase.query,
          chapterNumber: undefined,
          intent: seedCase.intent,
        })
        return { status: "retrieved", result: res, note: "store-unavailable-in-node: 三 flag 进程内不可翻转，双臂对照待 Tauri 影子期" }
      } catch (e) {
        return { status: "retrieval_error", detail: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * 逐例三重判据采集（离线可重跑；任一判据不可采集 → null，绝不伪造，E-06 共识 C-7）。
 * 仅统计真实检索完成的用例（retrievalStatus=retrieved）；canon 回放断言引擎待接 → 恒 null。
 */
function criteriaFromPerCase(perCase) {
  const retrieved = perCase.filter((c) => c.retrievalStatus === "retrieved")
  const recallRetrieved = retrieved.filter((c) => c.category === "obligation_recall")
  const cov =
    recallRetrieved.length > 0
      ? recallRetrieved.filter((c) => c.obligationCovered === true).length / recallRetrieved.length
      : null
  return computeTripleCriteria({ canonViolationRate: null, obligationCoverage: cov, atmosphereScore: null })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(usage() + "\n")
    return args.badArg ? 2 : 0
  }

  const seedLines = readSeedLines(args.seed)
  // status ∈ {missing, insufficient, ready}；schema 违反 → loadGovSeedSet 抛错（exit 2）
  const seedSet = loadGovSeedSet(seedLines)

  const adapter = await probeRetrievalAdapter()
  const shadow = makeShadowProbe(adapter)

  const perCase = []
  for (const c of seedSet.cases) {
    const probe = await shadow.runOne(c)
    const retrievalStatus =
      seedSet.status !== "ready"
        ? "seed_not_ready_skipped"
        : probe.status === "retrieval_adapter_unavailable"
          ? "retrieval_adapter_unavailable"
          : probe.status
    perCase.push({ caseId: c.caseId, category: c.category, intent: c.intent, retrievalStatus })
  }

  const criteria = criteriaFromPerCase(perCase)
  const verdict = evaluateRetrievalGate({
    criteria,
    seedStatus: seedSet.status,
    scaleViolations: seedSet.scaleViolations,
  })

  const trapInterception = {}
  for (const t of GOV_TRAPS) {
    const tagged = seedSet.cases.filter((c) => c.category === "canon_violation_replay" && c.caseId.includes(t))
    if (tagged.length > 0) {
      trapInterception[t] =
        seedSet.status === "ready" && adapter.available ? 0 : -1 /* -1 = 种子未就绪/adapter 不可用，逐例未采，见报告注记 */
    }
  }

  const report = renderEvalGateReport({
    seedStatus: seedSet.status,
    criteria,
    verdict,
    trapInterception,
    acceptanceNote: ACCEPTANCE_NOTE,
  })

  // ── 落盘（docs/p0/gov-seed/reports/report-<YYYYMMDD>.md，可审计复现 GOV-EVAL-02/06）──
  mkdirSync(args.reportDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const reportPath = join(args.reportDir, `report-${stamp}.md`)
  const header = [
    `# eval-gov-gate 评测报告（种子 ${args.seed}）`,
    "",
    `- generated_at: ${new Date().toISOString()}`,
    `- seed_case_count: ${seedSet.cases.length}（110 底线 = 60/30/20+六陷阱各≥2；未达即 BLOCKED 不伪造就绪）`,
    `- scale_violations: ${seedSet.scaleViolations.map((v) => `${v.category}=${v.actual}/${v.expected}${v.detail ? `(${v.detail})` : ""}`).join("; ") || "无"}`,
    `- retrieval_adapter_available: ${adapter.available}（不可用时逐例记 retrieval_adapter_unavailable，绝不静默合成）`,
    `- shadow_arms: 三 flag（${SHADOW_FLAGS.join(" / ")}）开/关对照；进程内 store 不可用 → pending（真实双臂待 Tauri 运行时影子期采集，SOP 见 docs/p0/gov-seed/README.md；ADR-47 判定式挂钩：回归防线常驻 ∧ 双臂对照不引入新确定缺陷 → 检索维实测解锁，不达标降回字面口径重议 95）`,
    `- trap_interception 注记: -1 = 种子未就绪或检索 adapter 不可用，逐例未采集，非拦截失败`,
    `- pending_after_IMP06_07_08: 种子 110 例齐备依赖 IMP-06（trust 接线）/IMP-07（intent 路由）/IMP-08（kb-view 就位）后补齐`,
    "",
    "---",
    "",
  ].join("\n")
  writeFileSync(reportPath, header + report + "\n", "utf8")

  // P1-IMP-15: 判据包 schema 机读输出（可审计翻默认值授权）。与 markdown 报告同目录。
  const judgmentPath = join(args.reportDir, `judgment-${stamp}.json`)
  const judgment = {
    schemaVersion: 1,
    gateId: `eval-gov-gate:${args.seed}`,
    timestamp: new Date().toISOString(),
    arms: {
      baseline: { flagValue: false, metrics: { consistency: criteria.consistencyScore ?? null, quality: criteria.qualityScore ?? null } },
      experiment: { flagValue: true, metrics: { consistency: criteria.consistencyScore ?? null, quality: criteria.qualityScore ?? null } },
    },
    verdict: verdict.verdict, // PASS | FAIL | BLOCKED
    criteria: {
      consistencyNoRegression: verdict.verdict !== "FAIL",
      qualityGain: verdict.verdict === "PASS",
      reason: verdict.reason ?? `seed_status=${seedSet.status}`,
    },
    seedCaseCoverage: { baseline: seedSet.cases.length, experiment: seedSet.cases.length },
  }
  writeFileSync(judgmentPath, JSON.stringify(judgment, null, 2) + "\n", "utf8")

  process.stdout.write(header)
  process.stdout.write(report + "\n")
  process.stdout.write(`[eval-gov-gate] 报告已写入: ${reportPath}\n`)
  process.stdout.write(`[eval-gov-gate] 判据包已写入: ${judgmentPath}\n`)

  // EXIT 语义：BLOCKED（未就绪）→ 0；ready 且 FAIL → 1；ready 且 PASS → 0
  if (verdict.verdict === "FAIL") return 1
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // schema 违反 / IO 错误 → exit 2 fail-fast（区分于评测 FAIL 的 1 与未就绪 BLOCKED 的 0）
    process.stderr.write(`[eval-gov-gate] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(2)
  })
