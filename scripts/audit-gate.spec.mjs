import { describe, expect, it, vi } from "vitest"
import {
  AUDIT_EXCEPTIONS,
  evaluateAuditReport,
  parseAndValidateAuditReport,
  runAuditGate,
} from "./audit-gate.mjs"

const BRACES_URL = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
const ZOD_URL = "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5"

function makeReport(vulnerabilities, counts = {}) {
  const entries = Object.values(vulnerabilities)
  const high = counts.high ?? entries.filter((v) => v.severity === "high").length
  const critical = counts.critical ?? entries.filter((v) => v.severity === "critical").length
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high,
        critical,
        total: high + critical,
      },
    },
  }
}

function makeDeps(exec) {
  const logs = []
  const errors = []
  return {
    deps: {
      exec,
      log: (msg) => logs.push(String(msg)),
      error: (msg) => errors.push(String(msg)),
    },
    logs,
    errors,
  }
}

describe("audit-gate.mjs contract (F15 + E5-02 offline fail-closed regression net)", () => {
  it("passes (exit 0) when only the known braces exception is present and revalidate confirms 3.0.3", () => {
    const report = makeReport({
      braces: { severity: "high", via: [{ url: BRACES_URL }] },
      "eslint-plugin-boundaries": { severity: "high", via: ["braces"] },
    })
    const exec = vi.fn((command) => {
      if (command === "npm view braces version --json") return JSON.stringify("3.0.3")
      if (command === "npm audit --json") {
        throw Object.assign(new Error("audit exit 1 with known exception"), {
          status: 1,
          stdout: JSON.stringify(report),
        })
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const { deps, logs, errors } = makeDeps(exec)
    const code = runAuditGate(deps)

    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(logs.join("\n")).toContain("AUDIT-GATE-PASS")
    const exceptLines = logs.filter((line) => line.startsWith("EXCEPT"))
    expect(exceptLines.length).toBe(2)
    for (const line of exceptLines) {
      expect(line).toContain("GHSA-vfj7-8cjw-p6xm")
    }
  })

  it("passes (exit 0) on a clean report with zero vulnerabilities", () => {
    const report = makeReport({})
    const exec = vi.fn((command) => {
      if (command === "npm view braces version --json") return JSON.stringify("3.0.3")
      if (command === "npm audit --json") return JSON.stringify(report)
      throw new Error(`unexpected command: ${command}`)
    })

    const { deps, logs, errors } = makeDeps(exec)
    expect(runAuditGate(deps)).toBe(0)
    expect(errors).toEqual([])
    expect(logs.join("\n")).toContain("AUDIT-GATE-PASS")
  })

  it("rejects (exit 1) the retired Zod high advisory even when its via chain includes braces", () => {
    const report = makeReport({
      braces: { severity: "high", via: [{ url: BRACES_URL }] },
      zod: { severity: "high", via: ["braces", { url: ZOD_URL }] },
    })
    const exec = vi.fn((command) => {
      if (command === "npm view braces version --json") return JSON.stringify("3.0.3")
      if (command === "npm audit --json") {
        throw Object.assign(new Error("fixture audit found high vulnerabilities"), {
          status: 1,
          stdout: JSON.stringify(report),
        })
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const { deps, logs, errors } = makeDeps(exec)
    const code = runAuditGate(deps)

    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("AUDIT-GATE-FAIL")
    expect(errors.join("\n")).toContain(ZOD_URL)
    const exceptLines = logs.filter((line) => line.startsWith("EXCEPT"))
    expect(exceptLines.some((line) => line.includes(BRACES_URL))).toBe(true)
    expect(exceptLines.some((line) => line.includes(ZOD_URL))).toBe(false)
  })

  it("fails closed when braces revalidate sees a newer upstream version", () => {
    const report = makeReport({
      braces: { severity: "high", via: [{ url: BRACES_URL }] },
    })
    const exec = vi.fn((command) => {
      if (command === "npm view braces version --json") return JSON.stringify(["3.0.3", "3.0.4"])
      if (command === "npm audit --json") return JSON.stringify(report)
      throw new Error(`unexpected command: ${command}`)
    })

    const { deps, logs, errors } = makeDeps(exec)
    expect(runAuditGate(deps)).toBe(1)
    expect(errors.join("\n")).toContain("REVALIDATE-FAIL")
    expect(errors.join("\n")).toContain("3.0.4")
    expect(logs.join("\n")).not.toContain("AUDIT-GATE-PASS")
  })

  it("fails closed when braces revalidate encounters a network/exec error", () => {
    const report = makeReport({
      braces: { severity: "high", via: [{ url: BRACES_URL }] },
    })
    const exec = vi.fn((command) => {
      if (command === "npm view braces version --json") {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org")
      }
      if (command === "npm audit --json") return JSON.stringify(report)
      throw new Error(`unexpected command: ${command}`)
    })

    const { deps, logs, errors } = makeDeps(exec)
    expect(runAuditGate(deps)).toBe(1)
    expect(errors.join("\n")).toContain("REVALIDATE-FAIL")
    expect(errors.join("\n")).toContain("ENOTFOUND")
    expect(logs.join("\n")).not.toContain("AUDIT-GATE-PASS")
  })

  it.each([
    ["npm audit error payload (ENOTFOUND)", JSON.stringify({ error: { code: "ENOTFOUND", summary: "getaddrinfo ENOTFOUND registry.npmjs.org" } })],
    ["empty output", ""],
    ["whitespace output", "   \n  "],
    ["invalid JSON", "{not valid json"],
    ["non-object JSON", "[]"],
    ["missing vulnerabilities", JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0 } } })],
    ["non-object vulnerabilities", JSON.stringify({ vulnerabilities: [], metadata: { vulnerabilities: { high: 0, critical: 0 } } })],
    ["missing metadata", JSON.stringify({ vulnerabilities: {} })],
    ["missing metadata.vulnerabilities", JSON.stringify({ vulnerabilities: {}, metadata: {} })],
    ["invalid metadata.vulnerabilities counts", JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: "bad", critical: 0 } } })],
    ["fractional metadata.vulnerabilities.high", JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 1.5, critical: 0 } } })],
    ["fractional metadata.vulnerabilities.critical", JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0.5 } } })],
    ["metadata high > 0 with empty vulnerabilities map", JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 1, critical: 0 } } })],
    ["metadata high count mismatches actual high entries", JSON.stringify({ vulnerabilities: { a: { severity: "high", via: [] } }, metadata: { vulnerabilities: { high: 2, critical: 0 } } })],
    ["metadata critical count mismatches actual critical entries", JSON.stringify({ vulnerabilities: { a: { severity: "high", via: [] } }, metadata: { vulnerabilities: { high: 1, critical: 1 } } })],
    ["metadata zero hides actual high entry", JSON.stringify({ vulnerabilities: { a: { severity: "high", via: [] } }, metadata: { vulnerabilities: { high: 0, critical: 0 } } })],
  ])("fails closed on malformed or error npm audit response: %s", (_label, rawPayload) => {
    expect(() => parseAndValidateAuditReport(rawPayload)).toThrow(/AUDIT-GATE-FAIL/)

    const exec = vi.fn((command) => {
      if (command === "npm audit --json") return rawPayload
      throw new Error(`should not call ${command} when audit report is invalid`)
    })
    const { deps, logs, errors } = makeDeps(exec)
    expect(runAuditGate(deps)).toBe(1)
    expect(errors.join("\n")).toContain("AUDIT-GATE-FAIL")
    expect(logs.join("\n")).not.toContain("AUDIT-GATE-PASS")
  })

  it("fails closed when npm audit command throws without stdout", () => {
    const exec = vi.fn(() => {
      throw new Error("spawnSync npm ENOENT")
    })
    const { deps, logs, errors } = makeDeps(exec)
    expect(runAuditGate(deps)).toBe(1)
    expect(errors.join("\n")).toContain("AUDIT-GATE-FAIL")
    expect(errors.join("\n")).toContain("ENOENT")
    expect(logs.join("\n")).not.toContain("AUDIT-GATE-PASS")
  })

  it("evaluateAuditReport handles cyclic via graphs and never exempts high vulns without advisory URLs", () => {
    const report = makeReport({
      "pkg-a": { severity: "high", via: ["pkg-b"] },
      "pkg-b": { severity: "high", via: ["pkg-a"] },
      "pkg-low": { severity: "moderate", via: [] },
    })
    const result = evaluateAuditReport(report, { exceptions: AUDIT_EXCEPTIONS })
    expect(result.ok).toBe(false)
    expect(result.excepted).toEqual([])
    expect(result.offenders).toEqual([
      "high pkg-a <- no-advisory-url",
      "high pkg-b <- no-advisory-url",
    ])
  })
})
