/**
 * classification-loader 行为测试。
 *
 * 原文件是 C4 空壳（只有 `expect(fn).toBeDefined()`，被测模块函数体一行都不执行），
 * 已按覆盖率战役要求在原位替换为真测试：所有用例都真实调用被测函数，并断言
 * 返回结构、来源判定、回退原因、写入内容与抛错。
 *
 * 关于 fixture 格式：`classification.md` 由 markdown-serializer 生成，但现网
 * `parseCategorySection` 的正则 `#### <标题>\s*\n((?:[^#].*\n?)*)` 会在「小节标题
 * 前有空行」时跨小节吞行（`.*` 可以匹配 `#`）。本文件关注 loader 自身逻辑，
 * 因此 fixture 用**紧凑格式**（小节标题紧接上一小节最后一行，无空行）构造，
 * 使解析结果精确可控；serializer 的跨小节解析缺陷不属于本文件职责，已在执行报告中
 * 单独记录，未在此处用断言把缺陷固化。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  const readErrors = new Map<string, Error>()
  return {
    files,
    readErrors,
    fileExists: vi.fn(async (path: string) => files.has(path)),
    readFile: vi.fn(async (path: string) => {
      const err = readErrors.get(path)
      if (err) throw err
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
}))

import {
  checkClassificationVersion,
  getRouteRule,
  initProjectClassification,
  loadClassificationConfig,
  loadProjectClassification,
  mergeRoutes,
  readProjectClassificationRaw,
  resolveRouteRule,
  upgradeClassificationConfig,
  validateFeatureRoutes,
  writeProjectClassification,
} from "./classification-loader"
import { serializeClassificationToMarkdown } from "./markdown-serializer"
import { DEFAULT_CLASSIFICATION_CONFIG, DEFAULT_CLASSIFICATION_ROUTES } from "./default-routes"
import { DATA_SOURCE_CATEGORY_LABELS } from "./types"
import type { ClassificationConfig, DataSourceCategory, RouteRule } from "./types"

const PROJECT = "C:/novel"
const CLASSIFICATION_FILE = "C:/novel/classification/classification.md"
const FEATURE_FILE = "C:/novel/classification/classification.branch_a.md"

function route(
  intent: RouteRule["intent"],
  required: DataSourceCategory[] = [],
  optional: DataSourceCategory[] = [],
  forbidden: DataSourceCategory[] = []
): RouteRule {
  return { intent, required, optional, forbidden }
}

/** 紧凑格式 fixture（见文件头说明：小节标题前不留空行）。 */
function markdownOf(routes: RouteRule[], version = "1.0.0"): string {
  const lines: string[] = [
    "# 意图路由配置 (classification.md)",
    "",
    `<!-- classification-version:${version} -->`,
    "",
    "<!-- AUTO-GENERATED-ROUTE:START -->",
  ]
  const sections: Array<[string, DataSourceCategory[]]> = []
  for (const r of routes) {
    lines.push(`### ${r.intent} (\`${r.intent}\`)`)
    sections.length = 0
    sections.push(["必载数据源", r.required], ["选载数据源", r.optional], ["禁载数据源", r.forbidden])
    for (const [title, cats] of sections) {
      lines.push(`#### ${title}`)
      if (cats.length === 0) {
        lines.push("- 无")
      } else {
        for (const cat of cats) {
          lines.push(`- ${DATA_SOURCE_CATEGORY_LABELS[cat]} (\`${cat}\`)`)
        }
      }
    }
  }
  lines.push("<!-- AUTO-GENERATED-ROUTE:END -->", "")
  return lines.join("\n")
}

function putFile(path: string, content: string): void {
  fsMocks.files.set(path, content)
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.files.clear()
  fsMocks.readErrors.clear()
})

