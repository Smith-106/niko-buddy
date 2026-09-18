import { describe, expect, it } from "vitest"
import {
  PROJECTIONS_REGISTRY,
  mainChainProjections,
  orphanProjections,
} from "./projections-registry"

describe("projections-registry（MIG-002 .novel 投影治理目录）", () => {
  it("注册表非空且每条目字段完整", () => {
    expect(PROJECTIONS_REGISTRY.length).toBeGreaterThan(10)
    for (const e of PROJECTIONS_REGISTRY) {
      expect(e.file).toBeTruthy()
      expect(e.writer).toBeTruthy()
      expect(["context-pack", "graph", "ui-panel", "orchestrator", "canon", "internal"]).toContain(
        e.consumer,
      )
      expect(typeof e.orphan).toBe("boolean")
    }
  })

  it("主链投影：world-blueprint 已接线进 context-pack（MIG-002 落地）", () => {
    const bp = PROJECTIONS_REGISTRY.find((e) => e.file === "world-blueprint.json")
    expect(bp).toBeDefined()
    expect(bp!.consumer).toBe("context-pack")
    expect(bp!.orphan).toBe(false)
  })

  it("孤儿投影：internal 状态显式声明（MIG-003 后 literary-gold/scenes/narrative-state 均接线）", () => {
    const orphans = orphanProjections().map((e) => e.file)
    // MIG-003：literary-gold/scenes/narrative-state 均已有真实消费方——非孤岛
    expect(orphans).not.toContain("literary-gold-anchors.json")
    expect(orphans).not.toContain("scenes.json")
    expect(orphans).not.toContain("narrative-state.json")
    // 孤儿必须 consumer=internal（设计而非缺陷）
    for (const e of orphanProjections()) {
      expect(e.consumer).toBe("internal")
    }
  })

  it("literary-gold/scenes 标记已有消费方（评审/管线链）", () => {
    const gold = PROJECTIONS_REGISTRY.find((e) => e.file === "literary-gold-anchors.json")
    expect(gold!.readers).toContain("dimension-review-adapter")
    expect(gold!.orphan).toBe(false)
    const scenes = PROJECTIONS_REGISTRY.find((e) => e.file === "scenes.json")
    expect(scenes!.readers).toContain("deep-chapter-generation")
    expect(scenes!.orphan).toBe(false)
  })

  it("主链/孤儿集合互补且不重叠", () => {
    const main = new Set(mainChainProjections().map((e) => e.file))
    const orph = new Set(orphanProjections().map((e) => e.file))
    expect(main.size + orph.size).toBe(PROJECTIONS_REGISTRY.length)
    for (const f of orph) expect(main.has(f)).toBe(false)
  })
})
