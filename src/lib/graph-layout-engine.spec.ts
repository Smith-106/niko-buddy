/** C4 冒烟覆盖：src/lib/graph-layout-engine.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { computeForceAtlas2Positions } from "./graph-layout-engine"
import { GRAPH_LAYOUT_ITERATIONS, GRAPH_LAYOUT_SETTINGS } from "./graph-layout"
describe("graph-layout-engine.ts smoke", () => {
  it("exports computeForceAtlas2Positions", () => {
    expect(computeForceAtlas2Positions).toBeDefined()
  })

  it("聚类开关随 settings 透传：小星图产出全部有限坐标", () => {
    const positions = computeForceAtlas2Positions({
      nodes: [
        { id: "hub", x: 0, y: 0, size: 6 },
        { id: "a", x: 10, y: 0, size: 6 },
        { id: "b", x: 0, y: 10, size: 6 },
      ],
      edges: [
        { source: "hub", target: "a", weight: 5 },
        { source: "hub", target: "b", weight: 1 },
      ],
      iterations: GRAPH_LAYOUT_ITERATIONS,
      settings: GRAPH_LAYOUT_SETTINGS,
      barnesHutOptimize: false,
    })
    for (const id of ["hub", "a", "b"]) {
      expect(positions[id]).toBeDefined()
      expect(Number.isFinite(positions[id].x)).toBe(true)
      expect(Number.isFinite(positions[id].y)).toBe(true)
    }
  })
})
