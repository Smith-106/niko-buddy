#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * offline-replay.js — T31 P4 垂直切片全验收 driver（TASK-P4-31 / A-10 全项）。
 *
 * 职责:
 *   1. 驱动机械证据 spec `src/lib/novel/offline-replay-t31-vertical-slice.spec.ts`
 *      （A-10.1 authoritative 端到端 / A-10.3 崩溃注入×5 / A-10.4 重放×2 一致 /
 *      A-05.3 迁移前事实可查询），收集逐项 PASS/FAIL 证据。
 *   2. 以 T02 同源纯函数（offline-replay-config.ts 的 replayStates/scoreReplay）
 *      对证据中的真实 route() 决策状态序列做离线回放评分，输出四因子加权评分报告，
 *      并核对 PROVISIONAL 阈值（A-05.2）。
 *
 * 用法:
 *   node scripts/offline-replay.js                       # T31 全验收（默认）
 *   node scripts/offline-replay.js --score --input f.json [--json]   # 仅评分（ControlState[]）
 *   node scripts/offline-replay.js --evidence out.json   # 全验收并把证据落盘到指定路径
 *   node scripts/offline-replay.js --help
 *
 * 执行纪律:
 *   - ADR-19 机械层零 LLM：本脚本不调用任何 LLM / Tauri invoke；评分是纯算术。
 *   - Draft-first (ADR-08)：不写入任何运行时会话状态文件；唯一产物是显式要求的
 *     验收证据 JSON 与本脚本的 stdout 报告。
 *   - 硬门纪律：任一项 FAIL → 如实报 FAIL 并以非零码退出，不粉饰。
 *   - warn 态 anti-AI 按 P2-21 共识放行，不计为 FAIL（spec 内有专项断言佐证）。
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OFFLINE_REPLAY_FACTOR_WEIGHTS,
  OFFLINE_REPLAY_QUALITY_THRESHOLD,
  OFFLINE_REPLAY_THRESHOLDS,
  replayStates,
} from "../src/lib/novel/offline-replay-config.ts"

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url))
const QMAI_ROOT = resolve(SCRIPT_DIR, "..")
const SPEC_REL = "src/lib/novel/offline-replay-t31-vertical-slice.spec.ts"
const T36_AB_SPEC_REL = "src/lib/novel/offline-replay-t36-ab-pair.spec.ts"
const VITEST_ENTRY = join(QMAI_ROOT, "node_modules", "vitest", "vitest.mjs")

/** 验收项清单（与 spec 证据 id 一一对应）。 */
const ACCEPTANCE_ITEMS = [
  { id: "A-10.1-authoritative-end-to-end", ref: "A-10.1", title: "authoritative 模式 route() 决策权威路径端到端" },
  { id: "A-05.2-offline-replay-score", ref: "A-05.2", title: "离线决策回放评分达标" },
  { id: "A-10.3-crash-injection-x5", ref: "A-10.3", title: "崩溃注入 ×5 点恢复语义" },
  { id: "A-10.4-replay-x2-consistency", ref: "A-10.4", title: "同一章重放 ×2 一致（digest 幂等）" },
  { id: "A-05.3-pre-migration-facts-queryable", ref: "A-05.3", title: "迁移前事实可查询（T30b→canon-graph-client）" },
]

const USAGE = `T31 P4 垂直切片全验收 / T36 精品模式 A/B 验收 driver (TASK-P4-31 / TASK-P6-36)

用法:
  node scripts/offline-replay.js                     运行 T31 全验收（5 项逐项 PASS/FAIL + 回放评分）
  node scripts/offline-replay.js --evidence <path>   同上，并把证据 JSON 落盘到指定路径
  node scripts/offline-replay.js --score --input <states.json> [--json]
                                                     仅离线回放评分（输入为 ControlState[] 数组）
  node scripts/offline-replay.js --ab [--report <path>] [--evidence <path>]
                                                     T36 精品模式 A/B 验收（五门逐项评估）
  node scripts/offline-replay.js --help              本帮助

评分因子权重 (T02 定稿值):
  branchAgreement=${OFFLINE_REPLAY_FACTOR_WEIGHTS.branchAgreement}
  selfConsistency=${OFFLINE_REPLAY_FACTOR_WEIGHTS.selfConsistency}
  gatePass=${OFFLINE_REPLAY_FACTOR_WEIGHTS.gatePass}
  wallClock=${OFFLINE_REPLAY_FACTOR_WEIGHTS.wallClock}
  综合达标线: ${OFFLINE_REPLAY_QUALITY_THRESHOLD}`

