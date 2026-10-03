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
    // 当前 4 条 high 全归因同一例外 advisory：放行行必须逐条列出根因 URL
    expect(out).toContain("GHSA-vfj7-8cjw-p6xm")
  }, 300000)
})
