import { describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const gate = join(here, "audit-gate.mjs")

describe("audit-gate.mjs contract (F15: arch -0.3 regression net)", () => {
  it("exits 0 with AUDIT-GATE-PASS on the current advisory set", () => {
    // 契约测试：门脚本按设计工作——真实 npm audit 数据下精确豁免放行、
    // 无未捕获异常、无静默吞没（非例外 advisory 会进 offenders 干红灯）。
    // 需要 registry 网络（npm audit --json + revalidate 的 npm view）；CI 有网。
    const out = execFileSync(process.execPath, [gate], { encoding: "utf8", timeout: 280000 })
    expect(out).toContain("AUDIT-GATE-PASS")
    // 例外清单处于武装态：有例外放行时门脚本逐条打印根因 URL；此处白名单须与
    // audit-gate.mjs EXCEPTIONS 逐条对应，未知例外仍干红灯（fail-closed 不变）。
    const knownExceptions = [
      "GHSA-vfj7-8cjw-p6xm", // braces（休眠：上游无 patch）
    ]
    for (const line of out.split("\n")) {
      if (line.startsWith("EXCEPT")) {
        expect(knownExceptions.some((u) => line.includes(u))).toBe(true)
      }
    }
  }, 300000)

  it("rejects the retired Zod advisory even when its chain includes braces", async () => {
    const previousExitCode = process.exitCode
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {})
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
    const zodUrl = "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5"
    const bracesUrl = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
    const report = {
      vulnerabilities: {
        braces: { severity: "high", via: [{ url: bracesUrl }] },
        zod: { severity: "high", via: ["braces", { url: zodUrl }] },
      },
    }
    vi.resetModules()
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual("node:child_process")
      return {
        ...actual,
        execSync: (command) => {
          if (command === "npm view braces version --json") return JSON.stringify("3.0.3")
          if (command === "npm audit --json") {
            throw Object.assign(new Error("fixture audit found high vulnerabilities"), {
              status: 1,
              stdout: JSON.stringify(report),
            })
          }
          throw new Error(`unexpected registry command: ${command}`)
        },
      }
    })
    try {
      await import("./audit-gate.mjs")
      expect(process.exitCode).toBe(1)
      expect(stderr.mock.calls.flat().join("\n")).toContain("AUDIT-GATE-FAIL")
      expect(stderr.mock.calls.flat().join("\n")).toContain(zodUrl)
      const exceptLines = stdout.mock.calls.flat().filter((line) => line.startsWith("EXCEPT"))
      expect(exceptLines.some((line) => line.includes(bracesUrl))).toBe(true)
      expect(exceptLines.some((line) => line.includes(zodUrl))).toBe(false)
    } finally {
      process.exitCode = previousExitCode
      vi.doUnmock("node:child_process")
      vi.resetModules()
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })
})
