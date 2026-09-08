/**
 * verify-dod-v2613.js — v2.6.13 DoD 断言（蓝图 blueprint-v2613 §5）
 *
 * 三闭环断言：①W4 压测 ②双门认证 ③W3 显影闭环
 * 用法：node scripts/verify-dod-v2613.js
 */
import { evaluateStress } from "../src/lib/quality/adversarial-stress.ts"
import { certifyDualGate } from "../src/lib/quality/dual-gate-certify.ts"
import { evaluateIndependentReproduce } from "../src/lib/quality/independent-reproduce.ts"
import { evaluateValueReveal } from "../src/lib/quality/value-reveal.ts"
import { evaluateConsensusRereview } from "../src/lib/quality/consensus-rereview.ts"
import { evaluateDodCloseout } from "../src/lib/quality/dod-closeout.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① W4 压测：注入三路对抗样本 → 通过率显著下降（p<0.05 AND ≥30%）+ 零交集
const samples = Array.from({ length: 30 }, (_, i) => ({
  id: `a${i}`, attack: "rewrite", overlapsValidation: false, passed: i < 15,
}))
const stress = evaluateStress(samples, 0.9)
check("① 压测通过率显著下降（降幅≥30% 且绝对≥5pp）", stress.significant === true && stress.valid === true)
check("① 对抗集与验收集零交集（N≥30）", stress.valid === true)

// ② 双门认证：四项 AND（中位≥9.5/σ<0.3/Δ<0.15/跨种子≥9.0）分章口径
const gate = certifyDualGate([
  { chapter: 1, scores: [9.5, 9.6, 9.5, 9.7, 9.5], baselineMedian: 9.5 },
  { chapter: 2, scores: [9.5, 9.5, 9.6, 9.5, 9.5], baselineMedian: 9.5 },
])
check("② 双门四项 AND 全过（分章口径）", gate.certified === true)
check("② 任一章不过即整书不过", certifyDualGate([{ chapter: 1, scores: [9.0, 9.9, 9.0, 9.9, 9.0], baselineMedian: 9.5 }]).certified === false)
const repro = evaluateIndependentReproduce([[9.0, 9.1, 9.0], [9.0, 9.0, 9.2], [9.1, 9.0, 9.0]], 9.2)
check("② 跨种子独立复现≥9.0（硬门）+ 换模型泛化补证", repro.hardPass === true && repro.crossModelMedian === 9.2)

// ③ W3 显影闭环：三态链路完整 + 熔断降级
const reveal = evaluateValueReveal(100, 80, 60, 60)
check("③ 曝光→感知→采纳链路完整（埋点覆盖）", reveal.coverageComplete === true && reveal.writeRate >= 0.99)
check("③ 熔断降级路径（不阻塞发版）", evaluateValueReveal(100, 80, 60, 60, true).degraded === true)

// 补充断言：7 方向共识复核 + DoD 收口
const consensus = evaluateConsensusRereview({
  dev: [[9.5, 9.6], [9.5, 9.5]], writing: [[9.6, 9.5], [9.5, 9.6]],
})
check("7 方向共识分复核 ≥9.5", consensus.passed === true)
check("DoD 收口（100% 勾选+DEFER 登记+集成干净）", evaluateDodCloseout(10, 10, true, true).complete === true)

console.log(failures === 0 ? "\nDoD v2.6.13: ALL PASS" : `\nDoD v2.6.13: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
