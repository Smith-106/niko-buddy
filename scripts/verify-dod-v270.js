/**
 * verify-dod-v270.js — v2.7.0 DoD 断言（蓝图 blueprint-v270 §5）
 *
 * 三闭环断言：①解耦证明 ②换模型硬门 ③冷评自动结案
 * 用法：node scripts/verify-dod-v270.js
 */
import { evaluateDecoupling } from "../src/lib/quality/gate-decoupling.ts"
import { evaluateModelSwitch, verifyZeroMissed } from "../src/lib/quality/model-switch-gate.ts"
import { verifyVersionLock } from "../src/lib/quality/version-lock.ts"
import { evaluateAutoCloseout } from "../src/lib/quality/auto-closeout.ts"
import { buildAuditReport } from "../src/lib/quality/audit-report.ts"
import { guardDraft } from "../src/lib/quality/draft-guard.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① 解耦证明：注入 3 模型评分 → 决策级一致率 ≥95%（CI≥90%）且翻转=0
const trio = (v) => [{ model: "m1", verdict: v }, { model: "m2", verdict: v }, { model: "m3", verdict: v }]
const decoupling = evaluateDecoupling(Array.from({ length: 40 }, () => trio("pass")))
check("① 解耦证明：决策级一致率 ≥95%", decoupling.rate >= 0.95)
check("① 解耦证明：95%CI 下限 ≥90%", decoupling.ciLower >= 0.9)
check("① 解耦证明：结论翻转=0（红线）", decoupling.flips === 0 && decoupling.proven === true)

// ② 换模型硬门：注入模型变更 → 触发 100% 且漏报=0
const fp = (model, version = "1.0", weight = "w1") => ({ model, version, weightHash: weight })
const samples = Array.from({ length: 20 }, (_, i) => ({ baseline: fp("m1"), current: fp(`m${i + 2}`) }))
check("② 换模型硬门：注入变更全触发（漏报=0）", verifyZeroMissed(samples).pass === true)
check("② 换模型硬门：权重哈希变更触发", evaluateModelSwitch(fp("m1", "1.0", "w1"), fp("m1", "1.0", "w2")).triggered === true)

// ③ 冷评自动结案：P0/P1 自动 + P2 回退 + 兜底 ≤10% + 审计完整
const chapters = Array.from({ length: 20 }, (_, i) => ({
  id: `c${i}`, gates: { p0: true, p1: true, p2: true }, p2Score: 9, p2Sigma: 0.5,
}))
const closeout = evaluateAutoCloseout(chapters)
check("③ 冷评自动结案率 ≥90%（零人工）", closeout.autoRate >= 0.9 && closeout.passed === true)
check("③ 兜底率 ≤10%", closeout.fallbackRate <= 0.1)
const audit = buildAuditReport(Array.from({ length: 20 }, (_, i) => ({
  chapterId: `c${i}`, verdict: "pass", gateDetail: "p0 ok; p1 ok; p2 9.0", buildHash: "h1", modelId: "m1", closedBy: "auto",
})))
check("③ 审计报告 100% 完整（可追溯）", audit.complete === true)

// 补充：版本锁 + Draft-first 守卫
const lock = (bundle, binary) => ({ artifacts: { bundle, binary }, config: { prompt: "p1", temperature: "0.7", weights: "w1" } })
check("版本锁：哈希一致不阻断", verifyVersionLock(lock("h1", "h2"), lock("h1", "h2")).blocked === false)
check("版本锁：失配 fail-fast", verifyVersionLock(lock("h1", "h2"), lock("h1-x", "h2")).blocked === true)
check("Draft-first：结案只落 pending/ready", guardDraft("pending").allowed === true && guardDraft("formal").allowed === false)

console.log(failures === 0 ? "\nDoD v2.7.0: ALL PASS" : `\nDoD v2.7.0: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
