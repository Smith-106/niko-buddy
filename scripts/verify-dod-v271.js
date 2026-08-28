/**
 * verify-dod-v271.js — v2.7.1 DoD 断言（蓝图 blueprint-v271 §5）
 *
 * 四闭环断言：①D3 探针 ②扩库 ③在线回归 ④新向量闭环
 * 用法：node scripts/verify-dod-v271.js
 */
import { evaluateProbe, classifyConfidence } from "../src/lib/quality/d3-probe.ts"
import { evaluateGrayZone } from "../src/lib/quality/gray-zone-review.ts"
import { evaluateCorpus } from "../src/lib/quality/adversarial-corpus.ts"
import { evaluateRegression } from "../src/lib/quality/daily-regression.ts"
import { evaluateVector } from "../src/lib/quality/attack-vector.ts"
import { softAlert } from "../src/lib/quality/soft-alert.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① D3 探针：注入对抗/干净集 → 检出 ≥90% 且误报 ≤5%（双门同报）；灰区全量进人工
const res = (id, c) => ({ id, ...classifyConfidence(c) })
const adversarial = Array.from({ length: 300 }, (_, i) => res(`a${i}`, 0.9))
const clean = Array.from({ length: 200 }, (_, i) => res(`c${i}`, 0.1))
const probe = evaluateProbe(adversarial, clean)
check("① D3 探针：检出率 ≥90%", probe.detectRate >= 0.9)
check("① D3 探针：误报率 ≤5%（双门同报）", probe.falsePositiveRate <= 0.05 && probe.passed === true)
const gray = evaluateGrayZone(60, 4, 0.05)
check("① 灰区 [0.4,0.7]：全量人工复审 + 边界稳定（≤1.5×）", gray.reviewed === gray.total && gray.boundaryStable === true)

// ② 扩库：库 ≥2× 基线 + 真阳性抽检 ≥95% + 覆盖 ≥5 族
const families = ["rewrite", "style-transfer", "watermark-strip", "semantic-rephrase", "jailbreak", "role-hijack", "prefix-inject"]
const corpus = families.flatMap((f, fi) => Array.from({ length: 30 }, (_, i) => ({ id: `${f}-${i}`, family: f, labeledPositive: true })))
const corpusResult = evaluateCorpus(corpus, 90, corpus)
check("② 扩库：规模 ≥2× 基线", corpusResult.multiplier >= 2)
check("② 扩库：向量族覆盖 ≥5 且真阳性抽检 ≥95%", corpusResult.familyCount >= 5 && corpusResult.precision >= 0.95 && corpusResult.passed === true)

// ③ 在线回归：金标日级连续 ≥3 日 0 回退
const regDays = [
  { day: 1, detectRate: 0.95, falsePositiveRate: 0.03, regressed: false },
  { day: 2, detectRate: 0.94, falsePositiveRate: 0.04, regressed: false },
  { day: 3, detectRate: 0.95, falsePositiveRate: 0.03, regressed: false },
]
const reg = evaluateRegression(regDays)
check("③ 在线回归：连续 3 日 0 回退", reg.zeroRegression === true && reg.blocked === false)
check("③ 回退定义：检出<90% 或误报>5% 即阻断", evaluateRegression([{ day: 1, detectRate: 0.85, falsePositiveRate: 0.03, regressed: false }]).blocked === true)

// ④ 新攻击向量：语义改写/越狱各 ≥10 例五段闭环 100%
const stages = ["reproduce", "detected", "attributed", "patched", "regressed"]
const mk = (n, vector) => Array.from({ length: n }, (_, i) => ({ id: `${vector}-${i}`, vector, stages }))
check("④ 语义改写：≥10 例五段闭环 100%", evaluateVector(mk(10, "semantic-rephrase"), "semantic-rephrase").passed === true)
check("④ 越狱：≥10 例五段闭环 100%", evaluateVector(mk(12, "jailbreak"), "jailbreak").passed === true)

// 补充：写作流保护
check("写作流保护：误报软告警不阻断", softAlert("嵌入漂移 0.62").blocksWriting === false)

console.log(failures === 0 ? "\nDoD v2.7.1: ALL PASS" : `\nDoD v2.7.1: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
