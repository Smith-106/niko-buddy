import { describe, expect, it, vi } from "vitest"
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

  it("keeps real values untouched and substitutes null payloads with defaults too", async () => {
    const registry = new DataSourceRegistry()
    registry.register({ name: "outline", priority: 1, load: async () => "真实大纲" })
    registry.register({ name: "canonRules", priority: 2, load: async () => null })

    const loaded = await registry.loadAll(context)

    expect(loaded.outline).toBe("真实大纲")
    expect(loaded.canonRules).toBe("")
  })

  it("unknown source name falls back to null default (getDefaultValue default branch)", async () => {
    const registry = new DataSourceRegistry()
    registry.register({ name: "brandNewSource", priority: 1, load: async () => undefined })

    const loaded = await registry.loadAll(context)

    expect(loaded.brandNewSource).toBeNull()
  })

  it("records datasource_error gap and uses fallback when load throws (Error payload)", async () => {
    const recordGap = vi.fn()
    const fallback = vi.fn(async () => "降级值")
    const registry = new DataSourceRegistry()
    registry.register({
      name: "outline",
      priority: 1,
      load: async () => {
        throw new Error("加载失败")
      },
      fallback,
    })

    const loaded = await registry.loadAll({ ...context, recordGap })

    expect(loaded.outline).toBe("降级值")
    expect(fallback).toHaveBeenCalled()
    expect(recordGap).toHaveBeenCalledWith("outline", "datasource_error")
  })

  it("falls back to source default when load throws and no fallback is defined", async () => {
    const recordGap = vi.fn()
    const registry = new DataSourceRegistry()
    registry.register({
      name: "writingStyle",
      priority: 1,
      load: async () => {
        throw new Error("加载失败")
      },
    })

    const loaded = await registry.loadAll({ ...context, recordGap })

    expect(loaded.writingStyle).toBe("")
    expect(recordGap).toHaveBeenCalledWith("writingStyle", "datasource_error")
  })

  it("stringifies non-Error load failures (error instanceof Error false side)", async () => {
    const registry = new DataSourceRegistry()
    registry.register({
      name: "outline",
      priority: 1,
      load: async () => {
        throw "boom-string"
      },
    })

    const loaded = await registry.loadAll(context)

    expect(loaded.outline).toBe("")
  })

  it("swallows fallback failures and returns the default value (Error payload)", async () => {
    const registry = new DataSourceRegistry()
    registry.register({
      name: "outline",
      priority: 1,
      load: async () => {
        throw new Error("load")
      },
      fallback: async () => {
        throw new Error("fallback")
      },
    })

    const loaded = await registry.loadAll(context)

    expect(loaded.outline).toBe("")
  })

  it("swallows non-Error fallback failures and returns the default value", async () => {
    const registry = new DataSourceRegistry()
    registry.register({
      name: "outline",
      priority: 1,
      load: async () => {
        throw new Error("load")
      },
      fallback: async () => {
        throw "fallback-string"
      },
    })

    const loaded = await registry.loadAll(context)

    expect(loaded.outline).toBe("")
  })

  it("registerAll batches sources, size counts them, clear empties the registry", async () => {
    const registry = new DataSourceRegistry()
    registry.registerAll([
      { name: "outline", priority: 1, load: async () => "a" },
      { name: "canonRules", priority: 2, load: async () => "b" },
    ])
    expect(registry.size()).toBe(2)

    const loaded = await registry.loadAll(context)
    expect(loaded.outline).toBe("a")
    expect(loaded.canonRules).toBe("b")

    registry.clear()
    expect(registry.size()).toBe(0)
  })
})
