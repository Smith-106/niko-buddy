/**
 * Smoke parity for residual-rewrite-toolkit.mjs vs residual-rewrite-policy rules.
 * Run: node --test scripts/residual-rewrite-toolkit.spec.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const cli = join(__dirname, "residual-rewrite-toolkit.mjs")

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  })
  return r
}

describe("residual-rewrite-toolkit CLI", () => {
  it("rejects densify_only at 8.8", () => {
    const r = run(["evaluate", "--median", "8.8", "--mode", "densify_only", "--json"])
    assert.equal(r.status, 2)
    const d = JSON.parse(r.stdout)
    assert.equal(d.accept, false)
    assert.equal(d.requiredMode, "structure_thril_pacing")
    assert.equal(d.productHardGate, false)
  })

  it("accepts structure_thril_pacing at 8.8", () => {
    const r = run([
      "evaluate",
      "--median",
      "8.8",
      "--mode",
      "structure_thril_pacing",
      "--length-preserving",
      "--json",
    ])
    assert.equal(r.status, 0)
    const d = JSON.parse(r.stdout)
    assert.equal(d.accept, true)
  })

  it("constraint names structure_thril_pacing when densify rejected", () => {
    const r = run([
      "constraint",
      "--median",
      "8.8",
      "--mode",
      "densify_only",
      "--chapter",
      "5",
    ])
    assert.equal(r.status, 2)
    assert.match(r.stdout, /structure_thril_pacing/)
    assert.match(r.stdout, /ChapterStructurePlan/)
    assert.match(r.stdout, /productHardGate=false/)
  })

  it("gate-modes shows densify banned and structure ok", () => {
    const r = run(["gate-modes", "--median", "8.8", "--json"])
    assert.equal(r.status, 0)
    const d = JSON.parse(r.stdout)
    const densify = d.rows.find((x) => x.mode === "densify_only")
    const struct = d.rows.find((x) => x.mode === "structure_thril_pacing")
    assert.equal(densify.accept, false)
    assert.equal(struct.accept, true)
  })
})
