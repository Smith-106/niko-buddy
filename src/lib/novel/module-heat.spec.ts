import { afterEach, describe, expect, it, vi } from "vitest"
import {
  aggregateHeat,
  appendHit,
  heatTotals,
  listUnwiredModules,
  normalizeHeatLevel,
  recordModuleHit,
  setModuleHeatSink,
  stageCoverage,
  toHeatLog,
  withModuleHeat,
  type ModuleHit,
} from "./module-heat"
import type { ModuleAtlas, ModuleAtlasEntry } from "./module-atlas"

function hit(path: string, at: number, patch: Partial<ModuleHit> = {}): ModuleHit {
  return { path, at, ok: true, ...patch }
}

function entry(patch: Partial<ModuleAtlasEntry> & { p: string }): ModuleAtlasEntry {
  return { s: 0, l: 10, r: true, o: false, x: false, i: [], ...patch }
}

function atlasOf(modules: ModuleAtlasEntry[]): ModuleAtlas {
  return {
    schemaVersion: 1,
    generator: "test",
    stages: [
      { id: "draft", label: "正文起草" },
      { id: "gate", label: "门控与评分" },
    ],
    stats: {},
    modules,
  }
}

afterEach(() => {
  setModuleHeatSink(null)
})

describe("appendHit 环形窗口", () => {
  it("超过容量时丢最旧的一条", () => {
    const hits = [hit("a", 1), hit("b", 2)]
    const next = appendHit(hits, hit("c", 3), 2)
    expect(next.map((h) => h.path)).toEqual(["b", "c"])
    expect(hits).toHaveLength(2) // 不就地修改入参
  })
})

describe("aggregateHeat", () => {
  it("按模块聚合次数/最近时刻/错误数/总耗时", () => {
    const heat = aggregateHeat([
      hit("m", 100, { ms: 10 }),
      hit("m", 300, { ms: 30, detail: "第3章" }),
      hit("m", 200, { ok: false }),
      hit("n", 400),
    ])
    expect(heat.get("m")).toMatchObject({ count: 3, lastAt: 300, errors: 1, totalMs: 40 })
    expect(heat.get("m")?.lastDetail).toBe("第3章")
    expect(heat.get("n")).toMatchObject({ count: 1, errors: 0 })
  })
})

describe("normalizeHeatLevel", () => {
  it("对数归一且在 0..1 之间单调", () => {
    expect(normalizeHeatLevel(0, 10)).toBe(0)
    expect(normalizeHeatLevel(10, 10)).toBe(1)
    const low = normalizeHeatLevel(1, 100)
    const high = normalizeHeatLevel(50, 100)
    expect(low).toBeGreaterThan(0)
    expect(high).toBeGreaterThan(low)
    expect(normalizeHeatLevel(5, 0)).toBe(0)
  })
})

describe("toHeatLog", () => {
  it("新→旧输出并限制行数", () => {
    const rows = toHeatLog([hit("a", 1), hit("b", 2), hit("c", 3)], (p) => p.toUpperCase(), 2)
    expect(rows.map((r) => r.label)).toEqual(["C", "B"])
    expect(rows[0].at).toBe(3)
  })
})

describe("listUnwiredModules", () => {
  it("按 specOnly / orphan / unreachable 分类并按体量降序", () => {
    const atlas = atlasOf([
      entry({ p: "wired.ts" }),
      entry({ p: "spec-only.ts", x: true, l: 100 }),
      entry({ p: "orphan.ts", o: true, l: 50 }),
      entry({ p: "unreachable.ts", r: false, l: 10 }),
    ])
    const rows = listUnwiredModules(atlas)
    expect(rows.map((r) => r.path)).toEqual(["spec-only.ts", "orphan.ts", "unreachable.ts"])
    expect(rows.map((r) => r.reason)).toEqual(["specOnly", "orphan", "unreachable"])
    expect(rows[0].stage).toBe("正文起草")
  })

  it("已接线模块不入清单", () => {
    expect(listUnwiredModules(atlasOf([entry({ p: "wired.ts" })]))).toEqual([])
  })
})

