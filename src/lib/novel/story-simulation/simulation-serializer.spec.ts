/** C4 冒烟覆盖：src/lib/novel/story-simulation/simulation-serializer.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { serializeSimulationState, deserializeSimulationSnapshot } from "./simulation-serializer"
describe("simulation-serializer.ts smoke", () => {
  it("exports serializeSimulationState", () => {
    expect(serializeSimulationState).toBeDefined()
  })
  it("exports deserializeSimulationSnapshot", () => {
    expect(deserializeSimulationSnapshot).toBeDefined()
  })
})
