// goal-accept-r567.mjs — R5 (feasibility) + R6 (stability) + R7 (UI usability).
// Run from workspace root: node QMAI/scripts/goal-accept-r567.mjs
import { existsSync, readFileSync } from "node:fs"

function fail(msg) { console.error("FAIL: " + msg); process.exit(1) }
function ok(msg) { console.log("PASS: " + msg) }
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
const mocks = read("C:/goal-evidence/12-mocks.log")
for (const m of ["890 passed", "13328 passed", "75 passed", "MOCKS_FAIL=0"]) {
  if (!mocks.includes(m)) fail("mocks log lacks " + m)
}
noFailLines(mocks, "mocks")
ok("R6 stability: 890 files / 13328 tests + graph 75/75, zero FAIL")

// R7: component suite green.
const comp = read("C:/goal-evidence/13-comp.log")
for (const m of ["177 passed", "3055 passed", "COMP_FAIL=0"]) {
  if (!comp.includes(m)) fail("comp log lacks " + m)
}
noFailLines(comp, "comp")
ok("R7 UI usability: 177 files / 3055 component tests, zero FAIL")
console.log("ALL R567 PASS")
