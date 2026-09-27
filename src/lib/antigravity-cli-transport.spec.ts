/** C4 冒烟覆盖：src/lib/antigravity-cli-transport.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { parseAntigravityCliLine, extractAntigravityCliError, buildPrompt, streamAntigravityCli } from "./antigravity-cli-transport"
describe("antigravity-cli-transport.ts smoke", () => {
  it("exports parseAntigravityCliLine", () => {
    expect(parseAntigravityCliLine).toBeDefined()
  })
  it("exports extractAntigravityCliError", () => {
    expect(extractAntigravityCliError).toBeDefined()
  })
  it("exports buildPrompt", () => {
    expect(buildPrompt).toBeDefined()
  })
  it("exports streamAntigravityCli", () => {
    expect(streamAntigravityCli).toBeDefined()
  })
})