describe("loadProjectClassification", () => {
  it("classification.md 不存在时返回 null 且不读文件", async () => {
    const result = await loadProjectClassification(PROJECT)

    expect(fsMocks.fileExists).toHaveBeenCalledWith(CLASSIFICATION_FILE)
    expect(fsMocks.readFile).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it("classification.md 存在时按文件内容解析出路由与版本号", async () => {
    putFile(
      CLASSIFICATION_FILE,
      markdownOf(
        [route("lint_chapter", ["chapter_content", "timeline"], ["outline"], ["plot_tools"])],
        "0.4.2"
      )
    )

    const result = await loadProjectClassification(PROJECT)

    expect(result).not.toBeNull()
    expect(result!.version).toBe("0.4.2")
    expect(result!.routes).toHaveLength(1)
    expect(result!.routes[0]).toEqual({
      intent: "lint_chapter",
      required: ["chapter_content", "timeline"],
      optional: ["outline"],
      forbidden: ["plot_tools"],
    })
  })

  it("classification.md 内容无法解析时抛出格式错误", async () => {
    putFile(CLASSIFICATION_FILE, "# 没有任何 AUTO-GENERATED-ROUTE 标记的文本\n")

    await expect(loadProjectClassification(PROJECT)).rejects.toThrow(
      "classification.md 格式不正确，无法解析"
    )
  })
})

describe("readProjectClassificationRaw", () => {
  it("反斜杠路径被归一化后再定位文件并返回原文", async () => {
    const normalized = "E:/Novel/book/classification/classification.md"
    putFile(normalized, "# 原始配置\n")

    const content = await readProjectClassificationRaw("E:\\Novel\\book")

    expect(fsMocks.fileExists).toHaveBeenCalledWith(normalized)
    expect(fsMocks.readFile).toHaveBeenCalledWith(normalized)
    expect(content).toBe("# 原始配置\n")
  })

  it("文件不存在时返回空字符串且不读文件", async () => {
    const content = await readProjectClassificationRaw(PROJECT)

    expect(fsMocks.readFile).not.toHaveBeenCalled()
    expect(content).toBe("")
  })
})

describe("loadClassificationConfig", () => {
  it("项目级文件缺失时回退到内置默认配置，且无回退原因", async () => {
    const result = await loadClassificationConfig(PROJECT)

    expect(result.source).toBe("default")
    expect(result.config).toBe(DEFAULT_CLASSIFICATION_CONFIG)
    expect(result.fallbackReason).toBeUndefined()
    expect(result.versionInfo!.upToDate).toBe(true)
    expect(result.versionInfo!.needsUpgrade).toBe(false)
  })

  it("项目级加载抛错时回退到默认配置并记录回退原因", async () => {
    putFile(CLASSIFICATION_FILE, "坏内容\n")
    fsMocks.readErrors.set(CLASSIFICATION_FILE, new Error("磁盘读取失败"))

    const result = await loadClassificationConfig(PROJECT)

    expect(result.source).toBe("default")
    expect(result.config).toBe(DEFAULT_CLASSIFICATION_CONFIG)
    expect(result.fallbackReason).toBe("项目级 classification.md 加载失败：磁盘读取失败")
  })

  it("未指定分支名时直接使用项目级配置并给出该配置的版本检查结果", async () => {
    putFile(
      CLASSIFICATION_FILE,
      markdownOf([route("write_chapter", ["outline"], ["memory"], ["revision"])], "0.9.0")
    )

    const result = await loadClassificationConfig(PROJECT)

    expect(result.source).toBe("project")
    expect(result.fallbackReason).toBeUndefined()
    expect(result.config.routes).toHaveLength(1)
    expect(result.config.routes[0]).toEqual({
      intent: "write_chapter",
      required: ["outline"],
      optional: ["memory"],
      forbidden: ["revision"],
    })
    expect(result.versionInfo!.currentVersion).toBe("0.9.0")
    expect(result.versionInfo!.needsUpgrade).toBe(true)
  })

  it("反斜杠项目路径被归一化后定位项目级文件", async () => {
    putFile("E:/Novel/book/classification/classification.md", markdownOf([route("general_chat")]))

    const result = await loadClassificationConfig("E:\\Novel\\book")

    expect(result.source).toBe("project")
    expect(result.config.routes[0].intent).toBe("general_chat")
  })

  it("分支级文件按合并规则并入项目级路由", async () => {
    putFile(
      CLASSIFICATION_FILE,
      markdownOf(
        [
          route("write_chapter", ["outline"], ["memory", "settings"], ["revision"]),
          route("general_chat"),
        ],
        "1.0.0"
      )
    )
    putFile(
      FEATURE_FILE,
      markdownOf([
        route("write_chapter", ["outline"], ["settings", "graph"], ["memory"]),
        route("lint_chapter", ["chapter_content"]),
      ])
    )

    const result = await loadClassificationConfig(PROJECT, "branch_a")

    expect(result.source).toBe("project_with_feature")
    expect(result.fallbackReason).toBeUndefined()
    expect(result.config.version).toBe("1.0.0")

    const byIntent = new Map(result.config.routes.map((r) => [r.intent, r]))
    expect([...byIntent.keys()]).toEqual(["write_chapter", "general_chat", "lint_chapter"])

    // memory 被分支级禁载收窄后必须从选载剔除；settings 已在项目级选载中，不重复追加
    expect(byIntent.get("write_chapter")).toEqual({
      intent: "write_chapter",
      required: ["outline"],
      optional: ["settings", "graph"],
      forbidden: ["revision", "memory"],
    })
    expect(byIntent.get("lint_chapter")!.required).toEqual(["chapter_content"])
  })

  it("分支级文件缺失时退回项目级配置且无回退原因", async () => {
    putFile(CLASSIFICATION_FILE, markdownOf([route("general_chat")]))

    const result = await loadClassificationConfig(PROJECT, "missing_branch")

    expect(result.source).toBe("project")
    expect(result.config.routes).toHaveLength(1)
    expect(result.fallbackReason).toBeUndefined()
  })

  it("分支级文件内容不可解析时退回项目级配置并记录分支级回退原因", async () => {
    putFile(CLASSIFICATION_FILE, markdownOf([route("general_chat")]))
    putFile(FEATURE_FILE, "随手写的分支说明，没有路由块\n")

    const result = await loadClassificationConfig(PROJECT, "branch_a")

    expect(result.source).toBe("project")
    expect(result.config.routes).toHaveLength(1)
    expect(result.fallbackReason).toBe(
      "分支级 classification 加载失败：classification.branch_a.md 格式不正确，无法解析"
    )
  })

  it("分支级文件读取抛错时退回项目级配置并带上错误原文", async () => {
    putFile(CLASSIFICATION_FILE, markdownOf([route("general_chat")]))
    putFile(FEATURE_FILE, markdownOf([route("lint_chapter")]))
    fsMocks.readErrors.set(FEATURE_FILE, new Error("EACCES: 权限不足"))

    const result = await loadClassificationConfig(PROJECT, "branch_a")

    expect(result.source).toBe("project")
    expect(result.fallbackReason).toBe("分支级 classification 加载失败：EACCES: 权限不足")
    expect(result.versionInfo!.currentVersion).toBe("1.0.0")
  })
})

describe("mergeRoutes", () => {
  it("项目级不存在的意图由分支级追加，且保留项目级顺序", () => {
    const merged = mergeRoutes(
      [route("write_chapter", ["outline"]), route("general_chat")],
      [route("lint_chapter", ["soul"])]
    )

    expect(merged.map((r) => r.intent)).toEqual(["write_chapter", "general_chat", "lint_chapter"])
    expect(merged[2].required).toEqual(["soul"])
  })

  it("分支级禁载与项目级禁载取并集并去重", () => {
    const merged = mergeRoutes(
      [route("write_chapter", [], [], ["revision", "graph"])],
      [route("write_chapter", [], [], ["graph", "memory"])]
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].forbidden).toEqual(["revision", "graph", "memory"])
  })

  it("被禁载的项目级选载会被剔除，分支级新增选载去重后追加", () => {
    const merged = mergeRoutes(
      [route("write_chapter", ["outline"], ["memory", "timeline"])],
      [route("write_chapter", [], ["memory", "timeline", "soul"], ["memory"])]
    )

    expect(merged[0].optional).toEqual(["timeline", "soul"])
    expect(merged[0].required).toEqual(["outline"])
  })

  it("分支级 required 不会覆盖项目级 required", () => {
    const merged = mergeRoutes(
      [route("write_chapter", ["outline", "soul"])],
      [route("write_chapter", ["chapter_content"])]
    )

    expect(merged[0].required).toEqual(["outline", "soul"])
  })

  it("分支路由为空时原样返回项目级路由", () => {
    const projectRoutes = [route("general_chat", [], [], [])]

    const merged = mergeRoutes(projectRoutes, [])

    expect(merged).toHaveLength(1)
    expect(merged[0].intent).toBe("general_chat")
  })
})

describe("initProjectClassification", () => {
  it("文件已存在时不写入", async () => {
    putFile(CLASSIFICATION_FILE, "已存在的配置")

    await initProjectClassification(PROJECT)

    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.files.get(CLASSIFICATION_FILE)).toBe("已存在的配置")
  })

  it("文件缺失时写入内置默认配置 markdown", async () => {
    await initProjectClassification("E:\\Novel")

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenContent] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(writtenPath).toBe("E:/Novel/classification/classification.md")
    expect(writtenContent).toContain("意图路由配置")
    expect(writtenContent).toContain("<!-- classification-version:1.0.0 -->")
    expect(writtenContent).toContain("<!-- AUTO-GENERATED-ROUTE:START -->")
    expect(writtenContent).toContain("`plot_tools`")
    expect(fsMocks.files.get(writtenPath)).toBe(writtenContent)
  })
})

