/** C4 冒烟覆盖：src/lib/agent/pipeline.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import {
  filterPluginsByConfig,
  createPrePluginChain,
  type PrePlugin,
  type PrePluginInput,
} from "./pipeline"
import type { AgentConfig } from "./types"
describe("pipeline.ts smoke", () => {
  it("exports filterPluginsByConfig", () => {
    expect(filterPluginsByConfig).toBeDefined()
  })
  it("exports createPrePluginChain", () => {
    expect(createPrePluginChain).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 覆盖增补：PluginConfig 过滤（enabled/disabled 两条名单语义）与链路容错
// ─────────────────────────────────────────────────────────────────────────────

describe("pipeline.ts 覆盖增补：插件过滤与链路容错", () => {
  function plugin(name: string, priority: number): PrePlugin {
    return { name, priority, run: async () => ({}) }
  }

  const baseInput: PrePluginInput = {
    userMessage: "写第一章",
    projectPath: "/project",
    agentConfig: {} as unknown as AgentConfig,
  }

  function names(plugins: PrePlugin[]): string[] {
    return plugins.map((item) => item.name)
  }

  it("未给配置时原样返回全部插件（含顺序）", () => {
    const all = [plugin("b", 2), plugin("a", 1)]
    expect(filterPluginsByConfig(all)).toBe(all)
  })

  it("disabledPlugins 名单剔除同名插件，未列出的保留", () => {
    const all = [plugin("route", 1), plugin("trim", 2), plugin("soul", 3)]
    const kept = filterPluginsByConfig(all, { disabledPlugins: ["trim"] })
    expect(names(kept)).toEqual(["route", "soul"])
  })

  it("enabledPlugins 白名单只保留名单内插件", () => {
    const all = [plugin("route", 1), plugin("trim", 2), plugin("soul", 3)]
    const kept = filterPluginsByConfig(all, { enabledPlugins: ["soul", "route"] })
    expect(names(kept)).toEqual(["route", "soul"])
  })

  it("disabled 优先于 enabled：同时列出时被禁用的插件仍然剔除", () => {
    const all = [plugin("route", 1), plugin("trim", 2)]
    const kept = filterPluginsByConfig(all, {
      enabledPlugins: ["route", "trim"],
      disabledPlugins: ["trim"],
    })
    expect(names(kept)).toEqual(["route"])
  })

  it("空配置对象不改变插件集合", () => {
    const all = [plugin("route", 1), plugin("trim", 2)]
    expect(names(filterPluginsByConfig(all, {}))).toEqual(["route", "trim"])
  })

  it("链按 priority 升序执行，输出逐级叠加（后者覆盖前者同名字段）", async () => {
    const order: string[] = []
    const chain = createPrePluginChain([
      {
        name: "late",
        priority: 20,
        run: async () => {
          order.push("late")
          return { stopReason: "late-reason" }
        },
      },
      {
        name: "early",
        priority: 10,
        run: async () => {
          order.push("early")
          return { stopReason: "early-reason", novelSystemPrompt: "来自 early" }
        },
      },
    ])

    const result = await chain.run(baseInput)

    expect(order).toEqual(["early", "late"])
    expect(result.executedPlugins).toEqual(["early", "late"])
    expect(result.novelSystemPrompt).toBe("来自 early")
    expect(result.stopReason).toBe("late-reason")
    expect(result.errors).toEqual([])
  })

  it("单个插件抛错被收集为 errors，后续插件照常执行", async () => {
    const chain = createPrePluginChain([
      {
        name: "boom",
        priority: 1,
        run: async () => {
          throw new Error("插件内部失败")
        },
      },
      {
        name: "survivor",
        priority: 2,
        run: async () => ({ shouldStop: true, stopReason: "survivor-stop" }),
      },
    ])

    const result = await chain.run(baseInput)

    expect(result.errors).toEqual([{ pluginName: "boom", error: "插件内部失败" }])
    expect(result.executedPlugins).toEqual(["boom", "survivor"])
    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe("survivor-stop")
  })

  it("shouldStop 短路后续插件，并保留已执行清单", async () => {
    const reached: string[] = []
    const chain = createPrePluginChain([
      {
        name: "stopper",
        priority: 1,
        run: async () => {
          reached.push("stopper")
          return { shouldStop: true, stopReason: "置信度不足" }
        },
      },
      {
        name: "never",
        priority: 2,
        run: async () => {
          reached.push("never")
          return {}
        },
      },
    ])

    const result = await chain.run(baseInput)

    expect(reached).toEqual(["stopper"])
    expect(result.executedPlugins).toEqual(["stopper"])
    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe("置信度不足")
  })

  it("链路尊重 PluginConfig：被禁用插件既不执行也不进 executedPlugins", async () => {
    const run = vi.fn(async () => ({}))
    const chain = createPrePluginChain([
      { name: "route", priority: 1, run },
      { name: "trim", priority: 2, run },
    ])

    const result = await chain.run(baseInput, { disabledPlugins: ["trim"] })

    expect(run).toHaveBeenCalledTimes(1)
    expect(result.executedPlugins).toEqual(["route"])
  })
})
