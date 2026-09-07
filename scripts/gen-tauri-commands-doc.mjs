#!/usr/bin/env node
/**
 * gen-tauri-commands-doc.mjs — 生成 Tauri 命令参考文档（68 号 P2-12 / C2）
 *
 * 解析 src-tauri/src/lib.rs 的 generate_handler! 注册块 + 各命令文件的
 * #[tauri::command] 声明，输出 Markdown 签名表（命令名 / 所属模块 / 是否注册），
 * 未注册声明列为「死命令」审计项（14 号审计已知 2 个）。
 *
 * 用法：node scripts/gen-tauri-commands-doc.mjs [输出路径]
 * 默认输出：docs/qmai-codex-delivery/90-tauri-commands-reference-20260907.md
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const libRs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8")
const outDefault = join(root, "..", "docs", "qmai-codex-delivery", "90-tauri-commands-reference-20260907.md")
const outPath = process.argv[2] ?? outDefault

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
    declared.set(name, f.replace(root + "/", ""))
    if (!registered.has(name)) dead.push({ name, file: f.replace(root + "/", "") })
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
\`\`\`
`
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, doc, "utf8")
console.log(`written: ${outPath} (registered=${registered.size}, dead=${dead.length})`)