function parseArgs(argv) {
  const args = { mode: "acceptance", input: null, json: false, evidence: null, report: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--score") args.mode = "score"
    else if (a === "--ab") args.mode = "ab"
    else if (a === "--help" || a === "-h") args.mode = "help"
    else if (a === "--json") args.json = true
    else if (a === "--input") args.input = argv[++i] ?? null
    else if (a === "--evidence") args.evidence = argv[++i] ?? null
    else if (a === "--report") args.report = argv[++i] ?? null
  }
  return args
}

// ──────────────────────────────────────────────────────────────────────────
// --score 模式：原生离线回放评分（T02 runner 同源口径）
// ──────────────────────────────────────────────────────────────────────────

function runScoreMode(inputPath, asJson) {
  if (!inputPath) throw new Error("缺少 --input <file.json>（ControlState[] 数组）")
  const abs = resolve(process.cwd(), inputPath)
  const states = JSON.parse(readFileSync(abs, "utf-8"))
  if (!Array.isArray(states)) throw new Error("输入 JSON 必须是 ControlState[] 数组")
  const result = replayStates(states)
  if (asJson) {
    console.log(JSON.stringify({ decisionLog: result.decisionLog, quality: result.quality }, null, 2))
  } else {
    console.log(`[offline-replay] 章节数: ${states.length}`)
    console.log("— 决策日志 —")
    for (const d of result.decisionLog) {
      console.log(
        `  章 ${String(d.chapterNumber).padStart(2)} | 分支一致=${d.branchAgreement ? "Y" : "N"} | ` +
          `自一致=${d.selfConsistent ? "Y" : "N"} | 门控=${d.gatePassed ? "PASS" : "FAIL"} | ` +
          `墙钟=${d.wallClockSeconds}s`,
      )
    }
    printQuality(result.quality)
  }
  return result.quality.meetsThreshold && !result.quality.rebasingRequired ? 0 : 1
}

function printQuality(q) {
  console.log("— 离线决策回放质量分 (T02 同源四因子加权) —")
  console.log(`  分支一致率:   ${q.branchAgreementRate.toFixed(4)} (达标线 ${OFFLINE_REPLAY_THRESHOLDS.branchAgreement})`)
  console.log(`  自一致性:     ${q.selfConsistencyRate.toFixed(4)} (达标线 ${OFFLINE_REPLAY_THRESHOLDS.selfConsistency})`)
  console.log(`  门控通过率:   ${q.gatePassRate.toFixed(4)} (达标线 ${OFFLINE_REPLAY_THRESHOLDS.gatePass})`)
  console.log(`  墙钟归一分:   ${q.wallClockNormalized.toFixed(4)}`)
  console.log(
    `  综合质量分:   ${q.compositeScore.toFixed(4)} (达标线 ${OFFLINE_REPLAY_QUALITY_THRESHOLD}) → ` +
      `${q.compositeScore >= OFFLINE_REPLAY_QUALITY_THRESHOLD ? "[PASS]" : "[FAIL]"}`,
  )
}

// ──────────────────────────────────────────────────────────────────────────
// 默认模式：T31 全验收
// ──────────────────────────────────────────────────────────────────────────

