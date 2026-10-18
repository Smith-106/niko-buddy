#!/usr/bin/env node
/**
 * check-consistency.mjs — 前后端一致性的机械门禁
 *
 * 覆盖三层一致性（真源 = 代码，不依赖注释与文档声明）：
 *
 *   内容一致性  IPC 参数名 ⊆ Rust 签名；i18n zh/en 键集等价；版本单一真源
 *   架构一致性  invoke ↔ `#[tauri::command]` ↔ `generate_handler!` 三方闭合；
 *               capabilities 覆盖所用插件；生成物 atlas 内部自洽
 *   功能一致性  事件 topic 有 Rust 发射方；视图 union ↔ 渲染/计划态闭合
 *
 * 纪律：只读源码 + 只读生成物；确定性输出（路径排序）；无网络；无副作用。
 * 失败即以非 0 退出并逐条列出反例，禁止 warn-only 通过。
 *
 * 用法：node scripts/check-consistency.mjs [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")
const RUST = join(ROOT, "src-tauri", "src")
const JSON_OUT = process.argv.includes("--json")

const failures = []
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures.push({ name, detail })
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "target" || entry === "dist") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, filter, out)
    else if (filter(entry)) out.push(full)
  }
  return out
}

const rel = (p) => relative(ROOT, p).split("\\").join("/")
const isSpec = (p) => /\.spec\.[cm]?[jt]sx?$/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p)
const norm = (name) => name.replace(/[_-]/g, "").toLowerCase()

// ── 源码收集 ────────────────────────────────────────────────────────────────

const tsFiles = walk(SRC, (n) => /\.(ts|tsx|mts)$/.test(n))
const rustFiles = walk(RUST, (n) => n.endsWith(".rs"))

// Rust：#[tauri::command] 签名（跳过属性之间的 /// 文档注释与其它属性）
const INJECTED_TYPES = [/AppHandle/, /State\s*</, /^Window/, /^Webview/, /CommandScope/, /Manager\s*</]

function parseCommandSignatures() {
  const commands = new Map()
  for (const file of rustFiles) {
    const code = readFileSync(file, "utf8")
    for (const attr of code.matchAll(/#\[tauri::command[^\]]*\]/g)) {
      const rest = code.slice(attr.index + attr[0].length)
      const fn = rest.match(/^((?:\s*(?:\/\/[^\n]*|\/\/![^\n]*|#\[[^\]]*\])\n|\s)*)\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/)
      if (!fn) continue
      const open = fn[0].length - 1 + fn.index
      let depth = 0
      let close = -1
      for (let i = open; i < rest.length; i += 1) {
        const ch = rest[i]
        if (ch === "(") depth += 1
        else if (ch === ")") {
          depth -= 1
          if (depth === 0) { close = i; break }
        }
      }
      if (close < 0) continue
      const raw = rest.slice(open + 1, close)
      const parts = []
      let d = 0
      let cur = ""
      for (const ch of raw) {
        if ("([{<".includes(ch)) d += 1
        if ("`)]}>".includes(ch.replace("`", ")"))) d -= 1
        if (ch === "," && d === 0) { parts.push(cur); cur = "" } else cur += ch
      }
      parts.push(cur)
      const params = []
      for (const part of parts) {
        const t = part.trim()
        const m = t.match(/^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/)
        if (!m) continue
        if (INJECTED_TYPES.some((re) => re.test(m[2].trim()))) continue
        params.push(m[1])
      }
      commands.set(fn[2], { params, file: rel(file) })
    }
  }
  return commands
}

const commands = parseCommandSignatures()

function parseHandlerRegistrations() {
  const lib = readFileSync(join(RUST, "lib.rs"), "utf8")
  const block = lib.match(/generate_handler!\s*\[([\s\S]*?)\]/)
  if (!block) return null
  return block[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop().trim())
}

function parseTsInvocations() {
  const sites = []
  for (const file of tsFiles) {
    const code = readFileSync(file, "utf8")
    for (const match of code.matchAll(/invoke(?:<[^>]*>)?\(\s*(["'`])([A-Za-z0-9_]+)\1/g)) {
      let i = match.index + match[0].length
      while (i < code.length && /\s/.test(code[i])) i += 1
      let keys = null
      let spread = false
      if (code[i] === ",") {
        i += 1
        while (i < code.length && /\s/.test(code[i])) i += 1
        if (code[i] === "{") {
          let depth = 0
          let end = -1
          for (let k = i; k < code.length; k += 1) {
            const ch = code[k]
            if (ch === "{") depth += 1
            else if (ch === "}") { depth -= 1; if (depth === 0) { end = k; break } }
          }
          if (end > 0) {
            const body = code.slice(i + 1, end)
            const chunks = []
            let d = 0
            let cur = ""
            for (const ch of body) {
              if ("([{".includes(ch)) d += 1
              if (")]}".includes(ch)) d -= 1
              if (ch === "," && d === 0) { chunks.push(cur); cur = "" } else cur += ch
            }
            chunks.push(cur)
            keys = []
            for (const chunk of chunks) {
              const t = chunk.trim()
              if (!t) continue
              if (t.startsWith("...")) { spread = true; continue }
              const named = t.match(/^(\w+)\s*:/)
              if (named) { keys.push(named[1]); continue }
              const shorthand = t.match(/^(\w+)$/)
              if (shorthand) keys.push(shorthand[1])
            }
          }
        }
      }
      sites.push({ name: match[2], keys: keys ?? [], spread, file: rel(file) })
    }
  }
  return sites
}

function checkIpcRegistry() {
  const handler = parseHandlerRegistrations()
  if (handler === null) {
    record("ipc/generate_handler", false, ["lib.rs 未找到 generate_handler! 清单"])
    return
  }
  const handlerSet = new Set(handler)
  const commandSet = new Set(commands.keys())

  const missingInRust = [...handler].filter((name) => !commandSet.has(name))
  record(
    "ipc/handler-declares-command",
    missingInRust.length === 0,
    missingInRust.length === 0
      ? [`${handler.length} 条注册命令均有 #[tauri::command] 定义`]
      : missingInRust.map((name) => `generate_handler! 注册但无 #[tauri::command] 定义: ${name}`),
  )

  const unregistered = [...commandSet].filter((name) => !handlerSet.has(name))
  record(
    "ipc/command-is-registered",
    unregistered.length === 0,
    unregistered.length === 0
      ? [`${commandSet.size} 个命令全部进入 invoke_handler`]
      : unregistered.map((name) => `已定义但未注册（前端 invoke 必然失败）: ${name} ← ${commands.get(name).file}`),
  )

  const sites = parseTsInvocations().filter((site) => !isSpec(site.file))
  const unknown = [...new Set(sites.filter((s) => !commandSet.has(s.name)).map((s) => `${s.name} ← ${s.file}`))]
  record(
    "ipc/invoke-has-command",
    unknown.length === 0,
    unknown.length === 0 ? [`${sites.length} 处 invoke 全部命中 Rust 命令`] : unknown.map((u) => `invoke 无对应 Rust 命令: ${u}`),
  )
}

function checkIpcParams() {
  const sites = parseTsInvocations().filter((site) => !isSpec(site.file))
  const problems = []
  for (const site of sites) {
    const command = commands.get(site.name)
    if (!command) continue
    if (site.keys.length === 0 && !site.spread) continue
    const rustNorm = new Set(command.params.map(norm))
    const extra = site.keys.filter((key) => !rustNorm.has(norm(key)))
    const missing = site.spread ? [] : command.params.filter((p) => !site.keys.some((k) => norm(k) === norm(p)))
    if (extra.length > 0) {
      problems.push(`${site.name} ← ${site.file}: 多余实参 ${extra.join(",")}（Rust 形参: ${command.params.join(",") || "无"}）`)
    }
    if (missing.length > 0) {
      problems.push(`${site.name} ← ${site.file}: 缺实参 ${missing.join(",")}`)
    }
  }
  record(
    "ipc/param-names",
    problems.length === 0,
    problems.length === 0 ? [`${sites.length} 处 invoke 实参名与 Rust 形参一致`] : problems,
  )
}

// ── 事件 topic ─────────────────────────────────────────────────────────────

const topicSignature = (pattern) => pattern.replace(/\$\{[^}]*\}/g, "\u0000").replace(/\{[^}]*\}/g, "\u0000")

function collectRustTopics() {
  const signatures = new Set()
  for (const file of rustFiles) {
    const code = readFileSync(file, "utf8")
    for (const m of code.matchAll(/\.emit(?:_to|_filter)?(?:\s*::<[^>]*>)?\s*\(\s*"([^"\n]+)"/g)) {
      signatures.add(topicSignature(m[1]))
    }
    for (const m of code.matchAll(/format!\(\s*"([^"]+)"/g)) signatures.add(topicSignature(m[1]))
    for (const m of code.matchAll(/const\s+[A-Z0-9_]*EVENT[A-Z0-9_]*\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
      signatures.add(topicSignature(m[1]))
    }
  }
  return signatures
}

function collectTsListenTopics() {
  const topics = new Map()
  for (const file of tsFiles) {
    const code = readFileSync(file, "utf8")
    for (const m of code.matchAll(/\blisten(?:<[^>]*>)?\(\s*(["'`])((?:(?!\1)[\s\S])*)\1/g)) {
      const topic = m[2]
      if (/^(?:plugin:|tauri:)/.test(topic)) continue
      if (topic.includes("${")) {
        topics.set(topicSignature(topic), { raw: topic, file: rel(file), dynamic: true })
        continue
      }
      if (!/^[A-Za-z][\w:./-]*$/.test(topic)) continue
      topics.set(topicSignature(topic), { raw: topic, file: rel(file), dynamic: false })
    }
  }
  return topics
}

function checkEvents() {
  const rustTopics = collectRustTopics()
  const tsTopics = collectTsListenTopics()
  const orphans = []
  for (const [signature, info] of tsTopics) {
    if (rustTopics.has(signature)) continue
    orphans.push(`${info.raw} ← ${info.file}（Rust 侧无同名/同形发射点）`)
  }
  record(
    "events/listen-has-emitter",
    orphans.length === 0,
    orphans.length === 0 ? [`${tsTopics.size} 个前端监听 topic 均有 Rust 发射方`] : orphans,
  )
}

// ── i18n 键集等价 ──────────────────────────────────────────────────────────

function flatten(node, prefix = "", out = []) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out)
    else out.push(path)
  }
  return out
}

function checkI18n() {
  const zh = JSON.parse(readFileSync(join(SRC, "i18n/zh.json"), "utf8"))
  const en = JSON.parse(readFileSync(join(SRC, "i18n/en.json"), "utf8"))
  const zhKeys = new Set(flatten(zh))
  const enKeys = new Set(flatten(en))
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
  const details = []
  if (onlyZh.length > 0) details.push(`仅 zh 有: ${onlyZh.slice(0, 20).join(", ")}${onlyZh.length > 20 ? ` …(+${onlyZh.length - 20})` : ""}`)
  if (onlyEn.length > 0) details.push(`仅 en 有: ${onlyEn.slice(0, 20).join(", ")}${onlyEn.length > 20 ? ` …(+${onlyEn.length - 20})` : ""}`)
  record(
    "i18n/key-parity",
    details.length === 0,
    details.length === 0 ? [`zh/en 各 ${zhKeys.size} 键，键集完全一致`] : details,
  )
}

// ── 视图 union ↔ 渲染/计划态 ───────────────────────────────────────────────

function checkViews() {
  const store = readFileSync(join(SRC, "stores/wiki-store.ts"), "utf8")
  const unionSource = store.match(/activeView:\s*([^\n]+)/)
  if (!unionSource) {
    record("views/union", false, ["wiki-store.ts 未找到 activeView 联合类型"])
    return
  }
  const union = [...new Set(unionSource[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)))]
  const contentArea = readFileSync(join(SRC, "components/layout/content-area.tsx"), "utf8")
  const cases = new Set([...contentArea.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]))
  const conditions = new Set([...contentArea.matchAll(/activeView\s*===\s*"([^"]+)"/g)].map((m) => m[1]))
  const workbench = readFileSync(join(SRC, "components/layout/workbench-view.tsx"), "utf8")
  const planned = new Set(
    [...workbench.matchAll(/\{[^{}]*view:\s*"([^"]+)"[^{}]*planned:\s*true[^{}]*\}/g)].map((m) => m[1]),
  )
  const nav = readFileSync(join(SRC, "components/layout/nav-items.ts"), "utf8")
  const navViews = new Set([...nav.matchAll(/view:\s*"([^"]+)"/g)].map((m) => m[1]))

  const dead = union.filter((v) => !cases.has(v) && !conditions.has(v) && !planned.has(v))
  record(
    "views/union-is-renderable",
    dead.length === 0,
    dead.length === 0
      ? [`${union.length} 个视图 = ${cases.size} 渲染 + ${conditions.size} 条件 + ${planned.size} 计划态`]
      : dead.map((v) => `activeView 成员既无渲染分支也非计划态（点开落到 default）: ${v}`),
  )

  const strayCases = [...cases].filter((v) => !union.includes(v))
  record(
    "views/case-in-union",
    strayCases.length === 0,
    strayCases.length === 0 ? ["content-area 全部 case 均在 activeView union 内"] : strayCases.map((v) => `case "${v}" 不在 activeView union`),
  )

  const strayNav = [...navViews].filter((v) => !union.includes(v))
  record(
    "views/nav-in-union",
    strayNav.length === 0,
    strayNav.length === 0 ? [`${navViews.size} 个导航项均在 union 内`] : strayNav.map((v) => `导航项 view "${v}" 不在 activeView union`),
  )
}

// ── 版本单一真源 ───────────────────────────────────────────────────────────

function checkVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
  const tauri = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).version
  const cargo = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8").match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
  const changelogTs = readFileSync(join(SRC, "lib/changelog.ts"), "utf8").match(/version:\s*"([^"]+)"/)?.[1]
  const changelogMd = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").match(/^##\s*\[([^\]]+)\]/m)?.[1]
  const sources = { "package.json": pkg, "tauri.conf.json": tauri, "Cargo.toml": cargo, "changelog.ts": changelogTs, "CHANGELOG.md": changelogMd }
  const distinct = [...new Set(Object.values(sources).filter(Boolean))]
  const details = Object.entries(sources).map(([file, version]) => `${file}=${version ?? "缺失"}`)
  const ok = distinct.length === 1 && Object.values(sources).every(Boolean)
  record("version/single-source", ok, ok ? [`全部版本源一致: ${pkg}`] : [`版本源不一致: ${details.join(" / ")}`])
}

// ── 插件 ↔ capabilities ────────────────────────────────────────────────────

function checkCapabilities() {
  const capabilities = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"))
  const declared = capabilities.permissions.map((p) => (typeof p === "string" ? p : p.identifier))
  const usedPlugins = new Set()
  for (const file of tsFiles) {
    if (isSpec(rel(file))) continue
    const code = readFileSync(file, "utf8")
    for (const m of code.matchAll(/["']@tauri-apps\/plugin-([a-z-]+)["']/g)) usedPlugins.add(m[1])
  }
  const missing = [...usedPlugins].filter(
    (plugin) => !declared.some((perm) => perm === `${plugin}:default` || perm.startsWith(`${plugin}:`)),
  )
  record(
    "caps/plugin-permission",
    missing.length === 0,
    missing.length === 0
      ? [`${usedPlugins.size} 个前端插件权限均在 capabilities 内`]
      : missing.map((p) => `使用了 @tauri-apps/plugin-${p} 但 capabilities/default.json 未授权 ${p}:*`),
  )
}

// ── 生成物 atlas 自洽 ─────────────────────────────────────────────────────

function checkAtlas() {
  const path = join(SRC, "lib/novel/module-atlas.generated.json")
  const atlas = JSON.parse(readFileSync(path, "utf8"))
  const modules = atlas.modules ?? []
  const stats = atlas.stats ?? {}
  const derived = {
    modules: modules.length,
    reachable: modules.filter((m) => m.r).length,
    unwired: modules.filter((m) => !m.r).length,
    orphan: modules.filter((m) => m.o).length,
    specOnly: modules.filter((m) => m.x).length,
    barrelOnly: modules.filter((m) => m.b).length,
    edges: modules.reduce((sum, m) => sum + (m.i?.length ?? 0), 0),
  }
  const drift = Object.entries(derived).filter(([key, value]) => stats[key] !== value)
  const indexProblems = []
  modules.forEach((m, index) => {
    for (const out of m.i ?? []) {
      if (out < 0 || out >= modules.length) indexProblems.push(`${m.p} 出边越界: ${out}（当前 ${index}）`)
    }
  })
  const details = [
    ...drift.map(([key, value]) => `stats.${key}=${stats[key]} 与实测 ${value} 不符`),
    ...indexProblems.slice(0, 10),
  ]
  record(
    "atlas/internal-consistency",
    details.length === 0,
    details.length === 0
      ? [`atlas ${stats.modules} 模块 / ${stats.edges} 边，统计与索引自洽`]
      : details,
  )
}

// ── 执行 ───────────────────────────────────────────────────────────────────

const checks = [
  checkIpcRegistry,
  checkIpcParams,
  checkEvents,
  checkI18n,
  checkViews,
  checkVersion,
  checkCapabilities,
  checkAtlas,
]

for (const check of checks) {
  try {
    check()
  } catch (error) {
    record(check.name, false, [`检查抛错: ${error instanceof Error ? error.message : String(error)}`])
  }
}

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, results }, null, 2)}\n`)
} else {
  for (const { name, ok, detail } of results) {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`)
    for (const line of detail) process.stdout.write(`     ${line}\n`)
  }
  const passed = results.filter((r) => r.ok).length
  process.stdout.write(`\n[check-consistency] RESULT: ${passed}/${results.length} passed\n`)
}

process.exit(failures.length === 0 ? 0 : 1)
