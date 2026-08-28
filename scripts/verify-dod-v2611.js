/**
 * verify-dod-v2611.js — v2.6.11 DoD 断言（蓝图 blueprint-v2611 §3）
 *
 * 三闭环断言：①D6 漂移→灰区复核 ②D7 P0 失败→锁死 ③D8 漂移门→Q0 重审计
 * 用法：node scripts/verify-dod-v2611.js
 */
import { buildFingerprint, detectDrift, verifyAnchorKey } from "../src/lib/quality/domain-drift-baseline.ts"
import { evaluateCrossDimension } from "../src/lib/quality/cross-dimension-gate.ts"
import { evaluateFullWindowDrift, verifyZeroFalseKill } from "../src/lib/quality/full-window-drift-gate.ts"
import { evaluateP0Lock, closeLockedItem, verifyLockScope, verifyNoQualityOverride } from "../src/lib/quality/p0-lock.ts"
import { monitorFdr } from "../src/lib/quality/fdr-monitor.ts"
import { evaluateGrayZone, kappaAgreement } from "../src/lib/quality/gray-zone-review.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// ① D6 漂移→灰区复核：注入已知漂移样本 → pending 复核条目
const gray = evaluateGrayZone(0.5)
check("① 漂移→灰区复核（pending 条目）", gray.inGrayZone === true && gray.reviewEntry?.status === "pending" && gray.reviewEntry?.source === "drift")
check("① 灰区 100% 入复核队列（无静默丢弃）", evaluateGrayZone(0.48).reviewEntry !== null)
check("① Kappa≥0.7 生效", kappaAgreement([true, true, false], [true, true, false]) >= 0.7)

// ② D7 P0 失败→锁死：注入 P0 失败 → BLOCK + Quality 不得覆盖
const lock = evaluateP0Lock(["consistency"], ["q0-item-1"])
check("② P0 失败→LOCKED+BLOCK", lock.state === "LOCKED" && lock.blocked === true)
check("② 锁触发输出集=P0∪D8 未清（禁止静默清零）", lock.lockedItems.includes("consistency") && lock.lockedItems.includes("q0-item-1"))
check("② 显式 close 才缩减（未列名项不清零）", closeLockedItem({ p0Failures: ["consistency"], q0Pending: ["q0-item-1"] }, "consistency").q0Pending.length === 1)
check("② 锁死严格限定 P0", verifyLockScope(["consistency"], ["consistency", "anti_ai"]) === true)
check("② 对抗性负向：Quality 高分不得解锁", verifyNoQualityOverride(lock, 9.5) === true)

// ③ D8 漂移门→Q0 重审计：构造跨阈漂移 → 触发重检
const drift = evaluateFullWindowDrift([0.5, 0.5, 0.5, 1.0, 1.0, 1.0])
check("③ 跨阈漂移→触发重检", drift.triggered === true && drift.chaptersToRecheck.length > 0)
check("③ 合法手法零误杀", verifyZeroFalseKill([[0.5, 0.52, 0.48, 0.51, 0.5, 0.49]], evaluateFullWindowDrift) === true)

// 硬门 4 补充断言（D1/D4）
const fp = buildFingerprint([[1, 2, 3], [1.1, 2.1, 3.1], [0.9, 1.9, 2.9]])
check("D1 三元组锚定", verifyAnchorKey({ chapter: 3, model: "m", prompt: "p" }) === true)
check("D1 同分布无漂移", detectDrift(fp, [1, 2, 3]).drifted === false)
check("D4 单维矛盾→灰区（不杀）", evaluateCrossDimension({ thril: 9.0, pacing: 6.0, pull: 8.0, context: 8.0, consistency: 9.0, anti_ai: 8.0 }).verdict === "gray")

// 观测 2（D2/D6 留痕）
check("观测 D2 FDR 监控留痕", monitorFdr([0.01]).observationOnly === true)

console.log(failures === 0 ? "\nDoD v2.6.11: ALL PASS" : `\nDoD v2.6.11: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
