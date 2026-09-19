import { execFileSync } from "node:child_process"
import { existsSync, rmSync, readFileSync } from "node:fs"

const OUT = ".qmai-audit-final.json"
if (existsSync(OUT)) rmSync(OUT)

// Focused regression-core suite: proves (a) original features intact,
// (b) five移植 groups present & green. Fast (<15s) for CI/verifier gates.
const FILES = [
  "src/lib/novel/memory-center.spec.ts",
  "src/lib/novel/deterministic-continuity-engine.spec.ts",
  "src/lib/novel/mechanical-slop-detector.spec.ts",
  "src/lib/novel/plot-framework.spec.ts",
  "src/lib/user-memory-learning/store.spec.ts",
  "src/lib/novel/foreshadowing-cleanup.spec.ts",
  "src/lib/novel/outline-wizard-core.spec.ts",
  "src/lib/novel/session-summary.spec.ts",
  "src/lib/novel/token-estimator.spec.ts",
]

execFileSync("npx", ["vitest", "run", ...FILES, "--reporter=json", `--outputFile=${OUT}`], {
  stdio: "inherit",
  cwd: process.cwd(),
})

const report = JSON.parse(readFileSync(OUT, "utf-8"))
rmSync(OUT)
if (report.numFailedTests > 0) {
  console.error("FAIL", report.numFailedTests, "failed of", report.numTotalTests)
  process.exit(1)
}
console.log("PASS", report.numPassedTests, "passed of", report.numTotalTests, "total (regression-core focused suite)")
