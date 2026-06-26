import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("chat panel persisted status regression", () => {
  it("uses optional status reads and clears explanation when no real draft exists", () => {
    const source = readFileSync(resolve(__dirname, "chat-panel.tsx"), "utf8")

    expect(source).toContain("loadOptionalStatusSchema")
    expect(source).toContain("if (!draft)")
    expect(source).toContain("setActiveSessionExplanation(null)")
    expect(source).not.toContain("loadOrCreateStatusSchema(projectPath)")
  })
})
