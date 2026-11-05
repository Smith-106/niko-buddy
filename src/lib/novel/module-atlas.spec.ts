import { describe, expect, it } from "vitest"
import {
  MODULE_ATLAS,
  buildAtlasIndex,
  moduleEdges,
  moduleLabel,
  moduleStageLabel,
  type ModuleAtlas,
} from "./module-atlas"

function miniAtlas(): ModuleAtlas {
  return {
    schemaVersion: 1,
    generator: "test",
    stages: [
      { id: "a", label: "首泳道" },
      { id: "b", label: "次泳道" },
    ],
    stats: {},
    modules: [
      { p: "src/a.ts", s: 0, l: 10, r: true, o: false, x: false, i: [1, 2] },
      { p: "src/b.ts", s: 1, l: 20, r: false, o: true, x: false, i: [] },
      { p: "src/c.ts", s: 9, l: 5, r: false, o: false, x: true, i: [99] },
    ],
  }
}

describe("MODULE_ATLAS 生成物", () => {
  it("结构完整：版本号/生成器/泳道/模块非空且条目含路径", () => {
    expect(MODULE_ATLAS.schemaVersion).toBe(1)
    expect(MODULE_ATLAS.generator).toContain("gen-module-atlas")
    expect(MODULE_ATLAS.stages.length).toBeGreaterThan(0)
    expect(MODULE_ATLAS.modules.length).toBeGreaterThan(0)
    for (const m of MODULE_ATLAS.modules.slice(0, 20)) {
      expect(typeof m.p).toBe("string")
      expect(m.p.length).toBeGreaterThan(0)
    }
  })
})

describe("buildAtlasIndex", () => {
  it("路径 → 记录一一映射", () => {
    const atlas = miniAtlas()
    const index = buildAtlasIndex(atlas)
    expect(index.get("src/a.ts")).toBe(atlas.modules[0])
    expect(index.size).toBe(3)
  })

  it("缺省用全量 MODULE_ATLAS（含本文件自身条目）", () => {
    const index = buildAtlasIndex()
    const entry = index.get("src/lib/novel/module-atlas.ts")
    expect(entry).toBeDefined()
    expect(entry!.p).toBe("src/lib/novel/module-atlas.ts")
  })
})

describe("moduleLabel", () => {
  it("去掉目录与扩展名", () => {
    expect(moduleLabel("src/lib/novel/module-atlas.ts")).toBe("module-atlas")
    expect(moduleLabel("src/a.tsx")).toBe("a")
  })

  it("兼容 Windows 反斜杠与 .mts/.json 后缀", () => {
    expect(moduleLabel("src\\lib\\x.mts")).toBe("x")
    expect(moduleLabel("data/atlas.generated.json")).toBe("atlas.generated")
  })

  it("无目录路径直接去后缀", () => {
    expect(moduleLabel("lonely.ts")).toBe("lonely")
  })
})

describe("moduleStageLabel", () => {
  it("命中条目返回泳道标签", () => {
    expect(moduleStageLabel("src/a.ts", miniAtlas())).toBe("首泳道")
    expect(moduleStageLabel("src/b.ts", miniAtlas())).toBe("次泳道")
  })

  it("未收录路径返回 未收录", () => {
    expect(moduleStageLabel("src/missing.ts", miniAtlas())).toBe("未收录")
  })

  it("泳道序号越界返回 其它", () => {
    // src/c.ts s=9 超出 stages 长度
    expect(moduleStageLabel("src/c.ts", miniAtlas())).toBe("其它")
  })
})

describe("moduleEdges", () => {
  it("出边序号解析为路径", () => {
    expect(moduleEdges("src/a.ts", miniAtlas())).toEqual(["src/b.ts", "src/c.ts"])
  })

  it("无出边返回空数组", () => {
    expect(moduleEdges("src/b.ts", miniAtlas())).toEqual([])
  })

  it("未收录路径返回空数组", () => {
    expect(moduleEdges("src/missing.ts", miniAtlas())).toEqual([])
  })

  it("越界出边序号被过滤（非字符串丢弃）", () => {
    // src/c.ts i=[99] 超出 modules 长度 → modules[99] 为 undefined
    expect(moduleEdges("src/c.ts", miniAtlas())).toEqual([])
  })
})