describe("writeProjectClassification", () => {
  it("把配置序列化后原子写入归一化路径，内容与序列化结果完全一致", async () => {
    const config: ClassificationConfig = {
      version: "1.2.3",
      routes: [route("polish_chapter", ["chapter_content", "soul"], ["outline"], ["graph"])],
    }

    await writeProjectClassification("E:\\Novel", config)

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenContent] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(writtenPath).toBe("E:/Novel/classification/classification.md")
    expect(writtenContent).toBe(serializeClassificationToMarkdown(config))
    expect(writtenContent).toContain("<!-- classification-version:1.2.3 -->")
    expect(writtenContent).toContain("`polish_chapter`")
  })
})

describe("validateFeatureRoutes", () => {
  it("项目级不存在的意图直接跳过校验", () => {
    const result = validateFeatureRoutes(
      [route("write_chapter", ["outline"])],
      [route("lint_chapter", ["chapter_content"], [], ["outline"])]
    )

    expect(result).toEqual({ valid: true, errors: [] })
  })

  it("分支级禁载命中项目级必载时报错并点名数据源", () => {
    const result = validateFeatureRoutes(
      [route("write_chapter", ["outline", "soul"])],
      [route("write_chapter", [], [], ["outline"])]
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      "意图 write_chapter：分支级禁载不能包含项目级必载数据源 outline",
    ])
  })

  it("分支级必载不在项目级必载/选载中时报错", () => {
    const result = validateFeatureRoutes(
      [route("write_chapter", ["outline"], ["soul"])],
      [route("write_chapter", ["graph"])]
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(["意图 write_chapter：分支级必载 graph 不在项目级必载或选载中"])
  })

  it("多条违规全部收集而不是遇到第一条就返回", () => {
    const result = validateFeatureRoutes(
      [route("write_chapter", ["outline"], ["soul"])],
      [route("write_chapter", ["graph", "memory"], [], ["outline"])]
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toBe("意图 write_chapter：分支级禁载不能包含项目级必载数据源 outline")
    expect(result.errors[1]).toBe("意图 write_chapter：分支级必载 graph 不在项目级必载或选载中")
    expect(result.errors[2]).toBe("意图 write_chapter：分支级必载 memory 不在项目级必载或选载中")
  })

  it("分支级必载落在项目级选载中是合法的", () => {
    const result = validateFeatureRoutes(
      [route("write_chapter", ["outline"], ["soul"])],
      [route("write_chapter", ["soul"], [], ["graph"])]
    )

    expect(result).toEqual({ valid: true, errors: [] })
  })
})

describe("getRouteRule / resolveRouteRule", () => {
  it("getRouteRule 命中时返回配置中的规则", () => {
    const config: ClassificationConfig = {
      routes: [route("write_chapter", ["outline"]), route("general_chat")],
    }

    expect(getRouteRule(config, "write_chapter")!.required).toEqual(["outline"])
    expect(getRouteRule(config, "lint_chapter")).toBeUndefined()
  })

  it("resolveRouteRule 优先返回配置文件里的规则", () => {
    const config: ClassificationConfig = {
      routes: [route("write_chapter", ["chapter_content"])],
    }

    const rule = resolveRouteRule(config, "write_chapter")

    expect(rule.required).toEqual(["chapter_content"])
  })

  it("配置缺失时回退到内置默认规则并给出默认数据源集合", () => {
    const rule = resolveRouteRule({ routes: [] }, "polish_chapter")

    expect(rule).toBe(DEFAULT_CLASSIFICATION_ROUTES.find((r) => r.intent === "polish_chapter"))
    expect(rule.required).toEqual(["chapter_content", "soul"])
    expect(rule.forbidden).toContain("revision")
  })

  it("配置缺失且无默认规则时返回三空规则并保留意图名", () => {
    const rule = resolveRouteRule({ routes: [] }, "unknown_intent")

    expect(rule.intent).toBe("unknown_intent")
    expect(rule.required).toEqual([])
    expect(rule.optional).toEqual([])
    expect(rule.forbidden).toEqual([])
  })
})

describe("checkClassificationVersion", () => {
  it("版本相同视为最新且不可升级", () => {
    const info = checkClassificationVersion({ routes: [], version: "1.0.0" })

    expect(info).toEqual({
      upToDate: true,
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      needsUpgrade: false,
      canUpgrade: false,
    })
  })

  it("主版本落后时标记需要升级", () => {
    const info = checkClassificationVersion({ routes: [], version: "0.9.0" })

    expect(info.upToDate).toBe(false)
    expect(info.needsUpgrade).toBe(true)
    expect(info.canUpgrade).toBe(true)
  })

  it("次版本或补丁版本高于最新版时视为已是最新", () => {
    expect(checkClassificationVersion({ routes: [], version: "1.2.0" }).upToDate).toBe(true)
    expect(checkClassificationVersion({ routes: [], version: "1.0.1" }).upToDate).toBe(true)
    expect(checkClassificationVersion({ routes: [], version: "2.0.0" }).upToDate).toBe(true)
  })

  it("缺少版本号时按 1.0.0 处理", () => {
    const info = checkClassificationVersion({ routes: [] })

    expect(info.currentVersion).toBe("1.0.0")
    expect(info.upToDate).toBe(true)
    expect(info.needsUpgrade).toBe(false)
  })

  it("版本号段数不是三段时按 0.0.0 处理（低于最新版）", () => {
    for (const version of ["1.0", "1.0.0.0"]) {
      const info = checkClassificationVersion({ routes: [], version })
      expect(info.currentVersion).toBe(version)
      expect(info.upToDate).toBe(false)
      expect(info.needsUpgrade).toBe(true)
    }
  })
})

describe("upgradeClassificationConfig", () => {
  it("版本号提升到最新版", () => {
    const upgraded = upgradeClassificationConfig({
      version: "0.9.0",
      routes: [route("general_chat")],
    })

    expect(upgraded.version).toBe("1.0.0")
    expect(upgraded.version).toBe(DEFAULT_CLASSIFICATION_CONFIG.version)
  })

  it("缺失版本号时也补上最新版本号", () => {
    const upgraded = upgradeClassificationConfig({ routes: [] })

    expect(upgraded.version).toBe("1.0.0")
  })

  it("保留原有路由在前，补齐缺失的默认意图在后", () => {
    const upgraded = upgradeClassificationConfig({
      version: "0.9.0",
      routes: [route("write_chapter", ["outline"], ["soul"], ["memory"])],
    })

    expect(upgraded.routes).toHaveLength(DEFAULT_CLASSIFICATION_ROUTES.length)
    expect(upgraded.routes[0]).toEqual({
      intent: "write_chapter",
      required: ["outline"],
      optional: ["soul"],
      forbidden: ["memory"],
    })

    const intents = new Set(upgraded.routes.map((r) => r.intent))
    for (const defaultRoute of DEFAULT_CLASSIFICATION_ROUTES) {
      expect(intents.has(defaultRoute.intent)).toBe(true)
    }
    // 已存在的意图不重复补入
    expect(upgraded.routes.filter((r) => r.intent === "write_chapter")).toHaveLength(1)
    expect(upgraded.routes.filter((r) => r.intent === "general_chat")).toHaveLength(1)
  })

  it("补齐的默认路由是新对象而非默认配置里的同一引用", () => {
    const upgraded = upgradeClassificationConfig({ version: "0.9.0", routes: [] })

    expect(upgraded.routes).toHaveLength(DEFAULT_CLASSIFICATION_ROUTES.length)
    for (const [index, injected] of upgraded.routes.entries()) {
      expect(injected).not.toBe(DEFAULT_CLASSIFICATION_ROUTES[index])
      expect(injected).toEqual(DEFAULT_CLASSIFICATION_ROUTES[index])
    }
  })

  it("不修改传入的旧配置对象", () => {
    const oldConfig: ClassificationConfig = { version: "0.9.0", routes: [route("general_chat")] }

    const upgraded = upgradeClassificationConfig(oldConfig)

    expect(oldConfig.version).toBe("0.9.0")
    expect(oldConfig.routes).toHaveLength(1)
    expect(upgraded.routes).not.toBe(oldConfig.routes)
    expect(upgraded.routes.length).toBeGreaterThan(oldConfig.routes.length)
  })
})
