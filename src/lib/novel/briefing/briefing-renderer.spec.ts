/** C4 冒烟覆盖：src/lib/novel/briefing/briefing-renderer.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BRIEFING_RENDERER_VERSION, memoryPatchPath, resolveAgainstCanon, renderBriefing, sortDebtsForDisplay, buildMemoryPatch } from "./briefing-renderer"
describe("briefing-renderer.ts smoke", () => {
  it("exports BRIEFING_RENDERER_VERSION", () => {
    expect(BRIEFING_RENDERER_VERSION).toBeDefined()
  })
  it("exports memoryPatchPath", () => {
    expect(memoryPatchPath).toBeDefined()
  })
  it("exports resolveAgainstCanon", () => {
    expect(resolveAgainstCanon).toBeDefined()
  })
  it("exports renderBriefing", () => {
    expect(renderBriefing).toBeDefined()
  })
  it("exports sortDebtsForDisplay", () => {
    expect(sortDebtsForDisplay).toBeDefined()
  })
  it("exports buildMemoryPatch", () => {
    expect(buildMemoryPatch).toBeDefined()
  })
})
