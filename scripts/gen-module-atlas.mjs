#!/usr/bin/env node
/**
 * gen-module-atlas.mjs — 模块地图生成器（静态 import 图 + 接线判定）
 *
 * 产物：src/lib/novel/module-atlas.generated.json（紧凑索引式，入库 + gen:check 门禁）
 *
 * 每个模块记录：
 *   p 路径 / s stage 序号 / l 行数 / r 入口可达 / o 孤立（无人 import）/
 *   x 仅测试引用（spec-only = 未接线判据）/ i 出边模块序号 / e 外部依赖包名
 *
 * 确定性纪律：无时间戳、模块按路径排序、键顺序固定 —— 支持「临时路径重生成 + 字节比对」。
 *
 * 用法：node scripts/gen-module-atlas.mjs [--out <path>]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs"
import { join, dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")
const DEFAULT_OUT = join(ROOT, "src/lib/novel/module-atlas.generated.json")

const SOURCE_EXTS = [".ts", ".tsx", ".mts"]
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".json"]

/** 入口根：运行时真正从这里开始执行。 */
const ENTRY_FILES = ["src/main.tsx", "src/App.tsx"]

/** 阶段泳道（顺序即视图分层顺序）。 */
const STAGES = [
  { id: "bootstrap", label: "建项与灵感" },
  { id: "director", label: "开书导演" },
  { id: "incubate", label: "冷启动孵化" },
  { id: "world", label: "世界观与角色" },
  { id: "outline", label: "大纲与框架" },
  { id: "plan", label: "章节骨架与计划" },
  { id: "draft", label: "正文起草" },
  { id: "gate", label: "门控与评分" },
  { id: "accept", label: "收口与摄取" },
  { id: "memory", label: "记忆与事实库" },
  { id: "review", label: "审阅与跟进" },
  { id: "deliver", label: "交付与导出" },
  { id: "agent", label: "Agent 运行时" },
  { id: "knowledge", label: "检索与知识库" },
  { id: "simulation", label: "故事模拟" },
  { id: "analysis", label: "拆书与风格分析" },
  { id: "ui", label: "UI 组件" },
  { id: "state", label: "状态层" },
  { id: "support", label: "支撑与工具" },
  { id: "other", label: "其它" },
]
const STAGE_INDEX = new Map(STAGES.map((s, i) => [s.id, i]))

/** novel 层按文件名归阶段的规则（顺序敏感，先命中先得）。 */
const NOVEL_NAME_RULES = [
  [/director/, "director"],
  [/incubat|soul-doc|cold-?start/, "incubate"],
  [/world-blueprint|entity-|character-|cast-|name-?canon|alias-resolver/, "world"],
  [/outline/, "outline"],
  [/chapter-unpack|chapter-pipeline|chapter-plan|beat-|task-brief|task-router|task-custom|context-/,
    "plan"],
  [/campaign|draft|generation|prose|polish|format-normaliz|normalize-markdown|chapter-typography|chapter-content|chapter-edit|chapter-import|chapter-meta|chapter-excerpt|chapter-display|word-count/,
    "draft"],
  [/gate|audit|rule-stack|anti-ai|avoid-ai|consistenc|quality|score|subgate|auto-arm|ced-report/,
    "gate"],
  [/ingest|accept|status|commit|snapshot/, "accept"],
  [/memory|foreshadow|canon|emotion-ledger|particle-ledger|projection|resource-ledger/, "memory"],
  [/review|follow-?up|residual|diagnostic|health|briefing|digest/, "review"],
  [/export|epub|deliver/, "deliver"],
  [/skill|knowledge|kb-|kb\/|ann-index|brute-force-index|bm25|embedding|retrieval|search/, "knowledge"],
  [/simulation|soul|story-|framework|tension|pacing|thrill/, "simulation"],
  [/book-analysis|dismantl|extraction|style-|aura|appeal|fingerprint|adversarial|likelihood|plain-language|six-dimension|analysis|diff-model|bm25|preference/, "analysis"],
  [/agent-|llm-|web-search|plan-client/, "agent"],
]

