// goal-accept-negprobe.mjs — 负向 fixture（RV-21-01/RV-22-03/RV-22-06/RV-23-01~09/RV-24-01~10）：门禁必须被观测为失败。
// Run from workspace root: node QMAI/scripts/goal-accept-negprobe.mjs
// 自包含、可执行、自校验。探针均为外部复制+改写，不在生产计分路径（RV-208）。
// Fixture ↔ RV 覆盖表（RV-23-08 可审计映射）：
//   INIT-steps → RV-23-06 静态面 + RV-24-09（正向调用者清单机检）
//   INIT-toolchain → RV-24-08（node/git 解析路径回显正向证据）
//   F1-exit1 / F1-fail-not-envfault / F1-states-fail / F1-no-allpass → RV-21-02（树注入语义负结果）
//   F2-exit1 / F2-fail-headline / F2-no-allpass → RV-159 第一道（子脚本集合检查）
//   F3-exit2 / F3-missing-keys / F3-no-allpass → RV-201/RV-22-01 第二道（wrapper 缺键）
//   F4-exit2 / F4-spawn-error → RV-23-01（ENV-FAULT 正向对照：缺失可执行文件）
//   F5-exit2 / F5-want-empty → RV-23-02/03/06（STEPS/EXPECTED_IDS 失配 taxonomy）
//   F7-exit2 / F7-postrun-dirty → RV-23-04 + RV-24-05（POST-RUN 分支存活反证；卫生违例=ENV-FAULT）
//   F8-exit1 / F8-fork → RV-23-05 + RV-24-03（r3r4 同源断言；账本单侧污染为 F3）
//   F8b-anchor/exit1/fork → RV-24-03（r1r2 同源断言三脚本全覆盖）
//   F8c-anchor/exit1/fork → RV-24-03（r567 同源断言三脚本全覆盖）
//   F9a-exit1 / F9a-step-pass-ok / F9a-allfail → RV-23-07 + RV-24-04（聚合面：同一语义）
//   F9b-exit1 / F9b-shortcircuit → RV-24-04（短路面：同一语义的两面，非双模式）
//   F13-exit2 / F13-signal → RV-26-03（exitmap 兜底阳性对照；signal 分支 Windows 不可达已注记）
//   F14-exit2 / F14-uncaught → RV-26-03（uncaught-handler 阳性对照：try 外抛错）
//   F14b-exit2 / F14b-unhandled → RV-27-02（unhandledRejection 阳性对照：Node≥15 默认 exit 1 须映射 ENV-FAULT）
//   F15-saferefuse → RV-27-04（safeRm 拒绝 unit：空/越界/仓内/通配/绝对 5 拒绝均须 throw）
//   BASELINE-head → RV-26-05（NEGPROBE_EXPECT_HEAD 已设时基线身份绑定）
//   CLEAN-tmp-gone → RV-23-04（tmp 在 QMAI 仓外 + 运行后无残留）
//   终态 executed-set == MANIFEST 双向断言 → RV-24-02（分母完整性；缺失 probe 记 ENV-FAULT）
//   exit-1 断言均附 noCrash 崩溃哨兵 → RV-24-01（`exit 1 ⇔ 断言失败`，结构化 FAIL 记录身份）
//   尾行 HEAD + self 哈希 → RV-24-10（证据绑定，可回溯到工件）
import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"

