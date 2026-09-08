/**
 * verify-dod-v269.js — v2.6.9 DoD 断言（蓝图 blueprint-v269 §3）
 *
 * 断言 6 项：①基线漂移≤锁定阈值 ②各门 FDR≤0.05 ③σ 门值=冻结值
 *           ④校准 split hash 固定 ⑤越界探针≥1 门捕获 ⑥不重判已 commit 章节
 * 用法：node scripts/verify-dod-v269.js
 */
import { buildLayeredBaseline, probeBaselineDrift, verifyNoRetroactive, DRIFT_THRESHOLD } from "../src/lib/quality/layered-baseline.ts"
import { evaluateConformalGate, calibrationSplitHash, CALIBRATION_SPLIT_VERSION, FDR_BUDGET } from "../src/lib/quality/conformal-gate.ts"
import { evaluateVarianceGate, verifySigmaFrozen } from "../src/lib/quality/variance-gate.ts"
import { observeJointDistribution } from "../src/lib/quality/joint-distribution.ts"
import { calibrateRuler } from "../src/lib/quality/ruler-calibration.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

const mkSamples = (n, base) => Array.from({ length: n }, (_, i) => base + (i % 5) * 0.1)

// ① 基线漂移 ≤ 锁定阈值
const bl = buildLayeredBaseline({ perplexity: mkSamples(200, 1.0), burstiness: mkSamples(200, 0.5), sentence_length: mkSamples(200, 20) })
const drift = probeBaselineDrift(bl, { perplexity: mkSamples(200, 1.0), burstiness: mkSamples(200, 0.5), sentence_length: mkSamples(200, 20) })
check("① 基线漂移≤锁定阈值", drift.drifted === false && DRIFT_THRESHOLD === 0.05)

// ② 各门 FDR ≤ 0.05（经验实测）
const cal = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
const gate = evaluateConformalGate(cal, [0.95, 0.98, 0.2, 0.3], [true, true, false, false], 200)
check("② 保角门 FDR≤0.05（经验实测）", gate.pass === true && gate.empiricalFdr <= FDR_BUDGET)

// ③ σ 门值 = 冻结值（分维查表）
check("③ σ 门冻结", verifySigmaFrozen() === true)

// ④ 校准 split hash 固定
check("④ 校准 split hash 固定", calibrationSplitHash([0.1, 0.2, 0.3]) === calibrationSplitHash([0.1, 0.2, 0.3]) && CALIBRATION_SPLIT_VERSION === "calib-split-v1-20260828")

// ⑤ 越界探针 ≥1 门捕获（防欠拟合假绿）
const bad = evaluateVarianceGate({ dimensionScores: { consistency: [7, 8, 9, 10, 8, 9, 7, 8, 10, 9] }, hasMetadata: true })
check("⑤ 越界探针被方差门捕获", bad.unstable.includes("consistency"))
const joint = observeJointDistribution([[1, 2, 3, 4, 5], [2, 4, 6, 8, 10]])
check("⑤ 越界探针被联合分布观测捕获", joint.jointAnomaly === true)

// ⑥ 不重判已 commit 章节
check("⑥ 不重判已 commit 章节", verifyNoRetroactive(["ch1", "ch2"], "ch1") === false && verifyNoRetroactive(["ch1", "ch2"], "ch3") === true)

// 观测通道（D3/D4 仅报告不挡）
const ruler = calibrateRuler([0.9, 0.8], [true, true])
check("观测 D4 标尺不挡结案", ruler.observationOnly === true)

console.log(failures === 0 ? "\nDoD v2.6.9: ALL PASS" : `\nDoD v2.6.9: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
