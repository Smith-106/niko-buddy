// goal-accept-negprobe.mjs — 负向 fixture（RV-21-01/RV-22-03/RV-22-06）：门禁必须被观测为失败。
// Run from workspace root: node QMAI/scripts/goal-accept-negprobe.mjs
// 自包含、可执行、自校验：F1 树哈希注入（期望 exit=1 FAIL 非 ENV-FAULT）；
// F2 缺 ok → 子脚本 RV-159 集合检查先 FAIL（期望 wrapper exit=1 + ALL-FAIL，第一道）；
// 探针均为外部复制+改写，不在生产计分路径（RV-208）。
import { spawnSync, execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const DIR = ".negprobe-tmp"
let failures = []
function check(name, cond, detail) {
  if (cond) console.log(`NEG-PASS: ${name}`)
  else { failures.push(name); console.error(`NEG-FAIL: ${name} — ${detail}`) }
}
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false })
}

try {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })

  // F1：树哈希注入 r1r2 — RV-21-02 固化（期望 exit=1 + FAIL + states fail，非 ENV-FAULT）。
  const tree = execFileSync("git", ["-C", "QMAI", "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()
  copyFileSync("QMAI/scripts/goal-accept-r1r2.mjs", `${DIR}/f1.mjs`)
  let f1 = readFileSync(`${DIR}/f1.mjs`, "utf8")
  f1 = f1.replace('"a741863a", "86862911"', `"${tree}", "86862911"`)
  writeFileSync(`${DIR}/f1.mjs`, f1)
  const r1 = run("node", [`${DIR}/f1.mjs`])
  const out1 = (r1.stdout ?? "") + (r1.stderr ?? "")
  check("F1-exit1", r1.status === 1, `status=${r1.status}`)
  check("F1-fail-not-envfault", out1.includes("FAIL [r1-8gap]") && !out1.includes("ENV-FAULT"), "missing FAIL / unexpected ENV-FAULT")
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
  check("F2-fail-headline", out2.includes("ALL-FAIL"), "ALL-FAIL headline absent")
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

  rmSync(DIR, { recursive: true, force: true })
} catch (e) {
  console.error("NEG-ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
if (failures.length > 0) {
  console.error(`NEGPROBE FAIL: ${failures.length} fixture(s): ${failures.join(", ")}`)
  process.exit(1)
}
console.log("NEGPROBE ALL PASS (F1 tree-inject + F2 first-line + F3 second-line, 10/10)")
