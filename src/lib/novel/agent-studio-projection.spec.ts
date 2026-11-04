/**
 * agent-studio-projection.spec.ts — 代理工作室设置规范化只读投影契约。
 *
 * 覆盖：
 *   1. 盘点表自身不变量（id 唯一 / 默认值成对 / 真源引用格式）；
 *   2. 投影行契约（字段恰好 6 个、行数与表一致）；
 *   3. 码点排序（含与 UTF-16 code-unit 序相反的星平面反例）；
 *   4. 三种状态判定：ok / duplicated / missing；
 *   5. 缺失真源写入 missingSources，且不吞掉该行的重复副本；
 *   6. 真实仓库探针：modelRoutes 视图已毕业，真源存在，行状态为 duplicated（三处接线声明并存）；
 *   6b. 反向漂移闸：`writingModel` 已从非 spec 源码的**代码面**消失（仅允许留在注释/字符串/迁移逻辑里），
 *      且盘点表里已无 `novel.writingModel` 投影行；
 *   7. 纯函数性（同输入深等）与 sourceFilePath 边界。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
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

/** 递归收集 `src/` 下的全部 ts/tsx（含 spec，调用方自行过滤），返回仓库相对 POSIX 路径。 */
function collectSourceFiles(): string[] {
  const out: string[] = []
  const walk = (relDir: string) => {
    for (const entry of readdirSync(resolve(REPO_ROOT, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(rel)
        continue
      }
      if (/\.tsx?$/.test(entry.name)) out.push(rel)
    }
  }
  walk("src")
  return out.sort(compareCodePoints)
}

function isSpecPath(rel: string): boolean {
  return rel.endsWith(".spec.ts") || rel.endsWith(".spec.tsx")
}

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8")
}

/**
 * 代码面视图：去掉**注释**与**字符串/模板字面量内容**，只留真正参与语义的标识符与类型位。
 *
 * 用来区分三种提及 `writingModel` 的方式：
 *   - 注释（解释删除）→ 不算，丢弃；
 *   - 字符串/模板字面量（changelog 历史文本、迁移日志的旧键名）→ 不算，丢弃；
 *   - 标识符 / 类型位（`writingModel: string`、`writer: "writingModel"` 外的映射、
 *     `{ writingModel }` 透传、`provider: cfg.writingModel`、`as { writingModel?: X }`）
 *     → **算**，必须保留并被断言抓到。
 *
 * 逐字符扫描，用栈维护「代码 / 模板字面量」两种帧：模板里的 `${...}` 回到代码帧
 * （按大括号深度匹配），所以 `${cfg.writingModel}` 这种插值不会被误当文本丢弃。
 */