describe("stageCoverage / heatTotals", () => {
  const atlas = atlasOf([
    entry({ p: "a.ts", s: 0, l: 1 }),
    entry({ p: "b.ts", s: 0, l: 1, x: true }),
    entry({ p: "c.ts", s: 1, l: 1 }),
  ])
  const heat = aggregateHeat([hit("a.ts", 1), hit("a.ts", 2), hit("c.ts", 3)])

  it("按泳道统计模块数/命中数/调用次数/未接线数", () => {
    const rows = stageCoverage(atlas, heat)
    expect(rows[0]).toMatchObject({ stageId: "draft", modules: 2, hitModules: 1, calls: 2, unwired: 1 })
    expect(rows[1]).toMatchObject({ stageId: "gate", modules: 1, hitModules: 1, calls: 1, unwired: 0 })
  })

  it("统计条只计地图内模块", () => {
    const totals = heatTotals(atlas, aggregateHeat([...heat.values()].length ? [hit("a.ts", 1), hit("zzz.ts", 1)] : []))
    expect(totals).toMatchObject({ modules: 3, wired: 2, unwired: 1, calledModules: 1, totalCalls: 1, errors: 0 })
  })
})

describe("recordModuleHit / sink", () => {
  it("未安装 sink 时静默丢弃", () => {
    expect(() => recordModuleHit(hit("a", 1))).not.toThrow()
  })

  it("安装 sink 后转发命中", () => {
    const seen: ModuleHit[] = []
    setModuleHeatSink((h) => seen.push(h))
    recordModuleHit(hit("a", 1, { detail: "x" }))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: "a", detail: "x" })
  })

  it("sink 抛错不影响调用方", () => {
    setModuleHeatSink(() => {
      throw new Error("boom")
    })
    expect(() => recordModuleHit(hit("a", 1))).not.toThrow()
  })
})

describe("withModuleHeat", () => {
  it("记录成功与耗时", async () => {
    const seen: ModuleHit[] = []
    setModuleHeatSink((h) => seen.push(h))
    let now = 1000
    const value = await withModuleHeat("m.ts", async () => "ok", { now: () => now, detail: "起草" })
    now = 1250
    expect(value).toBe("ok")
    expect(seen[0]).toMatchObject({ path: "m.ts", at: 1000, ok: true, detail: "起草" })
  })

  it("失败时记录 ok=false 并透传异常", async () => {
    const seen: ModuleHit[] = []
    setModuleHeatSink((h) => seen.push(h))
    await expect(
      withModuleHeat("m.ts", async () => {
        throw new Error("bad")
      }, { now: () => 5 }),
    ).rejects.toThrow("bad")
    expect(seen[0]).toMatchObject({ path: "m.ts", ok: false })
    expect(seen[0].detail).toContain("bad")
  })

  it("isOk 可把业务失败记为失败", async () => {
    const seen: ModuleHit[] = []
    setModuleHeatSink((h) => seen.push(h))
    await withModuleHeat("m.ts", async () => ({ passed: false }), {
      now: () => 1,
      isOk: (v: { passed: boolean }) => v.passed,
    })
    expect(seen[0].ok).toBe(false)
  })
})

describe("真实生成物", () => {
  it("module-atlas.generated.json 可被纯函数层消费", async () => {
    vi.resetModules()
    const { MODULE_ATLAS } = await import("./module-atlas")
    expect(MODULE_ATLAS.modules.length).toBeGreaterThan(500)
    const rows = listUnwiredModules(MODULE_ATLAS)
    expect(rows.length).toBeGreaterThan(0)
    const totals = heatTotals(MODULE_ATLAS, aggregateHeat([]))
    expect(totals.modules).toBe(MODULE_ATLAS.modules.length)
    expect(totals.calledModules).toBe(0)
  })
})
