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

/**
 * s5-autotest 补测试轮：R-06 的 partially_fixed 剩余面 —— registry 的 orphan / 主链语义。
 *
 * R-06 已修的数值污染（outline-model.json 不再出现在 mainChainProjections）由既有 it 守护；
 * 本轮补的是「主链/孤岛两个集合各自的语义自洽性」与「读侧诚实性」——任何一条把
 * 治理面写反（主链投影无读者、主链消费面被标成孤岛、孤岛不给理由）都会转红。
 *
 * N-11 指出的方向反转（orphan=true 实际表达「写侧未接」而非「不喂 context」）需要新增
 * 独立维度（writerWired / lifecycle）才能机器可读地修，属产品语义选择，记入 report concerns；
 * 这里先钉住当前可保证的下界：孤岛必须带人类可读理由（note），主链必须真有读者。
 */
describe("projections-registry 主链 / 孤岛语义（R-06 剩余面）", () => {
  it("mainChain 投影不得以 consumer=internal 出现（orphan=false 与 internal 互斥）", () => {
    for (const entry of mainChainProjections()) {
      expect(entry.consumer, `${entry.file} 是主链投影却标 consumer=internal`).not.toBe("internal")
      expect(entry.orphan).toBe(false)
    }
  })

  it("mainChain 投影必须声明非空 readers（无读者的主链投影 = 治理面失真）", () => {
    for (const entry of mainChainProjections()) {
      expect(entry.readers.length, `${entry.file} 声明进主链却没有读者`).toBeGreaterThan(0)
      for (const reader of entry.readers) {
        expect(reader.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it("consumer 属主链（context-pack / graph / canon）的条目必须 orphan=false 且在 mainChainProjections 中", () => {
    const mainFiles = new Set(mainChainProjections().map((entry) => entry.file))
    for (const entry of PROJECTIONS_REGISTRY) {
      if (entry.consumer === "context-pack" || entry.consumer === "graph" || entry.consumer === "canon") {
        expect(entry.orphan, `${entry.file} 被主链消费却标成孤岛`).toBe(false)
        expect(mainFiles.has(entry.file)).toBe(true)
      }
    }
  })

  it("orphan 条目必须带人类可读 note（孤岛理由的唯一真值载体，N-11）", () => {
    for (const entry of orphanProjections()) {
      expect(entry.note, `${entry.file} 标了孤岛却没写理由`).toBeTruthy()
      expect(entry.note!.trim().length, `${entry.file} 的孤岛理由过短`).toBeGreaterThan(4)
    }
  })

  it("mainChainProjections() / orphanProjections() 返回快照：外部改写不污染注册表", () => {
    const total = PROJECTIONS_REGISTRY.length
    const mainSnapshot = mainChainProjections()
    const orphanSnapshot = orphanProjections()
    mainSnapshot.push(orphanSnapshot[0])
    orphanSnapshot.length = 0

    expect(PROJECTIONS_REGISTRY.length).toBe(total)
    expect(mainChainProjections().length).toBe(total - orphanProjections().length)
  })

  it("注册表 file 唯一：同一投影不得重复登记（重复会让主链/孤岛统计翻倍）", () => {
    const files = PROJECTIONS_REGISTRY.map((entry) => entry.file)
    expect(new Set(files).size).toBe(files.length)
  })

  it("读侧诚实性：outline-model.json 声明 readers 含 context-engine，且该读调用点真实存在", () => {
    const entry = PROJECTIONS_REGISTRY.find((candidate) => candidate.file === "outline-model.json")!
    expect(entry.readers).toContain("context-engine")

    const readerCallSites = productionCallSites("loadOutlineModel")
    expect(readerCallSites.length, "registry 声明读侧已接，但没有任何生产调用点").toBeGreaterThan(0)
    // 路径分隔符随平台不同（Windows 反斜杠），按文件名判定而非前缀判定。
    expect(readerCallSites.some((site) => /context-engine\.ts:\d+$/.test(site))).toBe(true)
  })
})
