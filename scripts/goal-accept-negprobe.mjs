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
//   CLEAN-tmp-gone → RV-23-04（tmp 在 QMAI 仓外 + 运行后无残留）
//   终态 executed-set == MANIFEST 双向断言 → RV-24-02（分母完整性；缺失 probe 记 ENV-FAULT）
//   exit-1 断言均附 noCrash 崩溃哨兵 → RV-24-01（`exit 1 ⇔ 断言失败`，结构化 FAIL 记录身份）
//   尾行 HEAD + self 哈希 → RV-24-10（证据绑定，可回溯到工件）
import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const DIR = ".negprobe-tmp"
const DIRTY = ".negprobe-dirty" // F7 专用脏仓（hub root，QMAI 仓外）
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
  "INIT-steps", "INIT-toolchain",
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
  "CLEAN-tmp-gone",
]
// RV-24-01：崩溃哨兵 — exit-1 断言必须同时确认输出中无 Node 崩溃痕迹（崩溃同样 exit 1，
// 仅比退出码会把“因崩溃而绿”计为通过）。合法 FAIL 行只含 "FAIL [id]:"，不含以下标记。
const CRASH_MARKS = ["node:internal", "SyntaxError", "ReferenceError", "TypeError", "UnhandledPromiseRejection"]
// 注意：git 的 "fatal:" 走 stderr 是探针合法输出（F1 树注入必然触发），不属 Node 崩溃，不列入哨兵。
function noCrash(out) { return !CRASH_MARKS.some((m) => out.includes(m)) }
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false })
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
  rmSync(DIR, { recursive: true, force: true })
  rmSync(DIRTY, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })

  // INIT：正向调用者清单机检（RV-23-06 静态面 + RV-24-09：生产 wrapper 的 STEPS/EXPECTED_IDS
  // 必须与契约一致，否则后续 3/3 的含义漂移）。
  const prodW = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  const prodSteps = [...prodW.matchAll(/"(goal-accept-[a-z0-9]+\.mjs)"/g)].map((m) => m[1])
  const prodStepSet = [...new Set(prodSteps)].filter((s) => prodW.includes(`"${s}": [`))
  check("INIT-steps", JSON.stringify(prodStepSet) === JSON.stringify(["goal-accept-r1r2.mjs", "goal-accept-r3r4.mjs", "goal-accept-r567.mjs"]), `STEPS/EXPECTED_IDS drift: [${prodStepSet.join(",")}]`)
  // RV-24-08 正向证据：initiator（node 二进制绝对路径 + cwd + git 解析路径）回显并断言。
  console.log(`INIT node=${process.execPath} cwd=${process.cwd()}`)
  let gitPath = ""
  try { gitPath = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim() } catch { gitPath = "" }
  console.log(`INIT git=${gitPath || "(unresolved)"}`)
  check("INIT-toolchain", process.execPath !== "" && gitPath !== "" && existsSync("QMAI/scripts/goal-accept-all.mjs"), "toolchain/cwd unresolved")

  // F1：树哈希注入 r1r2 — RV-21-02 固化（期望 exit=1 + FAIL + states fail，非 ENV-FAULT）。
  const tree = execFileSync("git", ["-C", "QMAI", "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()
  copyFileSync("QMAI/scripts/goal-accept-r1r2.mjs", `${DIR}/f1.mjs`)
  let f1 = readFileSync(`${DIR}/f1.mjs`, "utf8")
  f1 = f1.replace('"a741863a", "86862911"', `"${tree}", "86862911"`)
  writeFileSync(`${DIR}/f1.mjs`, f1)
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
  let w3 = readFileSync(`${DIR}/w2.mjs`, "utf8")
  w3 = w3.split('"f2.mjs"').join('"f3.mjs"')
  writeFileSync(`${DIR}/w3.mjs`, w3)
  const r3 = run("node", [`${DIR}/w3.mjs`])
  const out3 = (r3.stdout ?? "") + (r3.stderr ?? "")
  check("F3-exit2", r3.status === 2, `status=${r3.status}`)
  check("F3-missing-keys", out3.includes("missing") && out3.includes("r4-reeval"), "missing-keys headline absent")
  check("F3-no-allpass", !out3.includes("ALL goal-accept STEPS PASS"), "ALL PASS present despite missing key")

  // F4：真实环境故障正向对照 — 缺失可执行文件（PATH/安装损坏类），ENV-FAULT 必须可达（RV-23-01）。
  let w4 = readFileSync("QMAI/scripts/goal-accept-all.mjs", "utf8")
  w4 = w4.split('spawnSync("node", [').join('spawnSync("node-nonexistent-bin-xyz", [')
  writeFileSync(`${DIR}/w4.mjs`, w4)
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
  const r5 = run("node", [`${DIR}/w5.mjs`])
  const out5 = (r5.stdout ?? "") + (r5.stderr ?? "")
  check("F5-exit2", r5.status === 2, `status=${r5.status}`)
  check("F5-want-empty", out5.includes("EXPECTED_IDS empty"), "want-empty ENV-FAULT headline absent")

  // F7：POST-RUN 时序反证 — 运行后树脏 ⇒ ENV-FAULT exit 2（RV-23-04；证明该分支存活；
  // RV-24-05：卫生违例归 ENV-FAULT，使 `exit 1 ⇔ 断言失败` 成为机检不变量）。
  execFileSync("git", ["init", "-q", DIRTY], { encoding: "utf8" })
  writeFileSync(`${DIRTY}/dirty.txt`, "uncommitted\n")
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f7.mjs`)
  let w7 = makeWrapper(["f7.mjs"], { "f7.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }, true)
  w7 = w7.split("git -C QMAI status --short").join(`git -C ${DIRTY} status --short`)
  writeFileSync(`${DIR}/w7.mjs`, w7)
  const r7 = run("node", [`${DIR}/w7.mjs`])
  const out7 = (r7.stdout ?? "") + (r7.stderr ?? "")
  check("F7-exit2", r7.status === 2, `status=${r7.status}`)
  check("F7-postrun-dirty", out7.includes("post-run tree not clean") && out7.includes("ALL-ENV-FAULT"), "post-run-dirty ENV-FAULT headline absent")

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

  rmSync(DIR, { recursive: true, force: true })
  rmSync(DIRTY, { recursive: true, force: true })
  // CLEAN：探针残留断言 — tmp 均在 hub root（QMAI 仓外），运行后必须无残留（RV-23-04 分离证据）。
  check("CLEAN-tmp-gone", !existsSync(DIR) && !existsSync(DIRTY), "probe residue remains")
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
// RV-24-10 证据绑定：验收记录携带 HEAD + 本脚本自哈希，使计数可回溯到工件。
let headSha = ""
try { headSha = execFileSync("git", ["-C", "QMAI", "rev-parse", "HEAD"], { encoding: "utf8" }).trim() } catch { headSha = "(unresolved)" }
const selfHash = createHash("sha256").update(readFileSync("QMAI/scripts/goal-accept-negprobe.mjs", "utf8")).digest("hex").slice(0, 16)
console.log(`NEGPROBE ALL PASS (${MANIFEST.length}/${MANIFEST.length}) HEAD=${headSha} self=${selfHash}`)