function runAcceptance(evidenceOut) {
  if (!existsSync(VITEST_ENTRY)) {
    console.error("[t31] FATAL: 未找到 vitest 入口（先在 QMAI/ 内 npm install）:")
    console.error(`       ${VITEST_ENTRY}`)
    return 2
  }

  // 证据落盘路径：显式指定或临时目录
  const evidencePath =
    evidenceOut ?? join(mkdtempSync(join(tmpdir(), "t31-evidence-")), "evidence.json")

  console.log("[t31] 步骤 1/2 — 驱动机械证据 spec (vitest):")
  console.log(`       ${SPEC_REL}`)
  const res = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", SPEC_REL],
    {
      cwd: QMAI_ROOT,
      stdio: "inherit",
      env: { ...process.env, T31_EVIDENCE_PATH: evidencePath },
    },
  )
  const vitestOk = res.status === 0

  console.log("")
  console.log("[t31] 步骤 2/2 — 汇总验收判定")
  if (!existsSync(evidencePath)) {
    console.error(`[t31] FAIL: 证据文件未生成 (${evidencePath})；vitest 退出码=${res.status}`)
    return 1
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"))
  if (evidenceOut) {
    console.log(`[t31] 证据已落盘: ${evidencePath}`)
  }

  let allPass = vitestOk

  // ── 逐项判定（A-10.1 / A-10.3 / A-10.4 / A-05.3 来自 spec 证据）──
  console.log("")
  console.log("================ T31 垂直切片全验收 (A-10 全项) ================")
  for (const item of ACCEPTANCE_ITEMS) {
    const ev = evidence.items?.[item.id]
    const ok = vitestOk && ev?.pass === true
    if (!ok) allPass = false
    console.log(`[${ok ? "PASS" : "FAIL"}] ${item.ref} ${item.title}`)
    if (ev) {
      for (const [k, v] of Object.entries(ev)) {
        if (k === "pass" || k === "decisionLog" || k === "scenarioLabels") continue
        const text = JSON.stringify(v)
        console.log(`       ${k}: ${text.length > 300 ? text.slice(0, 300) + "…" : text}`)
      }
    }
  }
  console.log("================================================================")

  // ── A-05.2 评分：driver 用 T02 同源纯函数对真实 route() 决策状态独立复算 ──
  console.log("")
  const states = evidence.replay?.states
  if (!Array.isArray(states) || states.length === 0) {
    console.log("[FAIL] A-05.2 离线决策回放评分: 证据缺少状态序列，无法评分")
    allPass = false
  } else {
    const q = replayStates(states).quality
    printQuality(q)
    const factorsMeetThresholds =
      q.branchAgreementRate >= OFFLINE_REPLAY_THRESHOLDS.branchAgreement &&
      q.selfConsistencyRate >= OFFLINE_REPLAY_THRESHOLDS.selfConsistency &&
      q.gatePassRate >= OFFLINE_REPLAY_THRESHOLDS.gatePass &&
      q.compositeScore >= OFFLINE_REPLAY_QUALITY_THRESHOLD &&
      !q.rebasingRequired
    // spec 内断言与 driver 复算必须同判（同源口径交叉验证）
    const specItemPass = evidence.items?.["A-05.2-offline-replay-score"]?.pass === true
    const scoreOk = vitestOk && factorsMeetThresholds && specItemPass
    if (!scoreOk) allPass = false
    console.log(
      `[${scoreOk ? "PASS" : "FAIL"}] A-05.2 离线决策回放评分达标 ` +
        `(状态序列 ${states.length} 章; 因子阈值+综合线全过=${factorsMeetThresholds}; spec 同判=${specItemPass})`,
    )
  }

  // ── 总判定 ──
  console.log("")
  console.log("=============================================================")
  if (allPass) {
    console.log("[t31] 总判定: PASS — A-10 全项通过（warn 态 anti-AI 按 P2-21 共识放行，不计 FAIL）")
    return 0
  }
  console.log("[t31] 总判定: FAIL — 存在未通过项（硬门纪律：如实上报，不得粉饰）")
  return 1
}

// ──────────────────────────────────────────────────────────────────────────
// --ab 模式：T36 精品模式 A/B 验收（五门逐项评估）
// ──────────────────────────────────────────────────────────────────────────

/**
 * T36 精品模式 A/B 验收 五门项定义（同蓝图 T36 顺序）
 */
const AB_GATES = [
  {
    id: "gate1-six-dim-median-diff",
    title: "门槛① 六维 overall 中位差（精品臂−基线臂 ≥+0.5 且 95%CI 不含 0）",
    nature: "fixture-statistical",
  },
  {
    id: "gate2-consistency-non-inferior",
    title: "门槛② 一致性非劣（Track A 机械门两臂全 PASS）",
    nature: "mechanical",
  },
  {
    id: "gate3-blind-kappa",
    title: "门槛③ 盲评 κ≥0.6",
    nature: "human-evaluation",
  },
  {
    id: "gate4-wallclock",
    title: "门槛④ 墙钟 ≤45min/章（per-stage 预算表推演）",
    nature: "mechanical",
  },
  {
    id: "gate5-write-storm-budget",
    title: "门槛⑤ 无写入风暴/预算违例（status-write-merge 合并写验证）",
    nature: "mechanical",
  },
]

