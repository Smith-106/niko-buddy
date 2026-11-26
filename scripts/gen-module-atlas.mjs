#!/usr/bin/env node
/**
 * gen-module-atlas.mjs — 模块地图生成器（静态 import 图 + 接线判定）
 *
 * 产物：src/lib/novel/module-atlas.generated.json（紧凑索引式，入库 + gen:check 门禁）
 *
 * 每个模块记录：
 *   p 路径 / s stage 序号 / l 行数 / r 入口可达 / o 孤立（无人 import）/
 *   x 仅测试引用（spec-only = 未接线判据）/ b 仅 barrel 暴露且无真实生产消费 /
 *   i 出边模块序号 / e 外部依赖包名
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

function isBarrelFile(absPath) {
  return /\/index\.tsx?$/.test(absPath.split("\\").join("/"))
}

function isTestOrHelperFile(absPath) {
  const normalized = absPath.split("\\").join("/")
  return (
    /\.(spec|test|bench)\.(ts|tsx|mts)$/.test(normalized) ||
    /(?:^|\/)(?:test-helpers|__tests__)\//.test(normalized)
  )
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
    if (entry.endsWith(".d.ts")) continue
    if (!SOURCE_EXTS.some((ext) => entry.endsWith(ext))) continue
    if (isTestOrHelperFile(full)) continue
    out.push(full)
  }
  return out
}

const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "in",
  "of",
  "new",
  "delete",
  "await",
  "yield",
  "else",
  "do",
])

function canStartRegex(prevChar, prevWord) {
  if (!prevChar) return true
  if ("([,{;:!=&|?+-*%^~".includes(prevChar)) return true
  if (prevWord && REGEX_PREV_KEYWORDS.has(prevWord)) return true
  return false
}

function skipRegexLiteral(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === "\n" || ch === "\r") return -1
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "[") {
      inClass = true
      i += 1
      continue
    }
    if (ch === "]") {
      inClass = false
      i += 1
      continue
    }
    if (ch === "/" && !inClass) {
      i += 1
      while (i < source.length && /[a-z]/i.test(source[i])) i += 1
      return i
    }
    i += 1
  }
  return -1
}

/**
 * 字符级清空 JS/TS 注释（`// ...` 与 `/* ... *\/`），保留字符串与模板字面量原样，
 * 避免注释内 `from "wiki/..."` 等说明文字被误识别为外部包依赖。
 * 单/双引号在未转义换行处复位，防止 TSX 文本中的英文撇号跨行吞噬代码。
 */
function stripComments(code) {
  let out = ""
  let i = 0
  let prevChar = ""
  let prevWord = ""
  const templateBraceStack = []

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2)
      const slice = end === -1 ? code.slice(i + 2) : code.slice(i + 2, end)
      out += slice.includes("\n") ? slice.replace(/[^\n]/g, "") : " "
      i = end === -1 ? code.length : end + 2
      continue
    }
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2)
      if (end === -1) break
      out += "\n"
      i = end + 1
      continue
    }
    if (ch === "/" && next !== "/" && next !== "*" && canStartRegex(prevChar, prevWord)) {
      const end = skipRegexLiteral(code, i)
      if (end > 0) {
        out += code.slice(i, end)
        prevChar = "/"
        prevWord = ""
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      const q = ch
      out += ch
      i += 1
      while (i < code.length) {
        const c = code[i]
        out += c
        if (c === "\\" && i + 1 < code.length) {
          out += code[i + 1]
          i += 2
          continue
        }
        i += 1
        if (c === q || c === "\n") break
      }
      prevChar = q
      prevWord = ""
      continue
    }
    if (ch === "`") {
      out += ch
      i += 1
      while (i < code.length) {
        const c = code[i]
        if (c === "\\" && i + 1 < code.length) {
          out += c + code[i + 1]
          i += 2
          continue
        }
        if (c === "$" && code[i + 1] === "{") {
          out += "${"
          i += 2
          templateBraceStack.push(0)
          prevChar = "{"
          prevWord = ""
          break
        }
        out += c
        i += 1
        if (c === "`") {
          prevChar = "`"
          prevWord = ""
          break
        }
      }
      continue
    }
    if (templateBraceStack.length > 0) {
      if (ch === "{") {
        templateBraceStack[templateBraceStack.length - 1] += 1
      } else if (ch === "}") {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop()
          out += ch
          i += 1
          while (i < code.length) {
            const c = code[i]
            if (c === "\\" && i + 1 < code.length) {
              out += c + code[i + 1]
              i += 2
              continue
            }
            if (c === "$" && code[i + 1] === "{") {
              out += "${"
              i += 2
              templateBraceStack.push(0)
              prevChar = "{"
              prevWord = ""
              break
            }
            out += c
            i += 1
            if (c === "`") {
              prevChar = "`"
              prevWord = ""
              break
            }
          }
          continue
        }
        templateBraceStack[templateBraceStack.length - 1] -= 1
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1
      const word = code.slice(i, end)
      out += word
      prevWord = word
      prevChar = word[word.length - 1]
      i = end
      continue
    }
    out += ch
    if (!/\s/.test(ch)) {
      prevChar = ch
      prevWord = ""
    }
    i += 1
  }
  return out
}

