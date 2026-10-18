/**
 * agent-studio-projection.spec.ts — 代理工作室设置规范化只读投影契约。
 *
 * 覆盖：
 *   1. 盘点表自身不变量（id 唯一 / 默认值成对 / 真源引用格式）；
 *   2. 投影行契约（字段恰好 6 个、行数与表一致）；
 *   3. 码点排序（含与 UTF-16 code-unit 序相反的星平面反例）；
 *   4. 三种状态判定：ok / duplicated / missing；
 *   5. 缺失真源写入 missingSources，且不吞掉该行的重复副本；
 *   6. 真实仓库探针：唯一缺失真源为 modelRoutes 视图组件（口径回归闸）；
 *   7. 纯函数性（同输入深等）与 sourceFilePath 边界。
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  AGENT_STUDIO_NOT_APPLICABLE,
  AGENT_STUDIO_SETTING_CATALOG,
  agentStudioSourcePaths,
  compareCodePoints,
  projectAgentStudioSettings,
  sourceFilePath,
  type AgentStudioSourceProbe,
} from "./agent-studio-projection"

/**
 * 仓库根：由本 spec 文件位置推导（`src/lib/novel/` → 上三级），**不用 `process.cwd()`**。
 *
 * 之前用裸相对路径 + cwd，在 `--root QMAI` 从工作区根调用时 cwd 不是 QMAI，
 * 全部路径都判为不存在，两条「真实探针」用例会假失败（审查/验收回归）。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/** 全量真源探针（本机真实文件系统，路径锚定仓库根而非 cwd）。 */
function realProbe(): AgentStudioSourceProbe {
  return {
    existingFiles: agentStudioSourcePaths().filter((path) => existsSync(resolve(REPO_ROOT, path))),
  }
}

/** 只声明指定文件存在的探针。 */
function probeOf(...paths: readonly string[]): AgentStudioSourceProbe {
  return { existingFiles: paths }
}

const REF_RE = /^src\/[A-Za-z0-9_/.@-]+\.(?:ts|tsx)(?::\d+(?:-\d+)?)?$/

describe("compareCodePoints", () => {
  it("码点序与 UTF-16 code-unit 序在星平面字符上结论相反", () => {
    const emoji = "\u{1F600}" // U+1F600 = 128512
    const bmp = "\uFFFF" // U+FFFF = 65535

    // 码点序：U+FFFF < U+1F600
    expect(compareCodePoints(bmp, emoji)).toBeLessThan(0)
    // UTF-16 code-unit 序：代理对首单元 \uD83D(55357) < \uFFFF(65535)，结论相反
    expect(bmp < emoji).toBe(false)
  })

  it("前缀更短的字符串排在前（长度兜底）", () => {
    expect(compareCodePoints("llm", "llm.model")).toBeLessThan(0)
    expect(compareCodePoints("llm.model", "llm")).toBeGreaterThan(0)
    expect(compareCodePoints("same", "same")).toBe(0)
  })
})

describe("sourceFilePath", () => {
  it("剥离冒号 + 数字行号后缀", () => {
    expect(sourceFilePath("src/stores/wiki-store.ts:112")).toBe("src/stores/wiki-store.ts")
    expect(sourceFilePath("src/stores/wiki-store.ts:112-147")).toBe("src/stores/wiki-store.ts")
  })

  it("不误伤含冒号但后缀非行号的路径", () => {
    expect(sourceFilePath("src/lib/novel/agent-studio-projection.ts")).toBe(
      "src/lib/novel/agent-studio-projection.ts",
    )
    expect(sourceFilePath("C:/repo/src/a.ts")).toBe("C:/repo/src/a.ts")
  })
})

