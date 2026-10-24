import { describe, expect, it } from "vitest"
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
      "GHSA-mrhx-c7xc-m3w5", // zod v3 无 patch，v4 迁移前接受（复查：zod 离开 v3 即过期）
    ]
    for (const line of out.split("\n")) {
      if (line.startsWith("EXCEPT")) {
        expect(knownExceptions.some((u) => line.includes(u))).toBe(true)
      }
    }
  }, 300000)
})