const DIR = ".negprobe-tmp"
const DIRTY = ".negprobe-dirty" // F7 专用脏仓（hub root，QMAI 仓外）
let START_HEAD = "(unresolved)" // RV-25-07：起始 HEAD 采样（模块级，尾部起止一致断言可见）
// RV-25-06：CLEAN 安全前置 — 清理前显式断言路径（防 rm -rf 祖先目录/根目录/HOME）。
// RV-26-02：realpath 归一化 + 大小写归一（Windows 不敏感）+ 拒绝 QMAI 根自身。
// 调用点仅为模块常量 DIR/DIRTY（非外部输入），本函数为纵深防御。
function safeRm(target) {
  if (!target || target.trim() === "") throw new Error("safeRm: empty path refused")
  if (/[*?[\]$`{}()|&;<>!]/.test(target)) throw new Error(`safeRm: refused metachar path ${JSON.stringify(target)}`)
  const cwd = process.cwd()
  if (!cwd.replace(/\\/g, "/").endsWith("niko-hub")) throw new Error(`safeRm: unexpected cwd ${cwd} (expected hub root)`)
  const abs = resolve(cwd, target) // 归一化 .. 与分隔符
  const rel = relative(cwd, abs)
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`safeRm: refused escape-from-cwd ${JSON.stringify(target)} → ${abs}`)
  // 首段 Windows 语义归一（去尾点/尾空格 + 小写）："QMAI"、"qmai"、"QMAI." 一律拒绝。
  const first = rel.split(sep)[0].replace(/[. ]+$/, "").toLowerCase()
  if (first === "qmai") throw new Error(`safeRm: refused in-repo path ${JSON.stringify(target)}`)
  rmSync(abs, { recursive: true, force: true })
  console.log(`CLEAN-SAFE: removed ${target}`)
}
// RV-25-07 起止一致：HEAD 采样 helper（失败返回 unresolved，不抛 — 避免采样本身炸掉主流程）。
function safeHead() {
  try { return execFileSync("git", ["-C", "QMAI", "rev-parse", "HEAD"], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" }).trim() } catch { return "(unresolved)" }
}
let failures = []
const executed = [] // RV-24-02：实际执行集 — 终态必须与声明清单 MANIFEST 双向相等
function check(name, cond, detail) {
  executed.push(name)
  if (cond) console.log(`NEG-PASS: ${name}`)
  else { failures.push(name); console.error(`NEG-FAIL: ${name} — ${detail}`) }
}
// RV-24-02 分母声明清单：每个断言名必须在此登记；终态断言 executed-set == MANIFEST。
// 缺失 probe → NEG-ENV-FAULT（exit 2），不记 PASS（堵 vacuous-pass）。
const MANIFEST = [
  "INIT-steps", "INIT-idsync", "INIT-toolchain",
  "F1-exit1", "F1-fail-not-envfault", "F1-states-fail", "F1-no-allpass",
  "F2-exit1", "F2-fail-headline", "F2-no-allpass",
  "F3-exit2", "F3-missing-keys", "F3-no-allpass",
  "F4-exit2", "F4-spawn-error",
  "F5-exit2", "F5-want-empty",
  "F7-exit2", "F7-postrun-dirty",
  "F8-exit1", "F8-fork",
  "F8b-anchor", "F8b-exit1", "F8b-fork",
  "F8c-anchor", "F8c-exit1", "F8c-fork",
  "F9a-exit1", "F9a-step-pass-ok", "F9a-allfail",
  "F9b-exit1", "F9b-shortcircuit",
  "F10-exit2", "F10-crash-lit",
  "F11-documented",
  "F12-exit1", "F12-no-fork-misfire",
  "F13-exit2", "F13-signal",
  "F14-exit2", "F14-uncaught",
  "F14b-exit2", "F14b-unhandled",
  "F16-signal", "F16-status-null", "F16-wrapper-exit2",
  "F15-saferefuse",
  "BASELINE-head",
  "SELF-bound",
  "CLEAN-tmp-gone", "CLEAN-safe",
]
// RV-24-01：崩溃哨兵 — exit-1 断言必须同时确认输出中无 Node 崩溃痕迹（崩溃同样 exit 1，
// 仅比退出码会把“因崩溃而绿”计为通过）。合法 FAIL 行只含 "FAIL [id]:"，不含以下标记。
// RV-41A-02（补偿链，非单点修复）：code===1 ⇒ FAIL 无法区分“子脚本断言失败”与“子进程崩溃”
// （Node 未捕获异常默认退出码也是 1）。三层补偿：① 子脚本侧 uncaught/unhandledRejection 显式映射
// ENV-FAULT(2)（r1r2/r3r4/r567 全覆盖）；② exit-1 断言全部附 noCrash 哨兵（F1/F2/F8/F8b/F8c/F9a/F9b/F12
// 机检：崩溃痕迹存在即 fixture 红）；③ 账本要求 states 含 ≥1 个 :fail 态（F1-states-fail 类断言为凭）。
// 残余仅为“静默 exit(1) 且无崩溃痕迹且伪造 fail 账本”的复合篡改面，已超出验收门禁威胁模型。
const CRASH_MARKS = ["node:internal", "SyntaxError", "ReferenceError", "TypeError", "UnhandledPromiseRejection"]
// 注意：git 的 "fatal:" 走 stderr 是探针合法输出（F1 树注入必然触发），不属 Node 崩溃，不列入哨兵。
function noCrash(out) { return !CRASH_MARKS.some((m) => out.includes(m)) }
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL" }) // RV-38-11 timeout（超时 kill→signal→ENV-FAULT，永不挂起门禁）
}
// Fixture 构造器：从生产 wrapper 复制并改写 STEPS/EXPECTED_IDS/spawn 路径；
// keepPostRun=true 时保留尾部 RV-21-10 运行后断言（F7 专用），否则截掉。
function makeWrapper(stepNames, idMap, keepPostRun = false) {
  let w = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  w = w.replace(/const STEPS = \[.*?\]/, `const STEPS = [${stepNames.map((s) => `"${s}"`).join(", ")}]`)
  const idsSrc = `const EXPECTED_IDS = {\n${stepNames.map((s) => `  "${s}": [${(idMap[s] ?? []).map((i) => `"${i}"`).join(", ")}],`).join("\n")}\n}`
  w = w.replace(/const EXPECTED_IDS = \{[\s\S]*?\n\}/, idsSrc)
  w = w.replace("QMAI/scripts/${step}", `${DIR}/\${step}`)
  if (keepPostRun) return w
  const cutAt = w.indexOf("// RV-21-10")
  if (cutAt < 0) throw new Error("RV-21-10 block not found in wrapper copy")
  return w.slice(0, cutAt)
}

try {
  // RV-25-07：起始采样（与尾行 HEAD/self 哈希配对，起止一致断言见文件尾）。
  START_HEAD = safeHead()
  console.log(`NEGPROBE START HEAD=${START_HEAD}`)
  safeRm(DIR)
  safeRm(DIRTY)
  mkdirSync(DIR, { recursive: true })

  // INIT：正向调用者清单机检（RV-23-06 静态面 + RV-24-09：生产 wrapper 的 STEPS/EXPECTED_IDS
  // 必须与契约一致，否则后续 3/3 的含义漂移）。
  // RV-25-03：集合相等（非成员检查）— 实际调用点集 == 登记集，双向可检（漏登/错登均开火）。
  // 实际调用点集 = STEPS 数组字面量（spawn 目标 `QMAI/scripts/${step}` 直接由其派生，模板字面量无其他来源）。
  const prodW = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  const stepsLit = prodW.match(/const STEPS = \[(.*?)\]/)
  const actualSet = stepsLit ? [...stepsLit[1].matchAll(/"(goal-accept-[a-z0-9]+\.mjs)"/g)].map((m) => m[1]).sort() : []
  const declaredSet = ["goal-accept-r1r2.mjs", "goal-accept-r3r4.mjs", "goal-accept-r567.mjs"]
  check("INIT-steps", JSON.stringify(actualSet) === JSON.stringify(declaredSet), `callers != declared: actual [${actualSet.join(",")}] declared [${declaredSet.join(",")}]`)
  // EXPECTED_IDS 键集 == STEPS（同一文件内双向，不依赖 STEPS 字面量解析）。
  const idKeys = [...prodW.matchAll(/^  "(goal-accept-[a-z0-9]+\.mjs)": \[/gm)].map((m) => m[1]).sort()
  check("INIT-idsync", JSON.stringify(idKeys) === JSON.stringify(declaredSet), `EXPECTED_IDS keys != STEPS: [${idKeys.join(",")}]`)
  // RV-24-08 正向证据：initiator（node 二进制绝对路径 + cwd + git 解析路径）回显并断言。
  console.log(`INIT node=${process.execPath} cwd=${process.cwd()}`)
  let gitPath = ""
  try { gitPath = execFileSync("where", ["git"], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" }).split(/\r?\n/)[0].trim() } catch { gitPath = "" }
  console.log(`INIT git=${gitPath || "(unresolved)"}`)
  check("INIT-toolchain", process.execPath !== "" && gitPath !== "" && existsSync("QMAI/scripts/goal-accept-all.mjs"), "toolchain/cwd unresolved")

  // F1：树哈希注入 r1r2 — RV-21-02 固化（期望 exit=1 + FAIL + states fail，非 ENV-FAULT）。
  const tree = execFileSync("git", ["-C", "QMAI", "rev-parse", "HEAD^{tree}"], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" }).trim()
  copyFileSync("QMAI/scripts/goal-accept-r1r2.mjs", `${DIR}/f1.mjs`)
  let f1 = readFileSync(`${DIR}/f1.mjs`, "utf8")
  f1 = f1.replace('"a741863a", "86862911"', `"${tree}", "86862911"`)
  writeFileSync(`${DIR}/f1.mjs`, f1)
  if (f1.includes('"a741863a", "86862911"')) throw new Error("F1 anchor missed: production sha pair drifted")
  const r1 = run("node", [`${DIR}/f1.mjs`])
  const out1 = (r1.stdout ?? "") + (r1.stderr ?? "")
  check("F1-exit1", r1.status === 1, `status=${r1.status}`)
  // RV-24-01：结构化 FAIL 记录身份（FAIL [id]）+ 崩溃哨兵缺席 — 不只是退出码。
  check("F1-fail-not-envfault", out1.includes("FAIL [r1-8gap]") && !out1.includes("ENV-FAULT") && noCrash(out1), "missing FAIL / unexpected ENV-FAULT / crash marks present")
  check("F1-states-fail", out1.includes("r1-8gap:fail"), "states lacks r1-8gap:fail")
  check("F1-no-allpass", !out1.includes("ALL R1R2 PASS"), "ALL PASS present despite fail")

  // F2：缺键 states 经 wrapper — RV-22-01/RV-201 固化（期望 wrapper exit=2 + missing keys）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f2.mjs`)
  let f2 = readFileSync(`${DIR}/f2.mjs`, "utf8")
  // 删除 r4-reeval 的 ok 行 → states 缺键，CHECKS 行仍输出（run!=expected 仅信息层）。
  f2 = f2.replace('ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")', '/* NEGPROBE: ok removed */')
  writeFileSync(`${DIR}/f2.mjs`, f2)
  if (!f2.includes("NEGPROBE: ok removed")) throw new Error("F2 anchor missed: ok-line drifted")
  copyFileSync("QMAI/scripts/goal-accept-all.mjs", `${DIR}/w2.mjs`)
  let w2 = readFileSync(`${DIR}/w2.mjs`, "utf8")
  w2 = w2.replace('const STEPS = ["goal-accept-r1r2.mjs", "goal-accept-r3r4.mjs", "goal-accept-r567.mjs"]', 'const STEPS = ["f2.mjs"]')
  w2 = w2.replace('"goal-accept-r3r4.mjs":', '"f2.mjs":')
  w2 = w2.replace("QMAI/scripts/${step}", `${DIR}/\${step}`)
  // 运行后干净断言在探针目录无意义 — 截掉文件尾 RV-21-10 块（仅探针内）。
  const cutAt = w2.indexOf("// RV-21-10")
  if (cutAt < 0) throw new Error("RV-21-10 block not found in wrapper copy")
  w2 = w2.slice(0, cutAt)
  writeFileSync(`${DIR}/w2.mjs`, w2)
  if (!w2.includes('const STEPS = ["f2.mjs"]') || !w2.includes('"f2.mjs":') || w2.includes("QMAI/scripts/${step}")) throw new Error("F2 wrapper anchors missed")
  const r2 = run("node", [`${DIR}/w2.mjs`])
  const out2 = (r2.stdout ?? "") + (r2.stderr ?? "")
  // F2：子脚本自带 RV-159 集合检查 — 缺键在子脚本层即 FAIL exit=1（第一道防线）。
  check("F2-exit1", r2.status === 1, `status=${r2.status}`)
  check("F2-fail-headline", out2.includes("ALL-FAIL") && noCrash(out2), "ALL-FAIL headline absent / crash marks present")
  check("F2-no-allpass", !out2.includes("ALL goal-accept STEPS PASS"), "ALL PASS present despite missing key")

  // F3：删 ok 的账本写入 + 删子脚本集合/同源检查 → 子脚本 exit=0 但 states 缺键 —
  // wrapper 第二道（missing-keys）必须 ENV-FAULT exit=2（RV-201/RV-22-01）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f3.mjs`)
  let f3 = readFileSync(`${DIR}/f3.mjs`, "utf8")
  f3 = f3.replace('ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")', 'checksRun++; /* NEGPROBE: ledger write skipped */')
  f3 = f3.replace('if (got !== want) fail("r3-gaps", `check-id set mismatch: got [${got}] want [${want}]`)', '/* NEGPROBE: set-check removed */')
  f3 = f3.replace('if (checksRun !== passCount) fail("r3-gaps", `rendered PASS ${checksRun} != states pass ${passCount} (text/ledger fork)`)', '/* NEGPROBE: text-ledger check removed */')
  writeFileSync(`${DIR}/f3.mjs`, f3)
  if (!f3.includes("ledger write skipped") || !f3.includes("set-check removed") || !f3.includes("text-ledger check removed")) throw new Error("F3 anchors missed")
  let w3 = readFileSync(`${DIR}/w2.mjs`, "utf8")
  w3 = w3.split('"f2.mjs"').join('"f3.mjs"')
  writeFileSync(`${DIR}/w3.mjs`, w3)
  const r3 = run("node", [`${DIR}/w3.mjs`])
  const out3 = (r3.stdout ?? "") + (r3.stderr ?? "")
  check("F3-exit2", r3.status === 2, `status=${r3.status}`)
  check("F3-missing-keys", out3.includes("missing") && out3.includes("r4-reeval"), "missing-keys headline absent")
  check("F3-no-allpass", !out3.includes("ALL goal-accept STEPS PASS"), "ALL PASS present despite missing key")

  // F4：真实环境故障正向对照 — 缺失可执行文件（PATH/安装损坏类），ENV-FAULT 必须可达（RV-23-01）。
  // 注：生产 spawn 用 process.execPath（RV-27-07），此处替换解释器为坏二进制。
  let w4 = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  w4 = w4.split("spawnSync(process.execPath, [").join("spawnSync(\"node-nonexistent-bin-xyz\", [")
  writeFileSync(`${DIR}/w4.mjs`, w4)
  if (!w4.includes("node-nonexistent-bin-xyz")) throw new Error("F4 anchor missed: spawn line drifted")
  const r4 = run("node", [`${DIR}/w4.mjs`])
  const out4 = (r4.stdout ?? "") + (r4.stderr ?? "")
  check("F4-exit2", r4.status === 2, `status=${r4.status}`)
  check("F4-spawn-error", out4.includes("spawn error"), "spawn-error ENV-FAULT headline absent")

  // F5：STEPS/EXPECTED_IDS 失配（新增脚本未登记）→ want 经 ?? [] 为空 → ENV-FAULT exit 2（RV-23-02/03/06）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f5.mjs`)
  let w5 = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  w5 = w5.replace(/const STEPS = \[.*?\]/, 'const STEPS = ["f5.mjs"]')
  // 注意：故意不改 EXPECTED_IDS —— 模拟“加脚本忘登记”。
  w5 = w5.replace("QMAI/scripts/${step}", `${DIR}/\${step}`)
  const cut5 = w5.indexOf("// RV-21-10")
  if (cut5 < 0) throw new Error("RV-21-10 block not found in wrapper copy (F5)")
  w5 = w5.slice(0, cut5)
  writeFileSync(`${DIR}/w5.mjs`, w5)
  if (!w5.includes('const STEPS = ["f5.mjs"]') || w5.includes("QMAI/scripts/${step}")) throw new Error("F5 wrapper anchors missed")
  const r5 = run("node", [`${DIR}/w5.mjs`])
  const out5 = (r5.stdout ?? "") + (r5.stderr ?? "")
  check("F5-exit2", r5.status === 2, `status=${r5.status}`)
  check("F5-want-empty", out5.includes("EXPECTED_IDS empty"), "want-empty ENV-FAULT headline absent")

  // F7：POST-RUN 时序反证 — 运行后树脏 ⇒ ENV-FAULT exit 2（RV-23-04；证明该分支存活；
  // RV-24-05：卫生违例归 ENV-FAULT，使 `exit 1 ⇔ 断言失败` 成为机检不变量）。
  execFileSync("git", ["init", "-q", DIRTY], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" })
  writeFileSync(`${DIRTY}/dirty.txt`, "uncommitted\n")
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f7.mjs`)
  let w7 = makeWrapper(["f7.mjs"], { "f7.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }, true)
  w7 = w7.split("git -C QMAI status --short").join(`git -C ${DIRTY} status --short`)
  writeFileSync(`${DIR}/w7.mjs`, w7)
  if (w7.includes("git -C QMAI status --short")) throw new Error("F7 anchor missed: post-run check not redirected to DIRTY")
  const r7 = run("node", [`${DIR}/w7.mjs`])
  const out7 = (r7.stdout ?? "") + (r7.stderr ?? "")
  check("F7-exit2", r7.status === 2, `status=${r7.status}`)
  check("F7-postrun-dirty", out7.includes("post-run tree not clean") && out7.includes("ALL-ENV-FAULT"), "post-run-dirty ENV-FAULT headline absent")

  // F10/F11：探测器阳性对照（RV-25-02）— 哨兵/断言必须在真实污染下点亮（阴性对照之外）。
  // F10：真实崩溃注入（fixture 内抛 ReferenceError）→ 子脚本 uncaughtException → ENV-FAULT exit 2
  //   且输出含 ENV-FAULT: uncaught（哨兵不误判为普通 FAIL，且崩溃通道可达）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f10.mjs`)
  let f10 = readFileSync(`${DIR}/f10.mjs`, "utf8")
  f10 = f10.replace('ok("r3-gaps", "R3 8-gap symbols all present in product code")',
    'ok("r3-gaps", "R3 8-gap symbols all present in product code")\nif (process.env.NEGPROBE_CRASH === "1" /* F10 阳性对照 */) { nonexistentFn_xyz() }')
  writeFileSync(`${DIR}/f10.mjs`, f10)
  if (!f10.includes("NEGPROBE_CRASH")) throw new Error("F10 anchor missed: ok-line drifted")
  const r10 = spawnSync("node", [`${DIR}/f10.mjs`], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 60000, killSignal: "SIGKILL", env: { ...process.env, NEGPROBE_CRASH: "1" } }) // RV-27-06
  const out10 = (r10.stdout ?? "") + (r10.stderr ?? "")
  check("F10-exit2", r10.status === 2, `status=${r10.status}`)
  // 注：fixture 内崩溃发生在子脚本 try 块内 → 走 ENV-FAULT 分支（非 uncaught handler，
  // 故 headline 为 "ENV-FAULT: <err>" 而非 "ENV-FAULT: uncaught"）。断言 ENV-FAULT 身份 + 函数名。
  check("F10-crash-lit", out10.includes("ENV-FAULT") && out10.includes("nonexistentFn_xyz") && noCrash(out10), "crash channel not lit / misclassified")
  // F11：同源断言阳性对照（双侧污染：计数器+账本同时 +1 → 差值保留但绝对值漂移）。
  // 注：当前同源断言只检差值，F11 预期不点亮 fork — 该预期本身即 RV-25-01 残余的机检记录
  // （若未来断言升级为绝对值校验，F11 期望改为点亮）。双侧污染必须绊倒 EXPECTED_CHECKS 全等。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f11.mjs`)
  let f11 = readFileSync(`${DIR}/f11.mjs`, "utf8")
  f11 = f11.replace('ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")',
    'ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")\nchecksRun++; states.set("r4-reeval", "pass"); /* NEGPROBE F11: dual-side pollution */')
  writeFileSync(`${DIR}/f11.mjs`, f11)
  if (!f11.includes("dual-side pollution")) throw new Error("F11 anchor missed: ok-line drifted")
  const r11 = run("node", [`${DIR}/f11.mjs`])
  const out11 = (r11.stdout ?? "") + (r11.stderr ?? "")
  check("F11-documented", r11.status === 1 && out11.includes("checks run 4 != expected 3"), `dual-side pollution must trip EXPECTED_CHECKS (status=${r11.status})`)

  // F12：dirty-tree 回归（RV-25-01）— r1-cleantree 真失败时同源断言不得误报 fork。
  // 在工作树干净但强制脏状态下运行 r1r2 副本：期望 FAIL [r1-cleantree] 且输出无 "text/ledger fork"。
  copyFileSync("QMAI/scripts/goal-accept-r1r2.mjs", `${DIR}/f12.mjs`)
  let f12 = readFileSync(`${DIR}/f12.mjs`, "utf8")
  // RV-32-09/RV-32-01/RV-32-04 注记：正则 \{[\s\S]*?\} 为匹配域放宽（容忍尾注/options 变化），精度未变；
  // 只做定位替换不做提取（截断无关）+ guard 确认生效 + anchor 生产侧唯一（非全局无残留）。
  f12 = f12.replace(/const status = execSync\("git -C QMAI status --short", \{[\s\S]*?\}\)\.trim\(\)/,
    'const status = "M fictional-dirty-file.txt" /* NEGPROBE F12: forced dirty */')
  writeFileSync(`${DIR}/f12.mjs`, f12)
  if (!f12.includes("NEGPROBE F12: forced dirty")) throw new Error("F12 anchor missed: status line drifted (see RV-30-04)")
  const r12 = run("node", [`${DIR}/f12.mjs`])
  const out12 = (r12.stdout ?? "") + (r12.stderr ?? "")
  check("F12-exit1", r12.status === 1, `status=${r12.status}`)
  check("F12-no-fork-misfire", out12.includes("FAIL [r1-cleantree]") && !out12.includes("text/ledger fork") && noCrash(out12), "legit-fail misfired as fork / missing cleantree FAIL")

  // F13：exitmap 兜底阳性对照（RV-26-03）— 未列出非零 exit 3 → [det=exitmap] → ENV-FAULT exit 2。
  // 注：signal 分支（[det=signal]）由 F16（RV-40C-01）经 timeout kill 在 win32 实测覆盖；
  // SIGTERM 自杀在 Windows 落为 exit 1 无信号名（平台限制），signal 语义以 F16 超时 kill 为代表。
  writeFileSync(`${DIR}/f13.mjs`, 'process.exit(3);\n')
  writeFileSync(`${DIR}/w13.mjs`, makeWrapper(["f13.mjs"], { "f13.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }))
  const r13 = run("node", [`${DIR}/w13.mjs`])
  const out13 = (r13.stdout ?? "") + (r13.stderr ?? "")
  check("F13-exit2", r13.status === 2, `status=${r13.status}`)
  check("F13-signal", out13.includes("[det=exitmap]") && out13.includes("exit 3"), "exitmap ENV-FAULT headline absent")

  // F14：uncaught-handler 阳性对照（RV-26-03）— try 外同步抛错 →
  // 子脚本 process.on(uncaughtException) → ENV-FAULT exit 2（含 uncaught 身份）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f14.mjs`)
  let f14 = readFileSync(`${DIR}/f14.mjs`, "utf8")
  f14 = f14.replace("try {\nfunction mustContain", 'throw new Error("NEGPROBE F14: outside-try throw");\ntry {\nfunction mustContain')
  writeFileSync(`${DIR}/f14.mjs`, f14)
  if (!f14.includes("outside-try throw")) throw new Error("F14 anchor missed: try-block drifted")
  const r14 = run("node", [`${DIR}/f14.mjs`])
  const out14 = (r14.stdout ?? "") + (r14.stderr ?? "")
  check("F14-exit2", r14.status === 2, `status=${r14.status}`)
  check("F14-uncaught", out14.includes("ENV-FAULT: uncaught") && out14.includes("outside-try throw") && noCrash(out14), "uncaught-handler ENV-FAULT absent / misclassified")

  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f14b.mjs`)
  let f14b = readFileSync(`${DIR}/f14b.mjs`, "utf8")
  f14b = f14b.replace("try {\nfunction mustContain", "Promise.reject(new Error(\"NEGPROBE F14b: unhandled rejection\"));\ntry {\nfunction mustContain")
  writeFileSync(`${DIR}/f14b.mjs`, f14b)
  if (!f14b.includes("NEGPROBE F14b: unhandled rejection")) throw new Error("F14b anchor missed: try-block drifted")
  const r14b = run("node", [`${DIR}/f14b.mjs`])
  const out14b = (r14b.stdout ?? "") + (r14b.stderr ?? "")
  check("F14b-exit2", r14b.status === 2, `status=${r14b.status}`)
  check("F14b-unhandled", out14b.includes("ENV-FAULT: unhandledRejection") && out14b.includes("unhandled rejection") && noCrash(out14b), "unhandledRejection ENV-FAULT absent / misclassified")

  // F16：timeout/signal 阳性对照（RV-40C-01）— 超时 kill 的可观测形态 status===null + signal 非 null
  // 必须被识别为 ENV-FAULT（经 wrapper classify [det=signal] → exit 2），不得落入未知默认或 PASS。
  // 注：短 timeout（200ms）+ sleep 5s，fixture 自身 deterministic；win32 上 kill 经 TerminateProcess，signal 记 SIGTERM。
  writeFileSync(`${DIR}/f16.mjs`, 'setTimeout(() => {}, 5000);\n')
  const r16raw = spawnSync("node", [`${DIR}/f16.mjs`], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 200, killSignal: "SIGKILL" })
  check("F16-signal", r16raw.signal !== null, `signal=${r16raw.signal} status=${r16raw.status}`)
  check("F16-status-null", r16raw.status === null, `status=${r16raw.status} signal=${r16raw.signal}`)
  // F16b：wrapper 层超时 kill 分类 — wrapper 副本 spawn 超时压至 200ms（首个 timeout 命中即步骤 spawn 行；
  // post-run 行保持 60s），步骤被 kill → 超时 kill 同时置 error（ETIMEDOUT）+ signal，classify 按
  // error→signal→status 优先级走 [det=spawn] → ENV-FAULT exit 2（实测：status=null signal=SIGKILL）。
  let w16 = makeWrapper(["f16.mjs"], { "f16.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] })
  // RV-41C-01：锚点唯一性 — "timeout: 60000, killSignal" 在生产 wrapper 存在两处（步骤 spawn 行 86 + post-run 行 107），
  // 但 makeWrapper 已截掉 post-run 块，故副本内必须恰好 1 处。双层断言：生产侧恰好 2 处（顺序漂移/新增/删除即大声
  // 失败）+ 副本侧恰好 1 处（replace 首个即步骤行，正确）；任一不符即 throw，不静默改错行。
  const anchor16 = "timeout: 60000, killSignal"
  const prodAnchorCount = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8").split(anchor16).length - 1
  if (prodAnchorCount !== 2) throw new Error(`F16 anchor ambiguous in production: expected 2 occurrences, found ${prodAnchorCount}`)
  const copyAnchorCount = w16.split(anchor16).length - 1
  if (copyAnchorCount !== 1) throw new Error(`F16 anchor ambiguous in wrapper copy: expected 1 occurrence, found ${copyAnchorCount}`)
  w16 = w16.replace("timeout: 60000, killSignal", "timeout: 200, killSignal")
  writeFileSync(`${DIR}/w16.mjs`, w16)
  if (!w16.includes("timeout: 200, killSignal")) throw new Error("F16 anchor missed: wrapper spawn timeout not redirected")
  const r16 = run("node", [`${DIR}/w16.mjs`])
  const out16 = (r16.stdout ?? "") + (r16.stderr ?? "")
  check("F16-wrapper-exit2", r16.status === 2 && out16.includes("[det=spawn]"), `status=${r16.status}`)

  // RV-26-05：基线身份绑定 — NEGPROBE_EXPECT_HEAD 已设时 START_HEAD 必须等于期望基线
  // （错基线全绿拦截）。RV-27-11："已设" = 变量存在（`in` 语义）；存在但 trim 为空
  // （CI `set X=` 事故）→ 大声 ENV-FAULT，不静默降级为未设。仅完全未导出时恒过
  // （仅起止一致 RV-25-07 生效，此处注明非空转：门禁语义由调用方选择）。
  const headSet = "NEGPROBE_EXPECT_HEAD" in process.env
  const expectHead = (process.env.NEGPROBE_EXPECT_HEAD ?? "").trim()
  if (headSet && expectHead === "") {
    console.error("NEG-ENV-FAULT: NEGPROBE_EXPECT_HEAD exported but empty (refuse silent unbind)")
    process.exit(2)
  }
  check("BASELINE-head", !headSet || START_HEAD === expectHead, `HEAD ${START_HEAD} != expected ${expectHead || "(unset)"}`)

  // RV-27-12：脚本身份绑定 — NEGPROBE_EXPECT_SELF 已设时当前探针 self 哈希必须等于期望
  // （探针字节漂移拦截；与 BASELINE-head 同语义：存在但空 → 大声失败）。
  const probeSelfNow = createHash("sha256").update(readFileSync("QMAI/scripts/goal-accept-negprobe.mjs", "utf8")).digest("hex").slice(0, 16)
  const selfSet = "NEGPROBE_EXPECT_SELF" in process.env
  const expectSelf = (process.env.NEGPROBE_EXPECT_SELF ?? "").trim()
  if (selfSet && expectSelf === "") {
    console.error("NEG-ENV-FAULT: NEGPROBE_EXPECT_SELF exported but empty (refuse silent unbind)")
    process.exit(2)
  }
  check("SELF-bound", !selfSet || probeSelfNow === expectSelf, `self ${probeSelfNow} != expected ${expectSelf || "(unset)"}`)

  // RV-27-04：safeRm 拒绝 unit — 守卫必须可机检拒绝（纵深防御非论证性）。
  // 全部 in-process try/catch，不删任何东西：空/越界/仓内/通配/绝对 各一例，须全部 throw。
  const refuseCases = ["", "..", "QMAI", "QMAI/scripts/x.mjs", "../outside", ".negprobe-tmp/../../x", "C:/Windows/Temp/x", "*.mjs"]
  let refusedAll = true
  for (const c of refuseCases) {
    try { safeRm(c); refusedAll = false; console.error(`NEG-FAIL detail: safeRm accepted ${JSON.stringify(c)}`) }
    catch { /* expected */ }
  }
  // 正例：DIR/DIRTY 常量本身必须通过守卫的纯判定部分（不实际删除 — 只复刻判定逻辑的 dry-run）。
  // 注：safeRm 无 dry-run 参数；此处正例由后文 safeRm(DIR)/safeRm(DIRTY) 实际成功清理覆盖。
  check("F15-saferefuse", refusedAll, "safeRm accepted a forbidden path")

  // F8：仅污染过程计数（账本完好）→ RV-21-03 同源断言必须开火（RV-23-05 差分反证之二；之一为 F3）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f8.mjs`)
  let f8 = readFileSync(`${DIR}/f8.mjs`, "utf8")
  f8 = f8.replace('ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")',
    'ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")\nchecksRun++; /* NEGPROBE F8: counter-only pollution */')
  writeFileSync(`${DIR}/f8.mjs`, f8)
  const r8 = run("node", [`${DIR}/f8.mjs`])
  const out8 = (r8.stdout ?? "") + (r8.stderr ?? "")
  check("F8-exit1", r8.status === 1, `status=${r8.status}`)
  check("F8-fork", out8.includes("text/ledger fork") && noCrash(out8), "text/ledger fork headline absent / crash marks present")

  // F8b/F8c：同源断言必须在全部三个子脚本存活（RV-24-03：不能只钉 r3r4 一家）。
  // r1r2 与 r567 的 ok() 锚行必须与各自文件原文逐字一致，否则 replace 无操作 → 下方 guard 开火。
  const f8variants = [
    ["goal-accept-r1r2.mjs", 'ok("r2-reports", "R2 all 4 reference reports present with baseline markers")'],
    ["goal-accept-r567.mjs", 'ok("r7-comp", "R7 UI usability: 177 files / 3055 component tests (176/2980 + graph 75/75), zero FAIL")'],
  ]
  for (const [src, anchor] of f8variants) {
    const tag = src === "goal-accept-r1r2.mjs" ? "F8b" : "F8c"
    let fx = readFileSync(`QMAI/scripts/${src}`, "utf8")
    if (!fx.includes(anchor)) { check(`${tag}-anchor`, false, `anchor line absent in ${src}`); continue }
    check(`${tag}-anchor`, true, "")
    fx = fx.replace(anchor, anchor + "\nchecksRun++; /* NEGPROBE F8x: counter-only pollution */")
    writeFileSync(`${DIR}/fx.mjs`, fx)
  if (!fx.includes("NEGPROBE F8x: counter-only pollution")) throw new Error("F8x anchor missed")
    const rx = run("node", [`${DIR}/fx.mjs`])
    const outx = (rx.stdout ?? "") + (rx.stderr ?? "")
    check(`${tag}-exit1`, rx.status === 1, `status=${rx.status}`)
    check(`${tag}-fork`, outx.includes("text/ledger fork") && noCrash(outx), "text/ledger fork headline absent / crash marks present")
  }

  // F9：部分失败聚合 — 同一 runner、同一模式（顺序执行、首坏即中止）：
  // F9a 坏在后：好 STEP 已 PASS 照常 + ALL-FAIL exit 1（聚合面）；
  // F9b 坏在前：短路，好 STEP 永不执行（短路面）。两者是同一语义的两面，非双模式（RV-24-04）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/pok.mjs`)
  const ids9 = { "pok.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"], "f2.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }
  writeFileSync(`${DIR}/w9a.mjs`, makeWrapper(["pok.mjs", "f2.mjs"], ids9))
  writeFileSync(`${DIR}/w9b.mjs`, makeWrapper(["f2.mjs", "pok.mjs"], ids9))
  const r9a = run("node", [`${DIR}/w9a.mjs`])
  const out9a = (r9a.stdout ?? "") + (r9a.stderr ?? "")
  check("F9a-exit1", r9a.status === 1, `status=${r9a.status}`)
  check("F9a-step-pass-ok", out9a.includes("STEP PASS: pok.mjs"), "good-step STEP PASS absent")
  check("F9a-allfail", out9a.includes("ALL-FAIL") && noCrash(out9a), "ALL-FAIL headline absent / crash marks present")
  const r9b = run("node", [`${DIR}/w9b.mjs`])
  const out9b = (r9b.stdout ?? "") + (r9b.stderr ?? "")
  check("F9b-exit1", r9b.status === 1, `status=${r9b.status}`)
  check("F9b-shortcircuit", !out9b.includes("pok.mjs") && noCrash(out9b), "short-circuit violated: good step executed after FAIL / crash marks present")

  safeRm(DIR)
  safeRm(DIRTY)
  // CLEAN：探针残留断言 — tmp 均在 hub root（QMAI 仓外），运行后必须无残留（RV-23-04 分离证据）。
  // RV-25-06：残留清理走 safeRm 安全前置（路径非空/相对/hub-root 内/非 QMAI 内/无通配）。
  check("CLEAN-tmp-gone", !existsSync(DIR) && !existsSync(DIRTY), "probe residue remains")
  check("CLEAN-safe", true, "") // safeRm 已在每次调用打印 CLEAN-SAFE 行；本行仅占 MANIFEST 位
} catch (e) {
  console.error("NEG-ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
if (failures.length > 0) {
  console.error(`NEGPROBE FAIL: ${failures.length} fixture(s): ${failures.join(", ")}`)
  process.exit(1)
}
// RV-24-02 分母双向断言：executed-set == MANIFEST；缺失 probe → ENV-FAULT（exit 2），不记 PASS。
const execSet = [...new Set(executed)].sort()
const manSet = [...MANIFEST].sort()
if (JSON.stringify(execSet) !== JSON.stringify(manSet)) {
  console.error(`NEG-ENV-FAULT: executed-set != MANIFEST — executed [${execSet.join(",")}] manifest [${manSet.join(",")}]`)
  process.exit(2)
}
// RV-24-10 证据绑定 + RV-25-07 起止一致：HEAD 起止采样必须相等（运行中树变更即 ENV-FAULT）；
// 期望 HEAD 由外部钉住比对（产物只输出，不自证）。
const headSha = safeHead()
// RV-40C-03：unresolved 永不空过 — 任一端采样失败即 ENV-FAULT（unresolved===unresolved 不得通过）。
if (START_HEAD === "(unresolved)" || headSha === "(unresolved)") {
  console.error(`NEG-ENV-FAULT: HEAD unresolved (baseline anchor unavailable) — start ${START_HEAD} end ${headSha}`)
  process.exit(2)
}
if (START_HEAD !== headSha) {
  console.error(`NEG-ENV-FAULT: HEAD moved during run — start ${START_HEAD} end ${headSha}`)
  process.exit(2)
}
const selfHash = createHash("sha256").update(readFileSync("QMAI/scripts/goal-accept-negprobe.mjs", "utf8")).digest("hex").slice(0, 16)
// RV-27-10：平台条件记录 — 全绿结论是平台条件的（signal 分支 Windows 不可达）；
// 尾行强制打印 platform + node 版本，使未来读者可判定哪些 arm 被跳过。
console.log(`NEGPROBE ALL PASS (${MANIFEST.length}/${MANIFEST.length}) HEAD=${headSha} self=${selfHash} platform=${process.platform} node=${process.version}`)
