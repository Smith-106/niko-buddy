/**
 * Compliance & legacy-migration spec for src/lib/antigravity-cli-transport.ts.
 */
import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  ANTIGRAVITY_CLI_RETIRED_ERROR,
  buildPrompt,
  extractAntigravityCliError,
  parseAntigravityCliLine,
  streamAntigravityCli,
} from "./antigravity-cli-transport"

describe("antigravity-cli-transport (retired compliance fail-closed)", () => {
  it("fails closed immediately with Google ToS migration guidance without spawning any subprocess", async () => {
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    const cfg: LlmConfig = {
      provider: "antigravity-cli",
      apiKey: "",
      model: "gemini-3-pro",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 200000,
    }

    await streamAntigravityCli(cfg, [{ role: "user", content: "hello" }], {
      onToken,
      onDone,
      onError,
    })

    expect(onToken).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0]?.[0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(ANTIGRAVITY_CLI_RETIRED_ERROR)
    expect(err.message).toContain("ACP")
    expect(err.message).toContain("MCP")
  })

  it("keeps pure helper functions intact for backward compatibility", () => {
    expect(parseAntigravityCliLine("")).toBeNull()
    expect(parseAntigravityCliLine("not-json")).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ text: "ok" }))).toBe("ok")
    expect(extractAntigravityCliError(JSON.stringify({ type: "error", message: "boom" }))).toBe("boom")
    expect(buildPrompt([{ role: "user", content: "hi" }])).toContain("<USER>")
  })
})
