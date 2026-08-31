import { execFileSync } from "node:child_process"
import { existsSync, rmSync, readFileSync } from "node:fs"

const OUT = ".qmai-audit-final.json"
if (existsSync(OUT)) rmSync(OUT)

execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${OUT}`], {
  stdio: "inherit",
  cwd: process.cwd(),
})

const report = JSON.parse(readFileSync(OUT, "utf-8"))
rmSync(OUT)
if (report.numFailedTests > 0) {
  console.error("FAIL", report.numFailedTests, "failed of", report.numTotalTests)
  process.exit(1)
}
console.log("PASS", report.numPassedTests, "passed of", report.numTotalTests, "total")