describe("AGENT_STUDIO_SETTING_CATALOG 不变量", () => {
  it("id 唯一、label 非空、真源引用格式合法", () => {
    const ids = AGENT_STUDIO_SETTING_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(20)

    for (const entry of AGENT_STUDIO_SETTING_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0)
      expect(entry.sourceFile).toMatch(REF_RE)
      for (const ref of entry.duplicatedIn) {
        expect(ref).toMatch(REF_RE)
      }
    }
  })

  it("hasDefault 与 defaultValue 严格配对（有默认值必给字面量，无默认值必为 null）", () => {
    for (const entry of AGENT_STUDIO_SETTING_CATALOG) {
      if (entry.hasDefault) {
        expect(entry.defaultValue).not.toBeNull()
      } else {
        expect(entry.defaultValue).toBeNull()
      }
    }
  })

  it("不适用项 id 唯一且都有原因", () => {
    const ids = AGENT_STUDIO_NOT_APPLICABLE.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of AGENT_STUDIO_NOT_APPLICABLE) {
      expect(item.reason.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("projectAgentStudioSettings", () => {
  it("投影行数与盘点表一致，且每行只含契约规定的 6 个字段", () => {
    const projection = projectAgentStudioSettings(probeOf())
    expect(projection.rows).toHaveLength(AGENT_STUDIO_SETTING_CATALOG.length)

    for (const row of projection.rows) {
      expect(Object.keys(row).sort(compareCodePoints)).toEqual(
        ["duplicatedIn", "hasDefault", "id", "label", "sourceFile", "status"].sort(compareCodePoints),
      )
    }
  })

  it("rows 按 id 码点升序（与手工排序结果逐项相等）", () => {
    const projection = projectAgentStudioSettings(realProbe())
    const expected = [...projection.rows.map((row) => row.id)].sort(compareCodePoints)
    expect(projection.rows.map((row) => row.id)).toEqual(expected)
  })

  it("真源存在 + 无重复副本 → status ok", () => {
    const projection = projectAgentStudioSettings(probeOf("src/stores/wiki-store.ts"))
    const row = projection.rows.find((r) => r.id === "llm.explicitProviderSelection")
    expect(row?.status).toBe("ok")
    expect(row?.duplicatedIn).toEqual([])
  })

  it("真源存在 + 有重复副本 → status duplicated，且副本按码点排序后原样暴露", () => {
    const projection = projectAgentStudioSettings(probeOf("src/stores/wiki-store.ts"))
    const row = projection.rows.find((r) => r.id === "novel.reviewModel")

    expect(row?.status).toBe("duplicated")
    expect(row?.duplicatedIn.length).toBeGreaterThanOrEqual(3)
    expect(row?.duplicatedIn).toEqual([...row!.duplicatedIn].sort(compareCodePoints))
    expect(projection.duplicateRowIds).toContain("novel.reviewModel")
  })

  it("真源文件缺失 → status missing，并把路径写入 missingSources", () => {
    const projection = projectAgentStudioSettings(probeOf("src/stores/wiki-store.ts"))
    const row = projection.rows.find((r) => r.id === "agent.maxRounds")

    expect(row?.status).toBe("missing")
    expect(projection.missingSources).toContain("src/lib/agent/types.ts")
  })

  it("missing 行仍保留 duplicatedIn（缺失不得成为隐藏副本的借口）", () => {
    const projection = projectAgentStudioSettings(probeOf())
    const row = projection.rows.find((r) => r.id === "judge.judgePool")

    expect(row?.status).toBe("missing")
    // 码点升序：":179" 在 ":59" 之前（'1' < '5'）
    expect(row?.duplicatedIn).toEqual([
      "src/lib/llm/model-resolver.ts:179",
      "src/lib/llm/model-resolver.ts:59",
    ])
    expect(projection.duplicateRowIds).toContain("judge.judgePool")
  })

  it("missingSources 去重 + 码点升序", () => {
    const projection = projectAgentStudioSettings(probeOf())
    expect(projection.missingSources.length).toBeGreaterThan(0)
    expect(projection.missingSources).toEqual([...projection.missingSources].sort(compareCodePoints))
    expect(new Set(projection.missingSources).size).toBe(projection.missingSources.length)
  })

  it("defaultsById 只收录 hasDefault 且 defaultValue !== null 的项", () => {
    const projection = projectAgentStudioSettings(realProbe())
    expect(projection.defaultsById["llm.maxContextSize"]).toBe("204800")
    expect(projection.defaultsById["judge.judgePool"]).toBeUndefined()
    expect(projection.defaultsById["modelRoutes.view"]).toBeUndefined()

    for (const [id, value] of Object.entries(projection.defaultsById)) {
      const entry = AGENT_STUDIO_SETTING_CATALOG.find((item) => item.id === id)
      expect(entry?.hasDefault).toBe(true)
      expect(entry?.defaultValue).toBe(value)
    }
  })

  it("totals 自洽（三类之和 = total = rows.length）", () => {
    const projection = projectAgentStudioSettings(realProbe())
    const { total, ok, duplicated, missing } = projection.totals

    expect(ok + duplicated + missing).toBe(total)
    expect(total).toBe(projection.rows.length)
    expect(missing).toBe(projection.missingSources.length > 0 ? missing : 0)
    expect(projection.rows.filter((r) => r.status === "ok")).toHaveLength(ok)
    expect(projection.rows.filter((r) => r.status === "duplicated")).toHaveLength(duplicated)
    expect(projection.rows.filter((r) => r.status === "missing")).toHaveLength(missing)
  })

  it("notApplicable 按 id 码点升序且与常量表同集", () => {
    const projection = projectAgentStudioSettings(realProbe())
    expect(projection.notApplicable.map((item) => item.id)).toEqual(
      [...AGENT_STUDIO_NOT_APPLICABLE.map((item) => item.id)].sort(compareCodePoints),
    )
  })

  it("纯函数：同输入两次调用结果深等，且不修改入参", () => {
    const probe = probeOf("src/stores/wiki-store.ts")
    const before = JSON.stringify(probe)
    const first = projectAgentStudioSettings(probe)
    const second = projectAgentStudioSettings(probe)

    expect(first).toEqual(second)
    expect(JSON.stringify(probe)).toBe(before)
  })
})

describe("真实仓库探针（口径回归闸）", () => {
  it("唯一缺失真源是 modelRoutes 视图组件（该视图仍为计划态，无实现）", () => {
    const projection = projectAgentStudioSettings(realProbe())

    expect(projection.missingSources).toEqual(["src/components/novel/model-routes-view.tsx"])
    const row = projection.rows.find((r) => r.id === "modelRoutes.view")
    expect(row?.status).toBe("missing")
    // 缺失行仍暴露两处「同一声明」：计划视图登记表 + 工作台卡片。
    expect(row?.duplicatedIn).toEqual([
      "src/components/layout/planned-views.ts:36",
      "src/components/layout/workbench-view.tsx:78",
    ])
  })

  it("writingModel 已被声明移除却仍散落 5 处（漂移回归闸）", () => {
    const projection = projectAgentStudioSettings(realProbe())
    const row = projection.rows.find((r) => r.id === "novel.writingModel")

    expect(row?.status).toBe("duplicated")
    expect(row?.duplicatedIn.length).toBeGreaterThanOrEqual(5)
    expect(row?.duplicatedIn).toContain("src/lib/novel/premium-execution.ts:463")
  })

  it("llm.maxContextSize 默认值在两个真源里不一致（204800 vs 131072）", () => {
    const projection = projectAgentStudioSettings(realProbe())
    const row = projection.rows.find((r) => r.id === "llm.maxContextSize")

    expect(row?.duplicatedIn).toContain("src/lib/env-llm-defaults.ts:17")
    expect(row?.duplicatedIn).toContain("src/components/settings/sections/llm-provider-section.tsx:180")
  })
})

describe("agentStudioSourcePaths", () => {
  it("收录主真源与全部副本路径（不含行号），去重且码点升序", () => {
    const paths = agentStudioSourcePaths()
    expect(paths).toContain("src/stores/wiki-store.ts")
    expect(paths).toContain("src/lib/env-llm-defaults.ts")
    expect(paths).toContain("src/components/novel/model-routes-view.tsx")
    expect(paths.every((path) => !path.includes(":"))).toBe(true)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toEqual([...paths].sort(compareCodePoints))
  })
})