function stageOf(relPath) {
  const p = relPath.split(sep).join("/")
  if (p.startsWith("src/components/")) return "ui"
  if (p.startsWith("src/stores/")) return "state"
  if (p.startsWith("src/lib/agent/")) return "agent"
  if (p.startsWith("src/lib/novel/story-simulation/")) return "simulation"
  if (p.startsWith("src/lib/novel/kb/")) return "knowledge"
  if (p.startsWith("src/lib/novel/")) {
    const name = p.slice("src/lib/novel/".length)
    for (const [re, stage] of NOVEL_NAME_RULES) {
      if (re.test(name)) return stage
    }
    return "support"
  }
  if (p.startsWith("src/")) return "support"
  return "other"
}

function walkSourceFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue
      walkSourceFiles(full, out)
      continue
    }
    if (!SOURCE_EXTS.some((ext) => entry.endsWith(ext))) continue
    if (entry.endsWith(".spec.ts") || entry.endsWith(".spec.tsx") || entry.endsWith(".spec.mts")) {
      continue
    }
    if (full.includes(`${sep}test-helpers${sep}`)) continue
    out.push(full)
  }
  return out
}

// 说明符字符类排除引号与换行：注释正文（含 `from "…"` 字样）不得跨行被误当作
// import，否则同一份源码在 CRLF / LF 检出下会产出不同字节（字节门禁随环境漂移）。
const FROM_RE = /\bfrom\s+["']([^"'\n\r]+)["']/g
const BARE_IMPORT_RE = /\bimport\s+["']([^"'\n\r]+)["']/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"'\n\r]+)["']\s*\)/g
const EXPORT_FROM_RE = /\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s+["']([^"'\n\r]+)["']/g

function collectSpecifiers(code) {
  const found = new Set()
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) {
      const spec = m[1]
      // 合法模块说明符不含空白：含空白的必然是注释/字符串正文误配。
      if (spec.length === 0 || /\s/.test(spec)) continue
      found.add(spec)
    }
  }
  return [...found]
}

