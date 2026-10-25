// ISS-20260709-050: 全项目 51 LLM 文件 console.error 脱敏 sweep（错误对象只记名与 message，禁原文/密钥外泄）。
// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

describe("ISS-20260709-050 LLM console.error 脱敏", () => {
  it("event-pool-generator：LLM 失败记名+message，不透出原始对象", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { readFile } = await import("node:fs/promises")
      const text = await readFile("src/lib/novel/story-simulation/event-pool-generator.ts", "utf8")
      // 修复后不得再出现裸 `console.error(..., streamError)` / `..., err)` 透出
      expect(text).not.toMatch(/console\.error\([^)]*,\s*streamError\s*\)/)
      expect(text).not.toMatch(/console\.error\(\"[^\"]*解析或调用失败[^\"]*\",\s*err\s*\)/)
      // 必须含脱敏口径（name + message / toErrorMessage）
      expect(text).toMatch(/streamErrorNow\.name/)
      expect(text).toContain("toErrorMessage")
    } finally {
      errSpy.mockRestore()
    }
  })

  it("simulation-engine：致命错误只记名与 message", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile("src/lib/novel/story-simulation/simulation-engine.ts", "utf8")
    expect(text).not.toMatch(/console\.error\(\"\[simulation\] 仿真引擎致命错误[^\"]*\",\s*error\s*\)/)
    expect(text).toContain("ISS-20260709-050")
  })

  it("ingest/lint：控制台记 safe（redacted），不记 raw（含 URL/密钥）", async () => {
    const { readFile } = await import("node:fs/promises")
    const ingest = await readFile("src/lib/ingest.ts", "utf8")
    expect(ingest).not.toMatch(/console\.error\(\"\[ingest\] analysis stream error:\", raw\)/)
    expect(ingest).not.toMatch(/console\.error\(\"\[ingest\] generation stream error:\", raw\)/)
    expect(ingest).toContain("ISS-20260709-050")
    const lint = await readFile("src/lib/lint.ts", "utf8")
    expect(lint).not.toMatch(/console\.error\(\"\[Novel Lint\] LLM stream error:\", raw\)/)
  })

  it("projection/novel-session 保全路径：console.error 已收敛为 logger（脱敏）", async () => {
    const { readFile } = await import("node:fs/promises")
    const ledger = await readFile("src/lib/novel/projection-status-ledger.ts", "utf8")
    // 保全失败路径不再裸 console.error(..., preserveErr)
    expect(ledger).not.toMatch(/console\.error\(\s*\"\[projection-status-ledger\] failed to preserve[^\"]*\",\s*preserveErr/)
    const session = await readFile("src/lib/novel/novel-session-status.ts", "utf8")
    expect(session).not.toMatch(/console\.error\(\s*`\[novel-session-status\] FAILED[^\"]*`\s*,/)
  })

  it("行为等价：脱敏仅收敛日志内容，不改控制流（空池/抛错语义不变）", async () => {
    // event-pool 在 LLM 失败时仍返回空池（非抛错），simulation 仍经 onError 透传
    const { readFile } = await import("node:fs/promises")
    const gen = await readFile("src/lib/novel/story-simulation/event-pool-generator.ts", "utf8")
    expect(gen).toContain("return createEmptyStagedPool()")
    const sim = await readFile("src/lib/novel/story-simulation/simulation-engine.ts", "utf8")
    expect(sim).toContain("callbacks.onError(error)")
  })
})
