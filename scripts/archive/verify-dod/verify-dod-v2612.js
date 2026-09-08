/**
 * verify-dod-v2612.js — v2.6.12 DoD 断言（蓝图 blueprint-v2612 §5）
 *
 * 三闭环断言：①W1 知情接受 ②W2 主动召回 ③测试 W3 变异分水岭+冷评出关
 * 用法：node scripts/verify-dod-v2612.js
 */
import { buildReasonCard, informedAcceptRate } from "../src/lib/quality/informed-accept.ts"
import { recallSuccessRate, filterRecallCandidates } from "../src/lib/quality/memory-recall.ts"
import { extractStyleSignature, buildScaffold } from "../src/lib/quality/style-scaffold.ts"
import { evaluateColdReview } from "../src/lib/quality/weekly-cold-review.ts"
import { mutationKillScore } from "../src/lib/quality/mutation-watershed.ts"
import { evaluateChaosRegression } from "../src/lib/quality/chaos-regression.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① W1 知情接受：注入 accept 事件 → 理由卡生成（可回溯锚点）+ 接受率口径
const card = buildReasonCard([
  { gate: "consistency", anchor: "ch3:para12", evidence: "人物名一致" },
  { gate: "anti_ai", anchor: "ch3:para15", evidence: "无 AI 痕迹" },
])
check("① 理由卡生成（可回溯锚点）", card.traceable === true && card.reasons.length === 2)
check("① 知情接受率 ≥90% 硬门（N≥50）", informedAcceptRate(48, 50).pass === true)
check("① 样本不足不判", informedAcceptRate(10, 10).pass === false)

// ② W2 主动召回：注入固化记忆 → 召回→accept 链路（防刷量口径）
const items = Array.from({ length: 30 }, (_, i) => ({
  id: `m${i}`,
  confidence: 0.8,
  status: i < 24 ? "accepted" : "rejected",
}))
check("② 召回→accept 成功率 ≥70%（N≥30）", recallSuccessRate(items).pass === true)
check("② 展示不计数（pending 不计分子）", recallSuccessRate(Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, confidence: 0.8, status: i < 10 ? "accepted" : "pending" }))).rate === 10 / 30)
check("② 低置信度不打扰", filterRecallCandidates([{ id: "m1", confidence: 0.9 }, { id: "m2", confidence: 0.3 }], 0.7).length === 1)

// ③ 测试 W3 变异分水岭 + 冷评出关
const mutants = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, similarity: 0.5, killed: i < 8 }))
check("③ 变异 kill score ≥80%（影子分支）", mutationKillScore(mutants).pass === true)
check("③ 冷评出关 ≥9.0（Consistency 独立 PASS）", evaluateColdReview([9.2, 9.0, 9.1, 9.3, 9.0], true).passed === true)
check("③ Consistency(P0) 失败不出关", evaluateColdReview([9.2, 9.0, 9.1, 9.3, 9.0], false).passed === false)

// W4 风格脚手架 + 混沌回归补充断言
const sig = extractStyleSignature([{ sentenceLength: 20, dialogue: true, fastPaced: true }])
check("W4 风格脚手架（可选+可关闭）", buildScaffold(sig, false).enabled === false && buildScaffold(sig, true).enabled === true)
check("测试 W3 混沌回归 0 阻断级失败", evaluateChaosRegression([{ target: "memory", blockingFailure: false, whitelisted: false }]).pass === true)

console.log(failures === 0 ? "\nDoD v2.6.12: ALL PASS" : `\nDoD v2.6.12: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
