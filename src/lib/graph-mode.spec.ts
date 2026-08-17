import { describe, expect, it } from "vitest"
import {
  GRAPH_MODE_LABELS,
  GRAPH_MODE_PRESETS,
  type GraphMode,
} from "./graph-mode"

const ALL_MODES: GraphMode[] = [
  "overview",
  "character",
  "chapter",
  "storyline",
  "foreshadowing",
]

describe("GRAPH_MODE_LABELS", () => {
  it("provides a label for every graph mode", () => {
    for (const mode of ALL_MODES) {
      expect(typeof GRAPH_MODE_LABELS[mode]).toBe("string")
      expect(GRAPH_MODE_LABELS[mode].length).toBeGreaterThan(0)
    }
  })

  it("labels the overview mode in Chinese", () => {
    expect(GRAPH_MODE_LABELS.overview).toBe("总览")
  })
})

describe("GRAPH_MODE_PRESETS", () => {
  it("provides a preset for every graph mode", () => {
    for (const mode of ALL_MODES) {
      const preset = GRAPH_MODE_PRESETS[mode]
      expect(preset.hideIsolated).toBe(true)
      expect(preset.hideStructural).toBe(true)
      expect(preset.minimumEdgeWeight).toBeGreaterThanOrEqual(1)
      expect(["all", "focused", "minimal"]).toContain(preset.labelVisibility)
      expect(preset.allowedNodeTypes instanceof Set).toBe(true)
      expect(preset.hiddenNodeTypes instanceof Set).toBe(true)
    }
  })

  it("overview hides outline/source/query nodes and requires weight >= 2", () => {
    const preset = GRAPH_MODE_PRESETS.overview
    expect(preset.allowedNodeTypes?.has("chapter")).toBe(true)
    expect(preset.hiddenNodeTypes?.has("outline")).toBe(true)
    expect(preset.minimumEdgeWeight).toBe(2)
  })

  it("character preset keeps conflict and secret visible", () => {
    const preset = GRAPH_MODE_PRESETS.character
    expect(preset.allowedNodeTypes?.has("character")).toBe(true)
    expect(preset.allowedNodeTypes?.has("conflict")).toBe(true)
    expect(preset.allowedNodeTypes?.has("secret")).toBe(true)
  })

  it("storyline hides item nodes and uses minimal labels", () => {
    const preset = GRAPH_MODE_PRESETS.storyline
    expect(preset.hiddenNodeTypes?.has("item")).toBe(true)
    expect(preset.labelVisibility).toBe("minimal")
  })

  it("foreshadowing preset keeps foreshadowing and secret nodes", () => {
    const preset = GRAPH_MODE_PRESETS.foreshadowing
    expect(preset.allowedNodeTypes?.has("foreshadowing")).toBe(true)
    expect(preset.allowedNodeTypes?.has("secret")).toBe(true)
  })
})
