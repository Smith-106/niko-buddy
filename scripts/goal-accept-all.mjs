// goal-accept-all.mjs — 验收总入口（RV-155 默认拒绝消费者契约 + RV-158 全量退出码分类）。
// Run from workspace root: node QMAI/scripts/goal-accept-all.mjs
// 语义：顺序运行 r1r2 → r3r4 → r567（RV-144 按路径作用域：任一脚本 ENV-FAULT 即 headline 中止，
//   其先行 PASS 已在各脚本内标注为非验收）；任一脚本 FAIL 即中止（headline FAIL）。
// default-deny：子脚本 exit≠0 ∨ 输出缺 CHECKS 行 ∨ CHECKS 不可解析 ⇒ ENV-FAULT（exit 2），
//   永不因“账本缺失”读出 PASS（RV-155 静默放行窗口关闭）。
// RV-158 全量映射：0=pass；1=断言失败；2=环境故障；124/126/127/130/137/143/信号终止 ⇒ ENV-FAULT(2)；
//   3 及其他未列出非零 ⇒ ENV-FAULT 兜底（fail-safe：未知 ⇒ 环境问题，绝不降级为普通 FAIL，更不为 PASS）。
import { spawnSync } from "node:child_process"

const STEPS = ["goal-accept-r1r2.mjs", "goal-accept-r3r4.mjs", "goal-accept-r567.mjs"]
// RV-158：信号名 → ENV-FAULT。spawnSync signal 非 null 即进程级死亡（RV-155 不覆盖脚本内映射）。
function classify(res, step) {
  if (res.error) return { cls: "ENV-FAULT", code: 2, why: `${step}: spawn error ${res.error.message}` }
  if (res.signal) return { cls: "ENV-FAULT", code: 2, why: `${step}: terminated by signal ${res.signal}` }
  const code = res.status ?? 2
  if (code === 0) {
    const out = (res.stdout ?? "") + (res.stderr ?? "")
    const m = out.match(/CHECKS run=(\d+) skipped=(\d+) expected=(\d+)(?: states=([^\s]*))?/)
    if (!m) return { cls: "ENV-FAULT", code: 2, why: `${step}: exit 0 but CHECKS line missing/unparseable (default-deny)` }
    if (m[2] !== "0") return { cls: "ENV-FAULT", code: 2, why: `${step}: CHECKS skipped=${m[2]} without named exemption` }
    if (m[1] !== m[3]) return { cls: "ENV-FAULT", code: 2, why: `${step}: CHECKS run=${m[1]} != expected=${m[3]}` }
    // RV-151/RV-157 三值账本：states 机读终态 — 任一 fail 即 FAIL（一等结局），任一 env 即 ENV-FAULT。
    if (!m[4]) return { cls: "ENV-FAULT", code: 2, why: `${step}: CHECKS states missing (ledger required)` }
    const st = Object.fromEntries(m[4].split(",").map((kv) => kv.split(":")))
    const fails = Object.entries(st).filter(([, s]) => s === "fail")
    const envs = Object.entries(st).filter(([, s]) => s === "env")
    if (envs.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: states has env: ${envs.map(([id]) => id).join(",")}` }
    if (fails.length > 0) return { cls: "FAIL", code: 1, why: `${step}: states has fail: ${fails.map(([id]) => id).join(",")}` }
    return { cls: "PASS", code: 0, why: `${step}: exit 0 + CHECKS ${m[1]}/${m[3]} + states all pass` }
  }
  if (code === 1) return { cls: "FAIL", code: 1, why: `${step}: exit 1 (assertion failure)` }
  if (code === 2) return { cls: "ENV-FAULT", code: 2, why: `${step}: exit 2 (env fault)` }
  // RV-158：124/126/127/130/137/143 及其他未列出非零一律 ENV-FAULT 兜底。
  return { cls: "ENV-FAULT", code: 2, why: `${step}: exit ${code} (unlisted non-zero → ENV-FAULT fail-safe)` }
}

let headline = null
for (const step of STEPS) {
  const res = spawnSync("node", [`QMAI/scripts/${step}`], { encoding: "utf8", shell: false })
  process.stdout.write(res.stdout ?? "")
  process.stderr.write(res.stderr ?? "")
  const c = classify(res, step)
  console.log(`STEP ${c.cls}: ${c.why}`)
  if (c.cls === "ENV-FAULT") {
    // RV-143：ENV-FAULT 支配 FAIL — headline 即 ENV-FAULT，中止后续路径。
    console.error(`ALL-ENV-FAULT: ${c.why} (prior PASS lines are non-acceptance)`)
    process.exit(2)
  }
  if (c.cls === "FAIL") {
    console.error(`ALL-FAIL: ${c.why}`)
    process.exit(1)
  }
}
console.log("ALL goal-accept STEPS PASS (3/3, CHECKS-verified, default-deny)")
