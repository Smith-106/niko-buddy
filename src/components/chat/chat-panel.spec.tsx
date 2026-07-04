import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("chat panel deep chapter failure recovery", () => {
  it("synthesizes a fallback novel session id before pause writeback when startup fails early", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("createNovelSessionId")
    expect(source).toContain("sessionDebug.syntheticSessionId = novelSessionId")
    expect(source).toContain("continueSessionDebug.syntheticSessionId = novelSessionId")
  })
})