/** 解析 specifier → 仓内绝对路径；外部包返回 null 并把包名写进 externals。 */
function resolveSpecifier(spec, fromFile, externals) {
  let base
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec)
  else {
    externals.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0])
    return null
  }
  const candidates = [base, ...RESOLVE_EXTS.map((ext) => base + ext)]
  for (const ext of RESOLVE_EXTS) {
    candidates.push(join(base, `index${ext}`))
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

function isSpecFile(absPath) {
  return absPath.endsWith(".spec.ts") || absPath.endsWith(".spec.tsx") || absPath.endsWith(".spec.mts")
}

/**
 * 读源码并归一换行。Windows 检出（CRLF）与 CI 检出（LF）必须产出相同字节，
 * 否则 gen:check 字节门禁会随环境漂移。
 */
function readSource(file) {
  return readFileSync(file, "utf8").split("\r\n").join("\n")
}

function buildAtlas() {
  const files = walkSourceFiles(SRC, []).sort()
  const ids = new Map(files.map((f, i) => [f, i]))
  const modules = files.map((file) => {
    const code = readSource(file)
    const rel = relative(ROOT, file).split(sep).join("/")
    return {
      file,
      rel,
      loc: code.split("\n").length,
      stage: STAGE_INDEX.get(stageOf(rel)) ?? STAGE_INDEX.get("other"),
      out: new Set(),
      externals: new Set(),
      importers: new Set(),
      viaIndex: new Set(),
      specImporters: new Set(),
    }
  })

  for (const mod of modules) {
    const code = readSource(mod.file)
    for (const spec of collectSpecifiers(code)) {
      const target = resolveSpecifier(spec, mod.file, mod.externals)
      if (!target) continue
      const targetIndex = ids.get(target)
      if (targetIndex === undefined) continue
      mod.out.add(targetIndex)
    }
  }

  // 反向边 + spec-only 判定：从全部源文件（含 spec）再扫一遍 import 关系。
  const allFiles = []
  const collectAll = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (entry === "node_modules") continue
        collectAll(full)
        continue
      }
      if (SOURCE_EXTS.some((ext) => entry.endsWith(ext)) || entry.endsWith(".json")) {
        allFiles.push(full)
      }
    }
  }
  collectAll(SRC)
  for (const file of allFiles) {
    let code
    try {
      code = readSource(file)
    } catch {
      continue
    }
    const spec = isSpecFile(file)
    for (const raw of collectSpecifiers(code)) {
      const target = resolveSpecifier(raw, file, new Set())
      if (!target) continue
      const targetIndex = ids.get(target)
      if (targetIndex === undefined) continue
      const mod = modules[targetIndex]
      if (spec) mod.specImporters.add(file)
      else if (ids.get(file) !== targetIndex) {
        // barrel（index.ts/tsx）只代表「暴露」，不代表「有调用者」——分开统计，
        // 否则 barrel 架构下一切模块都显得「已接线」。
        const normalized = file.split("\\").join("/")
        if (/\/index\.tsx?$/.test(normalized)) mod.viaIndex.add(file)
        else mod.importers.add(file)
      }
    }
  }

  // 入口可达性 BFS
  const entryIndexes = ENTRY_FILES.map((rel) => ids.get(join(ROOT, rel))).filter((i) => i !== undefined)
  const reachable = new Set(entryIndexes)
  const queue = [...entryIndexes]
  while (queue.length > 0) {
    const current = modules[queue.shift()]
    for (const next of current.out) {
      if (reachable.has(next)) continue
      reachable.add(next)
      queue.push(next)
    }
  }

  const outModules = modules.map((mod, index) => {
    const record = {
      p: mod.rel,
      s: mod.stage,
      l: mod.loc,
      r: reachable.has(index),
      o: mod.importers.size === 0 && !ENTRY_FILES.includes(mod.rel),
      x: mod.importers.size === 0 && mod.specImporters.size > 0,
      b: mod.importers.size === 0 && mod.viaIndex.size > 0 && mod.specImporters.size === 0,
      i: [...mod.out].sort((a, b) => a - b),
    }
    if (mod.externals.size > 0) record.e = [...mod.externals].sort()
    return record
  })

  const stats = {
    modules: outModules.length,
    reachable: outModules.filter((m) => m.r).length,
    unwired: outModules.filter((m) => !m.r).length,
    orphan: outModules.filter((m) => m.o).length,
    specOnly: outModules.filter((m) => m.x).length,
    barrelOnly: outModules.filter((m) => m.b).length,
    edges: outModules.reduce((sum, m) => sum + m.i.length, 0),
    loc: outModules.reduce((sum, m) => sum + m.l, 0),
  }

  return {
    schemaVersion: 1,
    generator: "scripts/gen-module-atlas.mjs",
    stages: STAGES,
    stats,
    modules: outModules,
  }
}

function main() {
  const outArg = process.argv.indexOf("--out")
  const outPath = outArg >= 0 && process.argv[outArg + 1] ? resolve(process.argv[outArg + 1]) : DEFAULT_OUT
  const atlas = buildAtlas()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(atlas, null, 1)}\n`, "utf8")
  const rel = relative(ROOT, outPath).split(sep).join("/")
  console.log(`[module-atlas] ${rel}`)
  console.log(
    `[module-atlas] modules=${atlas.stats.modules} reachable=${atlas.stats.reachable} ` +
      `unwired=${atlas.stats.unwired} specOnly=${atlas.stats.specOnly} ` +
      `barrelOnly=${atlas.stats.barrelOnly} edges=${atlas.stats.edges}`,
  )
}

main()
