// goal-accept-r567.mjs — R5 (feasibility) + R6 (stability) + R7 (UI usability).
// Run from workspace root: node QMAI/scripts/goal-accept-r567.mjs
// ENV-FAULT (RV-112/RV-125): 环境故障必须 fail-closed — IO 异常即非零退出，禁止 default-to-pass。
import { existsSync, readFileSync } from "node:fs"

function fail(msg) { console.error("FAIL: " + msg); process.exit(1) }
function ok(msg) { console.log("PASS: " + msg) }

try {
function read(p) {
  if (!existsSync(p)) fail("missing " + p)
  return readFileSync(p, "utf8")
}
function noFailLines(t, label) {
  const bad = t.split("\n").filter((l) => l.startsWith(" FAIL"))
  if (bad.length > 0) fail(label + " has " + bad.length + " FAIL lines")
}

// R5: build artifact + build log + typecheck log (live typecheck is a
// separate acceptance command: `npm --prefix QMAI run typecheck`).
if (!existsSync("QMAI/dist/index.html")) fail("missing QMAI/dist/index.html")
ok("R5 build artifact QMAI/dist/index.html present")
const buildLog = read("C:/goal-evidence/11-build.log")
if (!buildLog.includes("built in")) fail("build log lacks built-in line")
ok("R5 build log shows successful build")
const tcLog = read("C:/goal-evidence/10-typecheck.log")
if (!tcLog.includes("TYPECHECK_EXIT=0")) fail("typecheck log not EXIT=0")
ok("R5 typecheck log EXIT=0")

// R6: full mocks suite green.
// Fresh 2026-09-25 run (#105): 890 files / 13331 tests (+3 new excludeOutline specs
// in existing trim.spec file, files count unchanged) + graph 75/75, zero FAIL.
// Accept 13328 (old) or 13331 (new) — never lower (no relaxation, growth only).
const mocks = read("C:/goal-evidence/12-mocks.log")
for (const m of ["890 passed", "75 passed", "MOCKS_FAIL=0"]) {
  if (!mocks.includes(m)) fail("mocks log lacks " + m)
}
if (!mocks.includes("13328 passed") && !mocks.includes("13331 passed")) fail("mocks log lacks 13328/13331 passed")
noFailLines(mocks, "mocks")
ok("R6 stability: 890 files / 13331 tests + graph 75/75, zero FAIL")

// R7: component suite green.
// 177 files / 3055 tests total = 176 + graph-view isolation (1 file / 75 tests),
// matching the test:mocks split convention. Evidence log 13-comp.log holds both
// sections (176/2980 + graph 75/75) + COMP_FAIL=0.
const comp = read("C:/goal-evidence/13-comp.log")
for (const m of ["COMP_FAIL=0", "75 passed"]) {
  if (!comp.includes(m)) fail("comp log lacks " + m)
}
if (!comp.includes("3055 passed") && !(comp.includes("2980 passed") && comp.includes("176 passed"))) fail("comp log lacks 3055 (or 2980+176 split) passed")
noFailLines(comp, "comp")
ok("R7 UI usability: 177 files / 3055 component tests (176/2980 + graph 75/75), zero FAIL")
console.log("ALL R567 PASS")
} catch (e) {
  // ENV-FAULT 哨兵：任何环境/通道异常（EPIPE、IO 失败）显式标记并以非零退出。
  console.error("ENV-FAULT: " + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
}
