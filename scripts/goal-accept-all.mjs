// goal-accept-all.mjs — 验收总入口（RV-155 默认拒绝消费者契约 + RV-158 全量退出码分类）。
// Run from workspace root: node QMAI/scripts/goal-accept-all.mjs
// 语义：顺序运行 r1r2 → r3r4 → r567（RV-144 按路径作用域：任一脚本 ENV-FAULT 即 headline 中止，
//   其先行 PASS 已在各脚本内标注为非验收）；任一脚本 FAIL 即中止（headline FAIL）。
// default-deny：子脚本 exit≠0 ∨ 输出缺 CHECKS 行 ∨ CHECKS 不可解析 ⇒ ENV-FAULT（exit 2），
//   永不因“账本缺失”读出 PASS（RV-155 静默放行窗口关闭）。
// RV-158 全量映射：0=pass；1=断言失败；2=环境故障；124/126/127/130/137/143/信号终止 ⇒ ENV-FAULT(2)；
//   3 及其他未列出非零 ⇒ ENV-FAULT 兜底（fail-safe：未知 ⇒ 环境问题，绝不降级为普通 FAIL，更不为 PASS）。
// RV-23-03 taxonomy（成文）：FAIL(1) 仅保留给子脚本断言失败；一切调用/配置/账本 degenerate
//   （want 为空、STEPS/EXPECTED_IDS 失配、states 缺键/空/未知态）⇒ ENV-FAULT(2)，fail-closed，永不进 FAIL。
// RV-24-05 taxonomy 第四类 state/hygiene（成文）：运行环境卫生违例（运行后树脏、探针残留）
//   ⇒ ENV-FAULT(2)，不是断言失败。`exit 1 ⇔ 子脚本断言失败` 为机检不变量（negprobe F7/F8 为凭）。
// RV-23-06 调用契约：want 非空；新增脚本必须同步 EXPECTED_IDS，否则按失配 fail-closed（F5 为凭）。
// RV-23-09 残余登记：残留 execSync 均为固定字面量（插值注入已闭合）；真实残余 = 经 PATH 解析 git 二进制
//   （与 node 本体同信任域，接受）；cwd 相对路径漂移只会使命令非零 ⇒ ENV-FAULT（fail-closed，无静默风险）。
import { spawnSync, execSync } from "node:child_process"

const STEPS = ["goal-accept-r1r2.mjs", "goal-accept-r3r4.mjs", "goal-accept-r567.mjs"]
// RV-201：裁决量化在期望 id 集上（非 states 键集）— 缺键即拒，杜绝存在性谓词真空通过。
// RV-159：各步骤期望 id 集与子脚本 EXPECTED_CHECK_IDS 同源，增删检查时同步更新。
const EXPECTED_IDS = {
  "goal-accept-r1r2.mjs": ["r1-8gap", "r1-ancestry", "r1-newchain", "r1-cleantree", "r1-evdocs", "r2-reports"],
  "goal-accept-r3r4.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"],
  "goal-accept-r567.mjs": ["r5-artifact", "r5-buildlog", "r5-typecheck", "r6-mocks", "r7-comp"],
}
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
    // RV-22-01：退化空集前置 — 两侧集合均为空时判 FAIL（非 PASS）。解析失败永不回退为 {}（无 try 包裹）。
    // RV-201/RV-21-07：严格双向集合比较 — missing 与 unexpected 同时列出。
    const want = EXPECTED_IDS[step] ?? []
    if (want.length === 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: EXPECTED_IDS empty (degenerate; refuse)` }
    const gotKeys = Object.keys(st)
    if (gotKeys.length === 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: states empty (degenerate A=B=∅; refuse)` }
    const missing = want.filter((id) => !(id in st))
    const unexpected = Object.keys(st).filter((id) => !want.includes(id))
    if (missing.length > 0 || unexpected.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: states key mismatch — missing [${missing.join(",")}] unexpected [${unexpected.join(",")}]` }
    // RV-207 第三值合取规则（成文）：unexecuted（期望外键/未知态）⇒ 拒绝；显式豁免须登记理由（当前无豁免）。
    const unknown = Object.entries(st).filter(([, s]) => s !== "pass" && s !== "fail" && s !== "env")
    if (unknown.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: states has unknown state: ${unknown.map(([id, s]) => `${id}=${s}`).join(",")}` }
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
// RV-21-10 运行后状态断言：验收脚本自身不写文件 — 运行后工作树必须仍干净（可重入性）。
// RV-24-05：卫生违例 ⇒ ENV-FAULT(2)（见文件头 taxonomy 第四类），不是 FAIL。
// 注意：此处用 exec 风格 sync 调用 git（固定字面量，无插值，RV-21-06 已审计）。
try {
  const after = execSync("git -C QMAI status --short", { encoding: "utf8" }).trim()
  if (after !== "") {
    console.error(`ALL-ENV-FAULT: post-run tree not clean (hygiene):\n${after}`)
    process.exit(2)
  }
  console.log("POST-RUN tree clean (re-entrant, RV-21-10)")
} catch (e) {
  console.error("ALL-ENV-FAULT: post-run cleanliness check failed: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
