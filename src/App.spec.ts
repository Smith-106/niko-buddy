import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("App startup update flow", () => {
  it("uses silent mode for startup update checks so launch is not blocked by a modal", () => {
    const source = readFileSync(resolve(__dirname, "lib", "composition-root.ts"), "utf8")

    expect(source).toContain('checkForAppUpdate({ mode: "silent" })')
  })

  it("rehydrates interrupted deep chapter sessions into startup chat state", () => {
    const source = readFileSync(resolve(__dirname, "lib", "composition-root.ts"), "utf8")

    expect(source).toContain("loadNovelSessionStatus")
    expect(source).toContain("hydrateChatHistoryWithInterruptedDeepChapter")
    expect(source).toContain("focusConversationId")
    expect(source).toContain("setChatExpanded(true)")
  })
})