function runAbMode(args) {
  if (!existsSync(VITEST_ENTRY)) {
    console.error("[t36] FATAL: 未找到 vitest 入口（先在 QMAI/ 内 npm install）:")
    console.error(`       ${VITEST_ENTRY}`)
    return 2
  }

  const evidencePath = mkdtempSync(join(tmpdir(), "t36-ab-evidence-"))
  const evidenceFile = join(evidencePath, "evidence.json")
  mkdirSync(evidencePath, { recursive: true })

  console.log("=" .repeat(78))
  console.log("T36 精品模式 A/B 验收（终端硬门）— TASK-P6-36")
  console.log("=" .repeat(78))
  console.log("")
  console.log("[t36] 步骤 1/2 — 驱动机械证据 spec (vitest):")
  console.log(`       ${T36_AB_SPEC_REL}`)
  console.log(`       evidence -> ${evidenceFile}`)

  const res = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", T36_AB_SPEC_REL],
    {
      cwd: QMAI_ROOT,
      stdio: "inherit",
      env: { ...process.env, T36_AB_EVIDENCE_PATH: evidenceFile },
    },
  )
  const vitestOk = res.status === 0

  console.log("")
  console.log("[t36] 步骤 2/2 — 五门逐项评估")

  if (!existsSync(evidenceFile)) {
    console.error(`[t36] FAIL: 证据文件未生成 (${evidenceFile})；vitest 退出码=${res.status}`)
    return 1
  }
  const evidence = JSON.parse(readFileSync(evidenceFile, "utf-8"))

  if (args.evidence) {
    const target = resolve(args.evidence)
    mkdirSync(resolve(target, ".."), { recursive: true })
    writeFileSync(target, JSON.stringify(evidence, null, 2))
    console.log(`[t36] 证据已落盘: ${target}`)
  }

  // ── 逐门判定 ──
  console.log("")
  console.log("================ T36 精品模式 A/B 验收 (五门逐项) ================")

  const gateResults = []

  // 门槛① 六维 overall 中位差
  const specStats = evidence.specStats
  const fixtureSignificant = specStats?.significant === true
  const gate1Pass = fixtureSignificant
  // 但 judgeSource=fixture-mock ⇒ 必须标 PENDING 而非 PASS
  const gate1Verdict = !gate1Pass ? "FAIL" : "PENDING"
  gateResults.push({ id: "gate1-six-dim-median-diff", verdict: gate1Verdict })
  console.log(
    `[${gate1Verdict}] 门槛① 六维 overall 中位差：` +
    `medianDiff=${specStats?.medianDiff?.toFixed(4) ?? "N/A"}, ` +
    `95%CI=[${specStats?.ciLow?.toFixed(4) ?? "N/A"}, ${specStats?.ciHigh?.toFixed(4) ?? "N/A"}], ` +
    `ciContainsZero=${specStats?.ciContainsZero ?? "N/A"}, ` +
    `significant=${fixtureSignificant}`
  )
  console.log(
    `       judgeSource=${evidence.meta?.judgeSource ?? "unknown"} ⇒ ` +
    `非真实 LLM 判官臂，统计机械可算但门槛① 必须标 PENDING（硬门纪律：绝不粉饰为 PASS）`
  )
  console.log(
    `       判官池 registry 路由（DEBT-20260828-t31b-01）: judgePool=${JSON.stringify(evidence.meta?.judgePool ?? [])} ` +
    `（DEFAULT_JUDGE_POOL，T36 真实补验轮 flash+ox 双异模型对；真实 LLM 臂接入时经 resolveJudgePool 路由）`
  )

  // 门槛② 一致性非劣（Track A）
  const baselineTrackA = evidence.arms?.baseline?.trackA
  const premiumTrackA = evidence.arms?.premium?.trackA
  const gate2Pass = baselineTrackA?.allPass === true && premiumTrackA?.allPass === true
  const gate2Verdict = gate2Pass ? "PASS" : "FAIL"
  gateResults.push({ id: "gate2-consistency-non-inferior", verdict: gate2Verdict })
  console.log(
    `[${gate2Verdict}] 门槛② 一致性非劣：` +
    `baseline consistencyErrors=${baselineTrackA?.consistencyErrors ?? "N/A"}, ` +
    `antiAiErrors=${baselineTrackA?.antiAiErrors ?? "N/A"} | ` +
    `premium consistencyErrors=${premiumTrackA?.consistencyErrors ?? "N/A"}, ` +
    `antiAiErrors=${premiumTrackA?.antiAiErrors ?? "N/A"}`
  )

  // 门槛③ 盲评 κ≥0.6
  const gate3Verdict = "PENDING"
  gateResults.push({ id: "gate3-blind-kappa", verdict: gate3Verdict })
  console.log(
    `[${gate3Verdict}] 门槛③ 盲评 κ≥0.6：环境不可达（需要人工盲评环境），` +
    `如实标注 PENDING——见盲评操作手册`
  )

  // 门槛④ 墙钟 ≤45min/章
  const baselineWall = evidence.wallclock?.baseline
  const premiumWall = evidence.wallclock?.premium
  const gate4Pass = baselineWall?.allChaptersWithinBudget === true &&
    premiumWall?.allChaptersWithinBudget === true
  const gate4Verdict = gate4Pass ? "PASS" : "FAIL"
  gateResults.push({ id: "gate4-wallclock", verdict: gate4Verdict })
  console.log(
    `[${gate4Verdict}] 门槛④ 墙钟 ≤45min/章：` +
    `baseline allWithinBudget=${!!baselineWall?.allChaptersWithinBudget}, ` +
    `premium allWithinBudget=${!!premiumWall?.allChaptersWithinBudget}`
  )

  // 门槛⑤ 无写入风暴/预算违例
  const storm = evidence.writeStorm
  const budget = evidence.budget
  const gate5Pass =
    storm?.hasPendingAfterFlush === false &&
    storm?.orderPreserved === true &&
    budget?.hardCapBreaches === 0
  const gate5Verdict = gate5Pass ? "PASS" : "FAIL"
  gateResults.push({ id: "gate5-write-storm-budget", verdict: gate5Verdict })
  console.log(
    `[${gate5Verdict}] 门槛⑤ 无写入风暴/预算违例：` +
    `hasPendingAfterFlush=${storm?.hasPendingAfterFlush}, ` +
    `orderPreserved=${storm?.orderPreserved}, ` +
    `hardCapBreaches=${budget?.hardCapBreaches}, ` +
    `mergedSubmissions=${storm?.mergedSubmissions}, ` +
    `actualDiskWrites=${storm?.actualDiskWrites}`
  )

  console.log("===============================================================")

  // ── 总判定 ──
  console.log("")
  const hasFail = gateResults.some((g) => g.verdict === "FAIL")
  const hasPending = gateResults.some((g) => g.verdict === "PENDING")

  if (hasFail) {
    console.log("[t36] 总判定: FAIL — 存在 FAIL 项（硬门纪律：如实上报，不得粉饰）")
    console.log("[t36] 建议: 精品模式保持 opt-in 默认关闭 + release notes 标注文案草案")
    return 1
  }
  if (hasPending) {
    console.log("[t36] 总判定: PENDING（机械可验项全 PASS，但存在 PENDING 项——需人工补验）")
    console.log("[t36] 建议: 精品模式保持 opt-in 默认关闭 + release notes 标注文案草案")
    console.log("[t36] 注: 根据蓝图 T36 契约，任一 PENDING/FAIL → 精品保持 opt-in 默认关闭；T36 本身可结案")
    return 0
  }
  console.log("[t36] 总判定: PASS — 五门全过（可推荐默认开启）")
  return 0
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  try {
    if (args.mode === "help") {
      console.log(USAGE)
      return 0
    }
    if (args.mode === "score") {
      return runScoreMode(args.input, args.json)
    }
    if (args.mode === "ab") {
      return runAbMode(args)
    }
    return runAcceptance(args.evidence)
  } catch (err) {
    console.error(`[offline-replay] ERROR: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
}

process.exit(main())
