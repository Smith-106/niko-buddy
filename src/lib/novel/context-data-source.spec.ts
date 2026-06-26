import { describe, expect, it } from "vitest"
import { DataSourceRegistry, type DataSource, type ContextLoadContext } from "./context-data-source"

const context: ContextLoadContext = {
  projectPath: "E:/Novel",
  task: "生成大纲",
  config: {
    recentSummaryWindow: 8,
    searchTopK: 5,
    snapshotLookback: 3,
    revisionFeedbackWindowConfig: {},
  },
}

describe("DataSourceRegistry", () => {
  it("replaces undefined snapshot payloads with default values", async () => {
    const registry = new DataSourceRegistry()
    const snapshotsSource: DataSource<unknown> = {
      name: "snapshots",
      priority: 1,
      load: async () => undefined,
    }

    registry.register(snapshotsSource)
    const loaded = await registry.loadAll(context)

    expect(loaded.snapshots).toEqual({
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      foreshadowingSignals: [],
      timeline: "",
    })
  })

  it("replaces undefined scalar payloads with source defaults", async () => {
    const registry = new DataSourceRegistry()
    registry.register({
      name: "fallbackRecentSummaries",
      priority: 1,
      load: async () => undefined,
    })
    registry.register({
      name: "outline",
      priority: 2,
      load: async () => undefined,
    })

    const loaded = await registry.loadAll(context)

    expect(loaded.fallbackRecentSummaries).toEqual([])
    expect(loaded.outline).toBe("")
  })

  it("provides a default empty styleProfile payload", async () => {
    const registry = new DataSourceRegistry()
    registry.register({
      name: "styleProfile",
      priority: 1,
      load: async () => undefined,
    })

    const loaded = await registry.loadAll(context)

    expect(loaded.styleProfile).toBe("")
  })

  it("records fallback status when a datasource throws and fallback succeeds", async () => {
    const registry = new DataSourceRegistry()
    const styleProfileSource: DataSource<string> = {
      name: "styleProfile",
      priority: 19,
      load: async () => {
        throw new Error("tauri unavailable")
      },
      fallback: async () => "",
    }

    registry.register(styleProfileSource)
    const report = await registry.loadAllWithReport(context)

    expect(report.data.styleProfile).toBe("")
    expect(report.results).toEqual([
      expect.objectContaining({
        name: "styleProfile",
        priority: 19,
        status: "fallback",
      }),
    ])
  })
})
