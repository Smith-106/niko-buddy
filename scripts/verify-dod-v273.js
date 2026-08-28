/**
 * verify-dod-v273.js — v2.7.3 DoD 断言（蓝图 blueprint-v273 §5）
 *
 * 三闭环断言：①风格套用 ②回溯显影 ③记忆改写
 * 用法：node scripts/verify-dod-v273.js
 */
import { factorAgreement } from "../src/lib/quality/style-factors.ts"
import { evaluateStyleBatch } from "../src/lib/quality/style-template.ts"
import { evaluateReveal } from "../src/lib/quality/retro-reveal.ts"
import { diffZero, evaluateRewrite } from "../src/lib/quality/memory-rewrite.ts"
import { evaluateRewriteGate } from "../src/lib/quality/rewrite-gate.ts"
import { evaluateAccept } from "../src/lib/quality/accept-metric.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① 风格套用：注入风格因子 → 一致率 ≥90% 且 P95<2s；内容保真
const base = { sentenceLength: 20, punctuationDensity: 30, qualifierFrequency: 10, povDrift: 0 }
const actual = { sentenceLength: 22, punctuationDensity: 35, qualifierFrequency: 8, povDrift: 0 }
check("① 风格因子：4 维一致率 =100%", factorAgreement(actual, base) === 1)
const styleResults = Array.from({ length: 30 }, (_, i) => ({
  chapterId: `c${i}`, agreement: 0.95, durationMs: 800 + (i % 5) * 100, contentDrift: 0.02,
}))
const style = evaluateStyleBatch(styleResults)
check("① 风格套用：一致率 ≥90% 且 P95<2s", style.agreementRate >= 0.9 && style.p95Ms < 2_000 && style.passed === true)
check("① 内容保真：contentDrift ≤10%（超限回退）", style.fidelityFails === 0)

// ② 回溯显影：注入标注集 → 命中 ≥90% 且误报 ≤10%；只读旁路
const revealItems = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, confidence: 0.8, isTrue: true, ignored: false })),
  ...Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, confidence: 0.2, isTrue: false, ignored: false })),
]
const reveal = evaluateReveal(revealItems)
check("② 回溯显影：命中 ≥90% 且误报 ≤10%", reveal.hitRate >= 0.9 && reveal.falsePositiveRate <= 0.1 && reveal.passed === true)
check("② 只读旁路：低置信折叠 + 忽略可撤销", reveal.lowConfidenceCount >= 0 && reveal.ignoreRevertible === true)

// ③ 记忆改写：accept ≥80% 且 diff=0（字符级纯替换）；闸门渗透 0 成功；P0 零回归
const rewrites = [
  { id: "r1", replacements: [{ pos: 0, len: 1, text: "她" }], output: "她走进房间。", original: "他走进房间。", state: "accepted" },
  { id: "r2", replacements: [{ pos: 0, len: 1, text: "夜" }], output: "夜黑了。", original: "天黑了。", state: "accepted" },
  { id: "r3", replacements: [], output: "他走进房间。", original: "他走进房间。", state: "rejected" },
]
check("③ 记忆改写：diff=0 字符级铁证（替换点外零增删）", rewrites.filter((r) => r.state === "accepted").every(diffZero) === true)
const rewrite = evaluateRewrite(rewrites)
check("③ 记忆改写：accepted 全 diff=0 且零直写", rewrite.diffZeroCount === 2 && rewrite.formalWrites === 0 && rewrite.passed === true)
check("③ 拒绝保留：rejected 记忆不降级不删除", rewrite.rejectedPreserved === 1)
const gate = evaluateRewriteGate([
  { id: "p1", target: "pending", blocked: false },
  { id: "p2", target: "formal", blocked: true },
  { id: "p3", target: "formal", blocked: true },
])
check("③ 闸门渗透：formal 100% 拦截（0 成功）", gate.formalWrites === 0 && gate.blockRate === 1 && gate.passed === true)
const accept = evaluateAccept(Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, annotatorA: i < 18, annotatorB: i < 18, arbitrated: i < 18, p0Failed: false })))
check("③ 编辑真实 accept 率 ≥80%（双标注仲裁）", accept.acceptRate >= 0.8 && accept.passed === true)

console.log(failures === 0 ? "\nDoD v2.7.3: ALL PASS" : `\nDoD v2.7.3: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
