import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  PROJECTIONS_REGISTRY,
  mainChainProjections,
  orphanProjections,
} from "./projections-registry"

const SRC_ROOT = resolve(__dirname, "../..")

/** 递归收集生产源码（跳过 spec/test、barrel 与隐藏目录）。 */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      collectSources(full, acc)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(spec|test)\.tsx?$/.test(entry.name)) continue
    if (/^index\.tsx?$/.test(entry.name)) continue
    acc.push(full)
  }
  return acc
}

/**
 * 生产调用点（R-06）：跳过定义行、注释行与 barrel re-export。
 * 判据只看「非 spec 源码里出现 `symbol(`」，因为 spec 与 barrel 都不能算生产者。
 */
function productionCallSites(symbol: string): string[] {
  const needle = `${symbol}(`
  const hits: string[] = []
  for (const file of collectSources(SRC_ROOT)) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/)
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed.includes(needle)) return
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
      if (trimmed.includes(`function ${symbol}`)) return
      if (trimmed.startsWith("export {")) return
      hits.push(`${file.slice(SRC_ROOT.length + 1)}:${index + 1}`)
    })
  }
  return hits
}

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

  it("outline-model.json 登记为声明的孤岛（写侧未接）（R-06）", () => {
    const entry = PROJECTIONS_REGISTRY.find((e) => e.file === "outline-model.json")
    expect(entry).toBeDefined()
    expect(entry!.orphan).toBe(true)
    expect(entry!.consumer).toBe("internal")
    expect(entry!.readers).toContain("context-engine")
    expect(entry!.writer).toBe("outline-model-store")
  })

  it("registry 诚实性：outline-model.json 的 orphan/consumer 必须与写侧生产者一致（R-06）", () => {
    const entry = PROJECTIONS_REGISTRY.find((e) => e.file === "outline-model.json")!
    const producers = productionCallSites("saveOutlineModel")
    if (producers.length === 0) {
      // 写侧零生产者 ⇒ 必须是「声明的合法孤岛」，且不得出现在主链集合里。
      expect(entry.orphan).toBe(true)
      expect(entry.consumer).toBe("internal")
      expect(entry.note).toContain("读侧已接")
      expect(entry.note).toContain("写侧未接")
      expect(mainChainProjections().map((e) => e.file)).not.toContain("outline-model.json")
    } else {
      // 反向分支：一旦出现生产调用点，registry 必须同步改回主链投影。
      expect(entry.orphan, producers.join("\n")).toBe(false)
      expect(entry.consumer, producers.join("\n")).toBe("context-pack")
    }
  })
})
