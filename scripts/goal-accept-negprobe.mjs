// goal-accept-negprobe.mjs — 负向 fixture（RV-21-01/RV-22-03/RV-22-06/RV-23-01~09）：门禁必须被观测为失败。
// Run from workspace root: node QMAI/scripts/goal-accept-negprobe.mjs
// 自包含、可执行、自校验。探针均为外部复制+改写，不在生产计分路径（RV-208）。
// Fixture ↔ RV 覆盖表（RV-23-08 可审计映射）：
//   F1-exit1 / F1-fail-not-envfault / F1-states-fail / F1-no-allpass → RV-21-02（树注入语义负结果）
//   F2-exit1 / F2-fail-headline / F2-no-allpass → RV-159 第一道（子脚本集合检查）
//   F3-exit2 / F3-missing-keys / F3-no-allpass → RV-201/RV-22-01 第二道（wrapper 缺键）
//   F4-exit2 / F4-spawn-error → RV-23-01（ENV-FAULT 正向对照：缺失可执行文件）
//   F5-exit2 / F5-want-empty → RV-23-02/03/06（STEPS/EXPECTED_IDS 失配 taxonomy）
//   F7-exit1 / F7-postrun-dirty → RV-23-04（POST-RUN 分支存活反证）
//   F8-exit1 / F8-fork → RV-23-05（计数单侧污染差分；账本单侧污染为 F3）
//   F9a-exit1 / F9a-step-pass-ok / F9a-allfail → RV-23-07（部分失败聚合）
//   F9b-exit1 / F9b-shortcircuit → 短路语义（FAIL 即中止，后续 STEP 不执行）
//   CLEAN-tmp-gone → RV-23-04（tmp 在 QMAI 仓外 + 运行后无残留）
import { spawnSync, execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const DIR = ".negprobe-tmp"
const DIRTY = ".negprobe-dirty" // F7 专用脏仓（hub root，QMAI 仓外）
let failures = []
function check(name, cond, detail) {
  if (cond) console.log(`NEG-PASS: ${name}`)
  else { failures.push(name); console.error(`NEG-FAIL: ${name} — ${detail}`) }
}
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

  // F7：POST-RUN 时序反证 — 运行后树脏 ⇒ ALL-FAIL exit 1（RV-23-04；证明该分支存活）。
  execFileSync("git", ["init", "-q", DIRTY], { encoding: "utf8" })
  writeFileSync(`${DIRTY}/dirty.txt`, "uncommitted\n")
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f7.mjs`)
  let w7 = makeWrapper(["f7.mjs"], { "f7.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }, true)
  w7 = w7.split("git -C QMAI status --short").join(`git -C ${DIRTY} status --short`)
  writeFileSync(`${DIR}/w7.mjs`, w7)
  const r7 = run("node", [`${DIR}/w7.mjs`])
  const out7 = (r7.stdout ?? "") + (r7.stderr ?? "")
  check("F7-exit1", r7.status === 1, `status=${r7.status}`)
  check("F7-postrun-dirty", out7.includes("post-run tree not clean"), "post-run-dirty headline absent")

  // F8：仅污染过程计数（账本完好）→ RV-21-03 同源断言必须开火（RV-23-05 差分反证之二；之一为 F3）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/f8.mjs`)
  let f8 = readFileSync(`${DIR}/f8.mjs`, "utf8")
  f8 = f8.replace('ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")',
    'ok("r4-reeval", "R4 re-eval chain (#90 -> #91 -> #102) on file")\nchecksRun++; /* NEGPROBE F8: counter-only pollution */')
  writeFileSync(`${DIR}/f8.mjs`, f8)
  const r8 = run("node", [`${DIR}/f8.mjs`])
  const out8 = (r8.stdout ?? "") + (r8.stderr ?? "")
  check("F8-exit1", r8.status === 1, `status=${r8.status}`)
  check("F8-fork", out8.includes("text/ledger fork"), "text/ledger fork headline absent")

  // F9：部分失败聚合 — 一好(pok)一坏(f2)：坏在后（F9a：好 STEP PASS 照常 + ALL-FAIL exit 1）；
  // 坏在前（F9b：短路，好 STEP 永不执行）。
  copyFileSync("QMAI/scripts/goal-accept-r3r4.mjs", `${DIR}/pok.mjs`)
  const ids9 = { "pok.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"], "f2.mjs": ["r3-gaps", "r3b-fixes", "r4-reeval"] }
  writeFileSync(`${DIR}/w9a.mjs`, makeWrapper(["pok.mjs", "f2.mjs"], ids9))
  writeFileSync(`${DIR}/w9b.mjs`, makeWrapper(["f2.mjs", "pok.mjs"], ids9))
  const r9a = run("node", [`${DIR}/w9a.mjs`])
  const out9a = (r9a.stdout ?? "") + (r9a.stderr ?? "")
  check("F9a-exit1", r9a.status === 1, `status=${r9a.status}`)
  check("F9a-step-pass-ok", out9a.includes("STEP PASS: pok.mjs"), "good-step STEP PASS absent")
  check("F9a-allfail", out9a.includes("ALL-FAIL"), "ALL-FAIL headline absent")
  const r9b = run("node", [`${DIR}/w9b.mjs`])
  const out9b = (r9b.stdout ?? "") + (r9b.stderr ?? "")
  check("F9b-exit1", r9b.status === 1, `status=${r9b.status}`)
  check("F9b-shortcircuit", !out9b.includes("pok.mjs"), "short-circuit violated: good step executed after FAIL")

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
console.log("NEGPROBE ALL PASS (F1+F2+F3+F4+F5+F7+F8+F9, 24/24)")
