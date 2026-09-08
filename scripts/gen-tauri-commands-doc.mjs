#!/usr/bin/env node
/**
 * gen-tauri-commands-doc.mjs — 生成 Tauri 命令参考文档（68 号 P2-12 / C2）
 *
 * 解析 src-tauri/src/lib.rs 的 generate_handler! 注册块 + 各命令文件的
 * #[tauri::command] 声明，输出 Markdown 签名表（命令名 / 所属模块 / 是否注册），
 * 未注册声明列为「死命令」审计项（14 号审计已知 2 个）。
 *
 * 用法：
 *   node scripts/gen-tauri-commands-doc.mjs            生成到默认仓内路径
 *   node scripts/gen-tauri-commands-doc.mjs --out <p> 生成到指定路径（兼容旧式位置参数）
 *   node scripts/gen-tauri-commands-doc.mjs --check   校验现有输出是否最新（exit 0/1，不写盘）
 *   node scripts/gen-tauri-commands-doc.mjs --check --out <p>
 *
 * 默认输出：docs/generated/tauri-commands-reference.md（QMAI 仓内，P0 B6 仓内化）
 * 同步副本：docs/qmai-codex-delivery/90-tauri-commands-reference-20260907.md（hub 仓外，
 *           README.md 索引引用；单向同步：默认路径生成时若副本存在则覆写为相同内容）
 *
 * --check 语义（P0 B4）：生成到 os.tmpdir() 临时路径，与现有输出目标字节比对；
 * 生成时间行（含日期）先规范化再比较，其余字节必须一致。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const libRs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")
const outDefault = join(root, "docs", "generated", "tauri-commands-reference.md")
const outMirror = join(root, "..", "docs", "qmai-codex-delivery", "90-tauri-commands-reference-20260907.md")

// 参数解析：--check 校验模式；--out <path> 覆盖输出路径；旧式位置参数兼容
let check = false
let outPath = outDefault
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") {
    check = true
  } else if (args[i] === "--out") {
    if (i + 1 >= args.length) throw new Error("--out requires a path argument")
    outPath = args[++i]
  } else if (args[i].startsWith("--")) {
    throw new Error(`unknown option: ${args[i]}`)
  } else {
    outPath = args[i]
  }
}

// 1) 注册块：generate_handler![ ... ]
const handlerMatch = libRs.match(/generate_handler!\[([\s\S]*?)\]\s*\)/)
if (!handlerMatch) throw new Error("generate_handler! block not found in lib.rs")
const registered = new Map() // name -> module
for (const line of handlerMatch[1].split("\n")) {
  const m = line.trim().match(/^([\w:]+)::(\w+),?$/)
  if (!m) continue
  const mod = m[1].replace(/^commands::/, "")
  registered.set(m[2], mod)
}

// 2) 声明：跨命令文件统计 #[tauri::command]
const cmdFiles = ["src-tauri/src/commands", "src-tauri/src"]
const declared = new Map() // name -> file
function scanDir(dir) {
  const entries = []
  for (const name of readFileSync(join(root, dir), { encoding: "utf8" })) void name
  return entries
}
void scanDir

import { readdirSync, statSync } from "node:fs"
const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (e.endsWith(".rs")) acc.push(p)
  }
  return acc
}
const rsFiles = []
for (const d of cmdFiles) walk(join(root, d), rsFiles)
// Repo-relative forward-slash path: join() emits backslashes on Windows, and the
// raw absolute path leaks the local machine layout into the committed doc (M0 CI fix).
const rel = (p) => relative(root, p).replaceAll("\\", "/")
const attrRe = /#\[tauri::command\s*\(?([^)\]]*)\)?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g
const dead = []
for (const f of rsFiles) {
  const src = readFileSync(f, "utf8")
  let m
  while ((m = attrRe.exec(src)) !== null) {
    if (m[1].includes("rename_all")) continue // 属性内不含 rename_all 时正常
    const name = m[2]
    if (src.slice(m.index - 400, m.index).includes("cfg(test)") || src.slice(m.index - 200, m.index).includes("#[cfg(test)]")) continue
    if (declared.has(name)) continue
    declared.set(name, rel(f))
    if (!registered.has(name)) dead.push({ name, file: rel(f) })
  }
}

// 3) 输出文档
const byMod = new Map()
for (const [name, mod] of registered) {
  const list = byMod.get(mod) ?? []
  list.push(name)
  byMod.set(mod, list)
}
const rows = [...byMod.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([mod, names]) => names.sort().map((n) => `| \`${n}\` | ${mod} | ✓ |`).join("\n"))
  .join("\n")

const doc = `# Tauri 命令参考（自动生成）

> 生成时间：${new Date().toISOString().slice(0, 10)}（脚本 \`scripts/gen-tauri-commands-doc.mjs\`，68 号 P2-12 / C2）
> 注册数：**${registered.size}**（\`generate_handler!\` 块）；未注册声明（死命令）：**${dead.length}**

## 注册命令（${registered.size}）

| 命令 | 模块 | 注册 |
|------|------|------|
${rows}

## 死命令审计（声明未注册，${dead.length}）

${dead.map((d) => `- \`${d.name}\` — ${d.file}`).join("\n") || "（无）"}

## 再生成

\`\`\`bash
node scripts/gen-tauri-commands-doc.mjs
node scripts/gen-tauri-commands-doc.mjs --check
\`\`\`
`
// 生成时间行规范化：--check 比对时忽略日期差异（P0 B4 要点）
const tsRe = /> 生成时间：\d{4}-\d{2}-\d{2}/g
const normalizeTs = (s) => s.replace(tsRe, "> 生成时间：DATE")

/** 字节级首个差异位置（两个 Buffer）；相等返回 -1。 */
function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

if (check) {
  if (!existsSync(outPath)) {
    console.error(`[gen-tauri-commands-doc] CHECK FAIL: target missing: ${outPath}`)
    process.exitCode = 1
  } else {
    // 临时路径重生成 + 字节比对（R11 防御：禁止 git diff --exit-code）
    const tmpDir = mkdtempSync(join(tmpdir(), "qmai-cmdoc-"))
    let fresh
    try {
      const tmpOut = join(tmpDir, "tauri-commands-reference.md")
      writeFileSync(tmpOut, doc, "utf8")
      fresh = readFileSync(tmpOut)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
    const cur = readFileSync(outPath)
    const a = Buffer.from(normalizeTs(cur.toString("utf8")), "utf8")
    const b = Buffer.from(normalizeTs(fresh.toString("utf8")), "utf8")
    const off = firstDiffOffset(a, b)
    if (off < 0) {
      console.log(`[gen-tauri-commands-doc] CHECK PASS: ${outPath} is up to date (${cur.length} bytes)`)
      process.exitCode = 0
    } else {
      console.error(`[gen-tauri-commands-doc] CHECK FAIL: ${outPath} differs at offset ${off} (timestamp-normalized)`)
      process.exitCode = 1
    }
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, doc, "utf8")
  console.log(`written: ${outPath} (registered=${registered.size}, dead=${dead.length})`)

  // 单向同步副本（P0 B6）：hub docs/qmai-codex-delivery/README.md 索引引用仓外文件；
  // 仅默认路径生成时同步，且副本已存在才覆写（生成器不在仓外凭空创建文件）。
  if (outPath === outDefault && existsSync(outMirror)) {
    writeFileSync(outMirror, doc, "utf8")
    console.log(`synced mirror: ${outMirror}`)
  }
}
