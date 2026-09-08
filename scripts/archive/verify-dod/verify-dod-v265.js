/**
 * verify-dod-v265.js — v2.6.5 DoD 断言（蓝图 blueprint-v265 §3）
 *
 * 断言：severity 枚举 / 降级封顶 / 迁移纯函数 / 回执三块 / 稳定性
 * 用法：node scripts/verify-dod-v265.js
 */
import { evaluateSeverity } from "../src/lib/novel/adversarial/severity-gate.ts"
import { migrateScores } from "../src/lib/novel/adversarial/score-migration.ts"
import { validateReceipt } from "../src/lib/novel/adversarial/appeal-receipt.ts"
import { isStable } from "../src/lib/novel/adversarial/appeal-receipt.ts"
import { assertCoverage } from "../src/lib/novel/adversarial/plain-language.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// D1: 降级封顶（降级永不触发硬否决）
check("D1 降级封顶: degraded+hard_block → suggestion", evaluateSeverity("hard_block", "degraded").severity === "suggestion")
check("D1 降级封顶: degraded 下无 hard_block", evaluateSeverity("suggestion", "degraded").severity !== "hard_block")

// D2: 迁移纯函数（旧分保留 + legacy）
const migrated = migrateScores([{ chapterId: "c1", overall: 8.2, dimensions: {}, baselineVersion: "v2.6.4", legacy: false }], "v2.6.4")
check("D2 旧分保留: overall 不变", migrated.records[0].overall === 8.2)
check("D2 legacy 标记", migrated.records[0].legacy === true)
check("D2 schemaVersion 递增", migrated.schemaVersion === "score-schema-v2")

// D3: 术语覆盖（全部维度术语有白话）
const terms = ["LLR", "对抗回归集", "分层召回", "原笔指纹", "漂移阈值", "ContextPack", "六维 overall", "thril", "pacing", "pull", "Consistency(P0)", "Anti-AI(P1)", "Quality(P2)", "重标定", "漂移幅度", "因子链", "基线版本", "责任判官", "L9 复验"]
check("D3 术语覆盖: 无缺失", assertCoverage(terms).length === 0)

// D4: 回执三块 + 稳定性
const receipt = { receiptId: "R-1", factorChain: ["a"], baselineVersion: "v2.6.4", referenceAnchors: ["b"], verdict: "degraded", confidence: "medium", degradationNote: "无", plainSummary: "s" }
check("D4 回执三块完整", validateReceipt(receipt).length === 0)
check("D4 稳定性 N≥3 差≤0.5", isStable([9.0, 9.1, 9.2]) === true)
check("D4 稳定性 N<3 不稳定", isStable([9.0, 9.1]) === false)

console.log(failures === 0 ? "\nDoD v2.6.5: ALL PASS" : `\nDoD v2.6.5: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