// 说明符字符类排除引号与换行；调用前已经过 stripComments，避免注释正文误配。
const FROM_RE = /\bfrom\s+["']([^"'\n\r]+)["']/g
const BARE_IMPORT_RE = /\bimport\s+["']([^"'\n\r]+)["']/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"'\n\r]+)["']\s*\)/g
const EXPORT_FROM_RE = /\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s+["']([^"'\n\r]+)["']/g

const NAMED_EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"'\n\r]+)["']/g
const STAR_AS_EXPORT_FROM_RE = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"'\n\r]+)["']/g
const STAR_EXPORT_FROM_RE = /\bexport\s+\*\s+from\s+["']([^"'\n\r]+)["']/g
const NAMED_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s+from\s+["']([^"'\n\r]+)["']/g
const NAMESPACE_OR_DEFAULT_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s+from\s+["']([^"'\n\r]+)["']/g

function collectSpecifiers(cleanCode) {
  const found = new Set()
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(cleanCode)) !== null) {
      const spec = m[1]
      // 合法模块说明符不含空白：含空白的必然是字符串正文误配。
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

/**
 * 解析 barrel 文件（index.ts/tsx）的显式命名重导出与通配重导出映射。
 * 返回 `{ named: Map<exportName, Array<{ targetAbs, origName }>>, stars: Set<targetAbs> }`。
 */
function parseBarrelExports(cleanCode, barrelFile) {
  const named = new Map()
  const stars = new Set()
  const addNamed = (exportName, targetAbs, origName) => {
    let list = named.get(exportName)
    if (!list) {
      list = []
      named.set(exportName, list)
    }
    if (!list.some((item) => item.targetAbs === targetAbs && item.origName === origName)) {
      list.push({ targetAbs, origName })
    }
  }

  NAMED_EXPORT_FROM_RE.lastIndex = 0
  let m
  while ((m = NAMED_EXPORT_FROM_RE.exec(cleanCode)) !== null) {
    const targetAbs = resolveSpecifier(m[2], barrelFile, new Set())
    if (!targetAbs) continue
    for (const rawItem of m[1].split(",")) {
      const item = rawItem.trim().replace(/^type\s+/, "").trim()
      if (!item) continue
      const match = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (!match) continue
      const origName = match[1]
      const exportName = match[2] ?? match[1]
      addNamed(exportName, targetAbs, origName)
    }
  }

  STAR_AS_EXPORT_FROM_RE.lastIndex = 0
  while ((m = STAR_AS_EXPORT_FROM_RE.exec(cleanCode)) !== null) {
    const targetAbs = resolveSpecifier(m[2], barrelFile, new Set())
    if (!targetAbs) continue
    addNamed(m[1], targetAbs, "*")
  }

  STAR_EXPORT_FROM_RE.lastIndex = 0
  while ((m = STAR_EXPORT_FROM_RE.exec(cleanCode)) !== null) {
    const targetAbs = resolveSpecifier(m[1], barrelFile, new Set())
    if (targetAbs) stars.add(targetAbs)
  }

  return { named, stars }
}

/** 沿 barrelExportMap 解析某个导出符号对应的真实底层模块（支持嵌套 barrel）。 */
function resolveBarrelSymbol(barrelAbs, symbolName, barrelExportMap, visited = new Set()) {
  const visitKey = `${barrelAbs}\0${symbolName}`
  if (visited.has(visitKey)) return []
  visited.add(visitKey)
  const info = barrelExportMap.get(barrelAbs)
  if (!info) return []

  const results = new Set()
  const entries = info.named.get(symbolName)
  if (entries && entries.length > 0) {
    for (const { targetAbs, origName } of entries) {
      results.add(targetAbs)
      if (barrelExportMap.has(targetAbs)) {
        const nested = origName === "*"
          ? collectAllBarrelTargets(targetAbs, barrelExportMap, new Set([barrelAbs]))
          : resolveBarrelSymbol(targetAbs, origName, barrelExportMap, visited)
        for (const leaf of nested) results.add(leaf)
      }
    }
    return [...results]
  }

  for (const starTarget of info.stars) {
    results.add(starTarget)
    if (barrelExportMap.has(starTarget)) {
      for (const leaf of resolveBarrelSymbol(starTarget, symbolName, barrelExportMap, visited)) {
        results.add(leaf)
      }
    }
  }
  return [...results]
}

/** 保守展开 barrel 暴露的全部底层目标（用于 `import * as ns` 与动态 `import("@/lib/novel")`）。 */
function collectAllBarrelTargets(barrelAbs, barrelExportMap, visited = new Set()) {
  if (visited.has(barrelAbs)) return []
  visited.add(barrelAbs)
  const info = barrelExportMap.get(barrelAbs)
  if (!info) return []

  const results = new Set()
  for (const entries of info.named.values()) {
    for (const { targetAbs } of entries) {
      results.add(targetAbs)
      if (barrelExportMap.has(targetAbs)) {
        for (const leaf of collectAllBarrelTargets(targetAbs, barrelExportMap, visited)) {
          results.add(leaf)
        }
      }
    }
  }
  for (const starTarget of info.stars) {
    results.add(starTarget)
    if (barrelExportMap.has(starTarget)) {
      for (const leaf of collectAllBarrelTargets(starTarget, barrelExportMap, visited)) {
        results.add(leaf)
      }
    }
  }
  return [...results]
}

/** 收集非 barrel 文件经 barrel 消费的底层模块绝对路径集合。 */
function collectBarrelResolvedTargets(cleanCode, fromFile, barrelExportMap) {
  const targets = new Set()
  const consumeNamedBlock = (block, spec) => {
    const barrelAbs = resolveSpecifier(spec, fromFile, new Set())
    if (!barrelAbs || !barrelExportMap.has(barrelAbs)) return
    for (const rawItem of block.split(",")) {
      const item = rawItem.trim().replace(/^type\s+/, "").trim()
      if (!item) continue
      const match = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/)
      if (!match) continue
      for (const target of resolveBarrelSymbol(barrelAbs, match[1], barrelExportMap)) {
        targets.add(target)
      }
    }
  }

  NAMED_IMPORT_RE.lastIndex = 0
  let m
  while ((m = NAMED_IMPORT_RE.exec(cleanCode)) !== null) {
    consumeNamedBlock(m[1], m[2])
  }

  NAMED_EXPORT_FROM_RE.lastIndex = 0
  while ((m = NAMED_EXPORT_FROM_RE.exec(cleanCode)) !== null) {
    consumeNamedBlock(m[1], m[2])
  }

  for (const re of [NAMESPACE_OR_DEFAULT_IMPORT_RE, DYNAMIC_IMPORT_RE, STAR_EXPORT_FROM_RE, STAR_AS_EXPORT_FROM_RE]) {
    re.lastIndex = 0
    while ((m = re.exec(cleanCode)) !== null) {
      const spec = re === STAR_AS_EXPORT_FROM_RE ? m[2] : m[1]
      const barrelAbs = resolveSpecifier(spec, fromFile, new Set())
      if (!barrelAbs || !barrelExportMap.has(barrelAbs)) continue
      for (const target of collectAllBarrelTargets(barrelAbs, barrelExportMap)) {
        targets.add(target)
      }
    }
  }

  return targets
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
  const cleanSources = new Map()
  const barrelExportMap = new Map()

  const modules = files.map((file) => {
    const code = readSource(file)
    const cleanCode = stripComments(code)
    cleanSources.set(file, cleanCode)
    const rel = relative(ROOT, file).split(sep).join("/")
    if (isBarrelFile(file)) {
      barrelExportMap.set(file, parseBarrelExports(cleanCode, file))
    }
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
    const cleanCode = cleanSources.get(mod.file) ?? ""
    for (const spec of collectSpecifiers(cleanCode)) {
      const target = resolveSpecifier(spec, mod.file, mod.externals)
      if (!target) continue
      const targetIndex = ids.get(target)
      if (targetIndex === undefined) continue
      mod.out.add(targetIndex)
    }
  }

  // 反向边 + spec-only + barrel 符号级消费归因：从全部源文件（含测试/脚手架）扫一遍 import 关系。
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
      if (entry.endsWith(".d.ts")) continue
      if (SOURCE_EXTS.some((ext) => entry.endsWith(ext)) || entry.endsWith(".json")) {
        allFiles.push(full)
      }
    }
  }
  collectAll(SRC)

  for (const file of allFiles) {
    let cleanCode = cleanSources.get(file)
    if (cleanCode === undefined) {
      try {
        cleanCode = file.endsWith(".json") ? "" : stripComments(readSource(file))
      } catch {
        continue
      }
    }
    if (!cleanCode) continue
    const spec = isTestOrHelperFile(file)
    const barrel = isBarrelFile(file)
    for (const raw of collectSpecifiers(cleanCode)) {
      const target = resolveSpecifier(raw, file, new Set())
      if (!target) continue
      const targetIndex = ids.get(target)
      if (targetIndex === undefined) continue
      const mod = modules[targetIndex]
      if (spec) mod.specImporters.add(file)
      else if (ids.get(file) !== targetIndex) {
        // barrel（index.ts/tsx）只代表「暴露」，不代表「有调用者」——分开统计；
        // 真实调用者通过下方 barrel 符号解析归因到实际消费的子模块。
        if (barrel) mod.viaIndex.add(file)
        else mod.importers.add(file)
      }
    }
    if (!barrel) {
      for (const targetAbs of collectBarrelResolvedTargets(cleanCode, file, barrelExportMap)) {
        const targetIndex = ids.get(targetAbs)
        if (targetIndex === undefined || ids.get(file) === targetIndex) continue
        const mod = modules[targetIndex]
        if (spec) mod.specImporters.add(file)
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