function codeSurface(source: string): string {
  type Frame = { kind: "code"; braceDepth: number } | { kind: "tpl" }
  const stack: Frame[] = [{ kind: "code", braceDepth: 0 }]
  let out = ""
  let i = 0
  while (i < source.length) {
    const frame = stack[stack.length - 1]
    const c = source[i]
    const next = source[i + 1] ?? ""

    if (frame.kind === "code") {
      if (c === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1
        continue
      }
      if (c === "/" && next === "*") {
        i += 2
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") out += "\n"
          i += 1
        }
        i += 2
        continue
      }
      if (c === "'" || c === '"') {
        i += 1
        out += '""'
        while (i < source.length && source[i] !== c) {
          if (source[i] === "\\") i += 1
          i += 1
        }
        i += 1
        continue
      }
      if (c === "`") {
        stack.push({ kind: "tpl" })
        i += 1
        continue
      }
      if (c === "{") {
        frame.braceDepth += 1
        out += c
        i += 1
        continue
      }
      if (c === "}") {
        if (frame.braceDepth === 0 && stack.length > 1) {
          stack.pop() // 结束 ${...} 插值，回到模板帧
          i += 1
          continue
        }
        frame.braceDepth -= 1
        out += c
        i += 1
        continue
      }
      out += c
      i += 1
      continue
    }

    // 模板字面量的文本部分：丢弃文本，只保留 ${...} 里的代码
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "`") {
      stack.pop()
      i += 1
      continue
    }
    if (c === "$" && next === "{") {
      stack.push({ kind: "code", braceDepth: 0 })
      i += 2
      continue
    }
    if (c === "\n") out += "\n"
    i += 1
  }
  return out
}

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
    expect(projection.defaultsById["llm.maxContextSize"]).toBe("32768")
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
  it("modelRoutes 视图已毕业：真源存在，行状态为 duplicated（三处接线声明并存）", () => {
    const projection = projectAgentStudioSettings(realProbe())

    expect(projection.missingSources).not.toContain("src/components/novel/model-routes-view.tsx")
    const row = projection.rows.find((r) => r.id === "modelRoutes.view")
    expect(row?.status).toBe("duplicated")
    // 真源存在 + 三处「同一声明」并存：content-area 分发 case + 侧栏导航 + 工作台卡片。
    expect(row?.duplicatedIn).toEqual([
      "src/components/layout/content-area.tsx:372",
      "src/components/layout/nav-items.ts:89",
      "src/components/layout/workbench-view.tsx:80",
    ])
  })

  it("writingModel 投影行已下线：盘点表与投影里都不再有 novel.writingModel", () => {
    // TASK-009 删掉了该条投影行（连同 duplicatedIn 的五处接线声明）。
    // 这条钉死：任何“把行加回来”的改动都会红。
    expect(AGENT_STUDIO_SETTING_CATALOG.some((entry) => entry.id === "novel.writingModel")).toBe(
      false,
    )
    const projection = projectAgentStudioSettings(realProbe())
    expect(projection.rows.find((r) => r.id === "novel.writingModel")).toBeUndefined()
    expect(projection.duplicateRowIds).not.toContain("novel.writingModel")
  })

  it("writingModel 已死透：非 spec 源码的**代码面**不再出现该标识符（反向漂移回归闸）", () => {
    const nonSpec = collectSourceFiles().filter((rel) => !isSpecPath(rel))

    // ── 闸门自校验（防“空断言”假绿）：确实扫到了真实仓库文件，且关键文件在列 ──
    expect(nonSpec.length).toBeGreaterThan(200)
    expect(nonSpec).toContain("src/lib/llm/model-resolver.ts")
    expect(nonSpec).toContain("src/lib/novel/premium-execution.ts")
    expect(nonSpec).toContain("src/lib/project-store.ts")
    expect(nonSpec.filter(isSpecPath)).toEqual([])

    // ① 主闸：任何非 spec 源文件的**代码面**都不得再出现 writingModel 标识符。
    //    字段声明 / 角色→字段映射 / projectConfig 透传 / provider 赋值 / `as { writingModel?: T }`
    //    都会在这里红。注释与字符串（含 changelog 历史文本、迁移日志的旧键名）不算。
    const codeOffenders = nonSpec.filter((rel) => codeSurface(readSource(rel)).includes("writingModel"))
    expect(codeOffenders).toEqual([])

    // ② 全仓扫描的证据：它仍以「文本形式」存在于下面这批文件里，每一个都必须在审核时能解释清楚
    //    （注释解释删除 / changelog 历史文本 / 迁移日志的旧键名）。出现新文件 → 本断言红。
    const stillMentioned = nonSpec.filter((rel) => readSource(rel).includes("writingModel"))
    expect(stillMentioned).toEqual([
      "src/components/novel/main-control-settings-block.tsx", // 文件头注 + JSX 注释：已删除说明
      "src/components/settings/sections/novel-base-settings-section.tsx", // JSX 注释：已删除说明
      "src/lib/changelog.ts", // 历史 changelog 文本（字符串数据，不是字段）
      "src/lib/llm/model-resolver.ts", // 文件头注：字段已删、writer/reviser 映射为 null
      "src/lib/novel/deep-chapter-route-shell.ts", // 注释：writer/reviser 无独立字段
      "src/lib/novel/novel-model-test.ts", // 注释：writing 任务无独立字段
      "src/lib/novel/premium-execution.ts", // 注释：resolveWriterModel 的回退理由
      "src/lib/project-store.ts", // DEC-R5=A 迁移日志：旧键名只作为字符串比对，不是字段
    ])

    // ③ 去注释/去字符串器自身的有效性校验（否则 ① 可能因为“整文件被吃空”而永远为真）：
    //    同一文件处理后必须仍保留真代码标识符与 reviewModel 映射。
    const resolverSurface = codeSurface(readSource("src/lib/llm/model-resolver.ts"))
    expect(resolverSurface).toContain("ROLE_TO_CONFIG_FIELD")
    expect(resolverSurface).toContain("reviewModel")
    // 角色→字段映射的**形状**也钉住：writer / reviser 显式 null（无项目配置字段）。
    // 这条与 provider-registry.spec 的「旧键传了也不生效」行为锁互补：
    // 若有人把映射改回字符串 `writer: "writingModel"`（字符串不被 ① 的标识符闸抓到），
    // 这里会因为不再是 `writer: null` 而红。
    expect(resolverSurface).toContain("writer: null")
    expect(resolverSurface).toContain("reviser: null")
    expect(resolverSurface).not.toContain("TASK-009：")
    // 内联注释被剥掉、但同行代码保留（防“整行被注释寄存器吞掉”）
    expect(resolverSurface).toContain("export function resolveRoleModel")

    // ④ 迁移日志的实现约束：旧键名只能以**字符串**出现（否则 ① 会红），且确实做了 hasOwnProperty 判定。
    const storeSurface = codeSurface(readSource("src/lib/project-store.ts"))
    expect(storeSurface).not.toContain("writingModel")
    expect(readSource("src/lib/project-store.ts")).toContain('"writingModel"')
    expect(storeSurface).toContain("hasOwnProperty.call")
  })

  it("漂移闸机制自检：注释/字符串里的提及不算，代码位的字段/映射/透传必须被认出", () => {
    // 这条不依赖仓库当前状态，直接验 codeSurface 的判别力（防未来把帮手函数改坏成“永久为真”）。
    const asComment = [
      "// writingModel 已删除",
      "/* writingModel 已删除 */",
      "        {/* D2=C：writingModel 字段已删除 */}",
      'const MESSAGE = "writingModel 已删除"',
      "const MESSAGE = `字段 writingModel 已删除`",
    ]
    for (const snippet of asComment) {
      expect(codeSurface(snippet), snippet).not.toContain("writingModel")
    }

    const asCode = [
      "export interface NovelConfig {\n  writingModel: string\n}",
      'const FIELD_BY_ROLE = { writer: "f" }\nconst x = config.writingModel',
      "const cfg = { myModel, writingModel, reviewModel }",
      "config: { model, provider: input.projectConfig.writingModel },",
      "const legacy = config as { writingModel?: string }",
      "const m = `${config.writingModel}`",
    ]
    for (const snippet of asCode) {
      expect(codeSurface(snippet), snippet).toContain("writingModel")
    }
  })

  it("llm.maxContextSize 兜底默认值已收归单一真源（此前 204800 vs 131072 并存）", () => {
    const projection = projectAgentStudioSettings(realProbe())
    const row = projection.rows.find((r) => r.id === "llm.maxContextSize")

    // 五处各写各的默认值已合并为 DEFAULT_MAX_CONTEXT_TOKENS，不再有副本
    expect(row?.status).toBe("ok")
    expect(row?.duplicatedIn).toEqual([])
    expect(row?.sourceFile).toBe("src/lib/llm-context-limits.ts:29")
    expect(projection.defaultsById["llm.maxContextSize"]).toBe("32768")
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
