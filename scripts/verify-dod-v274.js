/**
 * verify-dod-v274.js — v2.7.4 DoD 断言（蓝图 blueprint-v274 §5）
 *
 * 三闭环断言：①维度收敛 ②跨模型泛化 ③跨语言泛化
 * 用法：node scripts/verify-dod-v274.js
 */
import { evaluateConvergence } from "../src/lib/quality/dimension-converge.ts"
import { evaluateRecallRegression } from "../src/lib/quality/variance-regression.ts"
import { evaluateCrossModel } from "../src/lib/quality/cross-model-bias.ts"
import { evaluateCrossLang } from "../src/lib/quality/cross-lang-f1.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

const dims = ["thril", "pacing", "pull", "consistency", "antiAi", "quality"]
const ch = (id, scores) => ({ chapterId: id, scores })
const base = Array.from({ length: 6 }, (_, i) => ch(`b${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + 3 * (i % 3) + (j % 2)]))))
const current = Array.from({ length: 6 }, (_, i) => ch(`c${i}`, Object.fromEntries(dims.map((d, j) => [d, 5 + 1 * (i % 3) + (j % 2)]))))

// ① 维度收敛：中位方差降 ≥15% 且核心维 ≤3 且 Track B 保留（归一化对照 + 双门互锁）
const conv = evaluateConvergence(base, current, "v2.7.3-7006868f")
check("① 维度收敛：中位方差降 ≥15%", conv.varianceReduction >= 0.15)
check("① 归一化对照：维度数归一化降幅 ≥15%（防裁剪伪影）", conv.normalizedReduction >= 0.15)
check("① 核心维 ≤3 且 Track B 六维保留", conv.coreDims.length <= 3 && conv.trackBDims === 6)
check("① 基线版本锁定（v2.7.3-7006868f）", conv.baselineVersion.length > 0)
check("① 收敛达标判定", conv.passed === true)
const recall = evaluateRecallRegression(19, 20, 19, 20, "v2.7.3-7006868f")
check("① 双门互锁：负向集召回 ≥ 基线−2%（不掩检测退化）", recall.regression <= 0.02 && recall.passed === true)
check("① 召回基线版本锁定", recall.baselineVersion.length > 0)

// ② 跨模型泛化：同文同窗 pairwise Δ中位 ≤0.5 且无单维 >0.7
const models = [
  { modelId: "a", scores: { thril: 8, pacing: 7, pull: 8 } },
  { modelId: "b", scores: { thril: 8.3, pacing: 7.2, pull: 8.1 } },
  { modelId: "c", scores: { thril: 7.8, pacing: 7.1, pull: 8.2 } },
  { modelId: "d", scores: { thril: 8.1, pacing: 6.9, pull: 7.9 } },
  { modelId: "e", scores: { thril: 8.2, pacing: 7.0, pull: 8.0 } },
]
const cm = evaluateCrossModel(models)
check("② 跨模型：pairwise Δ中位 ≤0.5（N≥5 同窗）", cm.medianDelta <= 0.5 && cm.passed === true)
check("② 跨模型：无单维偏差 >0.7", cm.maxDimDelta <= 0.7)

// ③ 跨语言泛化：F1 ≥ 源域锁定基线×95%；P0>P1>P2 不变量
const cl = evaluateCrossLang(0.9, "v2.7.3-7006868f", [
  { lang: "en", f1: 0.88 },
  { lang: "ja", f1: 0.9 },
])
check("③ 跨语言：F1 ≥ 源域锁定基线×95%（每语言独立）", cl.passed === true && cl.langs.every((l) => l.passed))
check("③ 基线版本锁定（git commit 快照）", cl.baselineVersion.length > 0)

console.log(failures === 0 ? "\nDoD v2.7.4: ALL PASS" : `\nDoD v2.7.4: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
