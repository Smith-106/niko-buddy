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
// RV-25-05 契约表（独立声明，非实现快照）：类别 → 期望出口。taxonomy 改动必须同步改此表。
//   assertion-fail → exit 1 ALL-FAIL            [行证据: F1/F2/F8/F8b/F8c/F9a/F9b/F11/F12]
//   ledger-degenerate → exit 2 ENV-FAULT       [行证据: F3/F5]
//   spawn/signal/unknown-exit → exit 2 ENV-FAULT [行证据: F4]
//   hygiene → exit 2 ENV-FAULT                 [行证据: F7]
//   crash → exit 2 ENV-FAULT (uncaught + unhandledRejection) [行证据: F10/F14/F14b]
//   env-bind → exit 2 ENV-FAULT on mismatch   [行证据: BASELINE-head/SELF-bound]
//   guard-refusal → unit refuse (in-process)   [行证据: F15-saferefuse]
// negprobe 每个 fixture 即此表的行级证据；删任一行契约必须同步删/改对应 fixture（双向）。
// RV-23-06 调用契约：want 非空；新增脚本必须同步 EXPECTED_IDS，否则按失配 fail-closed（F5 为凭）。
// RV-23-09 残余登记：残留 execSync 均为固定字面量（插值注入已闭合）；真实残余 = 经 PATH 解析 git 二进制
//   （与 node 本体同信任域，接受）；cwd 相对路径漂移只会使命令非零 ⇒ ENV-FAULT（fail-closed，无静默风险）。
import { spawnSync, execSync } from "node:child_process"
// RV-27-07：运行时同一性 — spawn 用 PATH 解析 node + 相对路径，错误 cwd/解释器下执行集漂移。
// fail-fast：cwd 非 hub root 即 ENV-FAULT 中止；回显解释器绝对路径 + 版本 + 平台（INIT-toolchain 配对）。
if (!process.cwd().replace(/\\/g, "/").endsWith("niko-hub")) {
  console.error(`ALL-ENV-FAULT: unexpected cwd ${process.cwd()} (expected hub root; step set would drift)`)
  process.exit(2)
}
console.log(`INIT node=${process.execPath} ${process.version} platform=${process.platform} cwd=${process.cwd()}`)

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
  if (res.error) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=spawn] spawn error ${res.error.message}` }
  if (res.signal) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=signal] terminated by signal ${res.signal}` }
  const code = res.status ?? 2
  if (code === 0) {
    const out = (res.stdout ?? "") + (res.stderr ?? "")
    const m = out.match(/CHECKS run=(\d+) skipped=(\d+) expected=(\d+)(?: states=([^\s]*))?/)
    if (!m) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=checkline] exit 0 but CHECKS line missing/unparseable (default-deny)` }
    if (m[2] !== "0") return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=checkline] CHECKS skipped=${m[2]} without named exemption` }
    if (m[1] !== m[3]) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=checkline] CHECKS run=${m[1]} != expected=${m[3]}` }
    // RV-151/RV-157 三值账本：states 机读终态 — 任一 fail 即 FAIL（一等结局），任一 env 即 ENV-FAULT。
    if (!m[4]) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] CHECKS states missing (ledger required)` }
    const st = Object.fromEntries(m[4].split(",").map((kv) => kv.split(":")))
    // RV-40A-03：拒绝重复键（后写覆盖掩蔽fail）与多余冒号分段（宽松接受畸形账本）— 账本须为严格 id:state 对。
    const segs = m[4].split(",")
    if (new Set(segs.map((kv) => kv.split(":")[0])).size !== segs.length) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states has duplicate keys (last-wins refused)` }
    if (segs.some((kv) => kv.split(":").length !== 2)) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states has malformed segment (expected id:state)` }
    // RV-22-01：退化空集前置 — 两侧集合均为空时判 FAIL（非 PASS）。解析失败永不回退为 {}（无 try 包裹）。
    // RV-201/RV-21-07：严格双向集合比较 — missing 与 unexpected 同时列出。
    const want = EXPECTED_IDS[step] ?? []
    if (want.length === 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] EXPECTED_IDS empty (degenerate; refuse)` }
    const gotKeys = Object.keys(st)
    if (gotKeys.length === 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states empty (degenerate A=B=∅; refuse)` }
    const missing = want.filter((id) => !(id in st))
    const unexpected = Object.keys(st).filter((id) => !want.includes(id))
    if (missing.length > 0 || unexpected.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states key mismatch — missing [${missing.join(",")}] unexpected [${unexpected.join(",")}]` }
    // RV-207 第三值合取规则（成文）：unexecuted（期望外键/未知态）⇒ 拒绝；显式豁免须登记理由（当前无豁免）。
    const unknown = Object.entries(st).filter(([, s]) => s !== "pass" && s !== "fail" && s !== "env")
    if (unknown.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states has unknown state: ${unknown.map(([id, s]) => `${id}=${s}`).join(",")}` }
    const fails = Object.entries(st).filter(([, s]) => s === "fail")
    const envs = Object.entries(st).filter(([, s]) => s === "env")
    if (envs.length > 0) return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=ledger] states has env: ${envs.map(([id]) => id).join(",")}` }
    if (fails.length > 0) return { cls: "FAIL", code: 1, why: `${step}: states has fail: ${fails.map(([id]) => id).join(",")}` }
    return { cls: "PASS", code: 0, why: `${step}: exit 0 + CHECKS ${m[1]}/${m[3]} + states all pass` }
  }
  if (code === 1) return { cls: "FAIL", code: 1, why: `${step}: exit 1 (assertion failure)` }
  if (code === 2) return { cls: "ENV-FAULT", code: 2, why: `${step}: exit 2 (env fault)` }
  // RV-158：124/126/127/130/137/143 及其他未列出非零一律 ENV-FAULT 兜底。
  // RV-25-04：[det=exitmap] 兜底类标签 — 与断言失败(exit 1)正交可区分。
  return { cls: "ENV-FAULT", code: 2, why: `${step}: [det=exitmap] exit ${code} (unlisted non-zero → ENV-FAULT fail-safe)` }
}

for (const step of STEPS) {
  const res = spawnSync(process.execPath, [`QMAI/scripts/${step}`], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL" }) // RV-27-02(process.execPath 钉解释器)/RV-27-06(maxBuffer 防 ENOBUFS 截断哨兵)/RV-38-11(timeout 60s：超时 kill→signal→ENV-FAULT，永不挂起门禁)
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
// RV-40A-04：卫生检查先于 PASS 横幅 — grep消费者先见横幅后见exit 2会被误导；顺序改为卫生→横幅。
// RV-21-10 运行后状态断言：验收脚本自身不写文件 — 运行后工作树必须仍干净（可重入性）。
// OBS-33-E2 前提显式化：after 恒 .trim() 后判空（!== ""，locale/CRLF/尾空安全）；若改为全等内容比较须同步处理 \r（RV-30-08）。
// RV-24-05：卫生违例 ⇒ ENV-FAULT(2)（见文件头 taxonomy 第四类），不是 FAIL。
// 注意：此处用 exec 风格 sync 调用 git（固定字面量，无插值，RV-21-06 已审计）。
try {
  const after = execSync("git -C QMAI status --short", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL", env: { ...process.env, GIT_PAGER: "cat" } }).trim() // RV-31-08 显式禁 pager + RV-29-06 显式 maxBuffer（大脏树超限走 catch→ENV-FAULT fail-closed，非 PASS）+ RV-38-11 timeout
  if (after !== "") {
    console.error(`ALL-ENV-FAULT: post-run tree not clean (hygiene):\n${after}`)
    process.exit(2)
  }
  console.log("POST-RUN tree clean (re-entrant, RV-21-10)")
} catch (e) {
  console.error("ALL-ENV-FAULT: post-run cleanliness check failed: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
// RV-41A-10（部分采纳）：终局横幅计数由 STEPS.length 派生（硬编码 (3/3) 在 STEPS 扩容即变谎报）。
// STEP 行保持 "STEP PASS" 文案（negprobe F9a L407 依赖该字面作聚合面断言，改名即破 fixture）；
// 权威裁决 = 最终横幅 + 进程退出码（步骤行仅为过程回显，见 RV-25-05 契约表）。
console.log(`ALL goal-accept STEPS PASS (${STEPS.length}/${STEPS.length}, CHECKS-verified, default-deny, post-run clean)`)
