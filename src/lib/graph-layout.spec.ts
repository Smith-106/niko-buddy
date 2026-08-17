import { describe, expect, it } from "vitest"
import {
  getGraphVisualSettings,
  GRAPH_LAYOUT_ITERATIONS,
  GRAPH_LAYOUT_SETTINGS,
  GRAPH_VISUAL_SETTINGS,
} from "./graph-layout"

describe("graph-layout constants", () => {
  it("exports the visual settings", () => {
    expect(GRAPH_VISUAL_SETTINGS).toEqual({
      baseNodeSize: 6,
      maxNodeSize: 20,
      minEdgeSize: 0.35,
      maxEdgeSize: 2,
      minEdgeAlpha: 0.12,
      maxEdgeAlpha: 0.42,
    })
  })

  it("exports the layout settings", () => {
    expect(GRAPH_LAYOUT_SETTINGS).toEqual({
      gravity: 0.2,
      scalingRatio: 4.6,
      slowDown: 2.2,
      adjustSizes: true,
      strongGravityMode: false,
    })
    expect(GRAPH_LAYOUT_ITERATIONS).toBe(220)
  })
})

describe("getGraphVisualSettings", () => {
  it("applies the large-graph tier at 500+ nodes", () => {
    const s = getGraphVisualSettings(500)
    expect(s.baseNodeSize).toBe(4)
    expect(s.maxNodeSize).toBe(14)
    expect(s.minEdgeSize).toBe(0.2)
    expect(s.maxEdgeSize).toBe(1.2)
    expect(s.minEdgeAlpha).toBe(0.06)
    expect(s.maxEdgeAlpha).toBe(0.25)
  })

  it("applies the large-graph tier well above the threshold", () => {
    expect(getGraphVisualSettings(5000).baseNodeSize).toBe(4)
  })

  it("applies the medium tier at 100-499 nodes", () => {
    const s = getGraphVisualSettings(100)
    expect(s.baseNodeSize).toBe(5)
    expect(s.maxNodeSize).toBe(17)
    expect(s.minEdgeSize).toBe(0.28)
    expect(s.maxEdgeSize).toBe(1.6)
    expect(s.minEdgeAlpha).toBe(0.09)
    expect(s.maxEdgeAlpha).toBe(0.34)
  })

  it("applies the medium tier at the upper boundary", () => {
    expect(getGraphVisualSettings(499).baseNodeSize).toBe(5)
  })

  it("falls back to defaults below 100 nodes", () => {
    const s = getGraphVisualSettings(99)
    expect(s).toEqual({ ...GRAPH_VISUAL_SETTINGS })
  })

  it("falls back to defaults for zero nodes", () => {
    expect(getGraphVisualSettings(0)).toEqual({ ...GRAPH_VISUAL_SETTINGS })
  })
})
