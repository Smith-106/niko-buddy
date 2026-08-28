/**
 * verify-dod-v268.js — v2.6.8 DoD 断言（蓝图 blueprint-v268 §3）
 *
 * 断言：D1 校准基线 / D2 地板闸 / D3 意图单射 / D4 决策点 / D5 改写判据
 * 用法：node scripts/verify-dod-v268.js
 */
import { buildCalibrationBaseline, verifyDeterminism, RUBRIC_VERSION } from "../src/lib/quality/calibration-baseline.ts"
import { evaluateFloorGate, verifyGatePriority } from "../src/lib/quality/floor-gate.ts"
import { diagnoseIntent, DEFAULT_INTENT_SIGNALS, isProtected } from "../src/lib/quality/intent-injection.ts"
import { appendEvent, validateChain, isWhitelistedAnchor } from "../src/lib/quality/decision-points.ts"
import { evaluateRewriteCriteria, classifyRewrite } from "../src/lib/quality/rewrite-criteria.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// D1: 校准基线（rubric 冻结 + 确定性）
const mk = (id, b) => ({ chapterId: id, scores: { thril: b, pacing: b + 0.5, pull: b + 1, context: b + 0.5, consistency: b + 1.5, anti_ai: b + 1 } })
const chapters = [mk("c1", 8.0), mk("c2", 8.2), mk("c3", 8.4), mk("c4", 8.6), mk("c5", 8.8)]
const bl1 = buildCalibrationBaseline(chapters)
const bl2 = buildCalibrationBaseline(chapters)
check("D1 rubric 版本冻结", bl1.rubricVersion === RUBRIC_VERSION)
check("D1 确定性（同输入同输出）", verifyDeterminism(bl1, bl2))
check("D1 N≥5 样本", bl1.sampleCount >= 5)

// D2: 地板闸（单维一票否决 + 只挡回填 + 优先级）
const gate = (scores, isBackfill = true) => evaluateFloorGate({ chapterId: "ch1", scores, sampleCount: 40, isBackfill })
const good = { thril: 8.5, pacing: 8.5, pull: 8.5, context: 8.5, consistency: 9.2, anti_ai: 8.8, quality: 8.8 }
check("D2 全维达标通过", gate(good).pass === true)
check("D2 consistency<9.0 一票否决", gate({ ...good, consistency: 8.9 }).pass === false)
check("D2 草稿修正不拦（守 Draft-first）", gate({ ...good, consistency: 8.0 }, false).pass === true)
check("D2 门控优先级（P0 失败整体非 PASS）", verifyGatePriority([gate({ ...good, consistency: 8.0 }), gate(good)]))

// D3: 意图单射（诊断 + 伏笔保护）
check("D3 意图直译命中", diagnoseIntent("她想离开，她走向门口。", DEFAULT_INTENT_SIGNALS, "i1").length > 0)
check("D3 伏笔受保护", isProtected("[foreshadowing] 伏笔") === true)
check("D3 干净文本零命中", diagnoseIntent("雨落在窗台上。", DEFAULT_INTENT_SIGNALS, "i2").length === 0)

// D4: 决策点（append-only + hash 链 + 白名单）
const r1 = appendEvent([], { chapterId: "ch1", description: "d1", isCausalHub: true, ts: "t1" })
const r2 = appendEvent(r1.chain, { chapterId: "ch1", description: "d2", isCausalHub: false, ts: "t2" })
check("D4 append-only 追加", r1.ok === true && r2.ok === true)
check("D4 hash 链完整", validateChain(r2.chain).valid === true)
check("D4 锚件白名单", isWhitelistedAnchor("不可逆决策点") === true)

// D5: 改写判据（复合触发 + P0 短路 + 二分类）
check("D5 复合触发（2 软维+中位<9）", evaluateRewriteCriteria({ softBreached: ["thril", "pacing"], overallMedian: 8.8, p0Failed: false }).shouldRewrite === true)
check("D5 P0 失败抑制改写", evaluateRewriteCriteria({ softBreached: ["thril", "pacing", "pull"], overallMedian: 8.0, p0Failed: true }).shouldRewrite === false)
check("D5 触锚点=不可逆", classifyRewrite({ description: "改名", touchesAnchor: true, anchorType: "character_name" }).klass === "irreversible")

console.log(failures === 0 ? "\nDoD v2.6.8: ALL PASS" : `\nDoD v2.6.8: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
