#!/usr/bin/env node
// impact-analysis.mjs — ISO 3.7.3 analysability：改动影响面静态分析。
//
// 用法：node scripts/impact-analysis.mjs <文件路径或符号名>
//   node scripts/impact-analysis.mjs src/lib/novel/chapter-ingest.ts
//   node scripts/impact-analysis.mjs parseFrontmatter
//
// 输出：①该文件的直接依赖者（谁 import 它）②该文件的直接依赖（它 import 谁）
//        ③符号级引用（grep 调用点）④影响面评分（扇入/扇出/层级深度）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, relative, extname } from 'node:path'

const ROOT = resolve(process.cwd())
const SRC = join(ROOT, 'src')

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e)) yield p
  }
}

const IMPORT_RE = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*(?:,\s*\{[^}]*\})?\s*from\s+['"]([^'"]+)['"]/g
const IMPORT_SIDE_RE = /import\s+['"]([^'"]+)['"]/g

function fileImports(file) {
  const src = readFileSync(file, 'utf-8')
  const deps = []
  for (const re of [IMPORT_RE, IMPORT_SIDE_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) deps.push(m[1])
  }
  return deps
}

function resolveImport(importer, spec) {
  // @/ → src/；./ ../ 相对；否则外部包跳过
  let base
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(join(importer, '..'), spec)
  else return null
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '.d.ts']) {
    if (existsSync(base + ext)) return base + ext
  }
  if (existsSync(base) && statSync(base).isFile()) return base
  return null
}

const target = process.argv[2]
if (!target) {
  console.error('用法: node scripts/impact-analysis.mjs <文件路径|符号名>')
  process.exit(1)
}

const isSymbol = !target.includes('/') && !target.endsWith('.ts')
const targetFile = isSymbol ? null : resolve(target)

const dependents = new Map() // file → [importers]
const dependencies = new Map() // file → [deps]
const symbolRefs = []

for (const f of walk(SRC)) {
  const deps = fileImports(f)
  dependencies.set(f, deps)
  for (const d of deps) {
    const r = resolveImport(f, d)
    if (!r) continue
    if (!dependents.has(r)) dependents.set(r, [])
    dependents.get(r).push(f)
  }
  if (isSymbol) {
    const src = readFileSync(f, 'utf-8')
    const symRe = new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    let cnt = 0
    while (symRe.exec(src)) cnt++
    if (cnt > 0) symbolRefs.push({ file: f, count: cnt })
  }
}

if (isSymbol) {
  console.log(`=== 符号 "${target}" 引用面 ===`)
  symbolRefs.sort((a, b) => b.count - a.count)
  for (const { file, count } of symbolRefs.slice(0, 30)) {
    console.log(`  ${relative(ROOT, file)}: ${count} refs`)
  }
  console.log(`总引用文件数: ${symbolRefs.length}`)
} else {
  console.log(`=== 影响面分析: ${relative(ROOT, targetFile)} ===`)
  const deps = dependencies.get(targetFile) ?? []
  const localDeps = deps.map(d => resolveImport(targetFile, d)).filter(Boolean)
  const extDeps = deps.filter(d => !d.startsWith('@/') && !d.startsWith('.'))
  console.log(`\n[扇出] 直接依赖 ${localDeps.length} 本地 + ${extDeps.length} 外部`)
  for (const d of localDeps.slice(0, 20)) console.log(`  → ${relative(ROOT, d)}`)
  console.log(`\n[扇入] 直接依赖者 ${(dependents.get(targetFile) ?? []).length}`)
  for (const f of (dependents.get(targetFile) ?? []).slice(0, 20)) console.log(`  ← ${relative(ROOT, f)}`)
  const fanIn = (dependents.get(targetFile) ?? []).length
  const risk = fanIn > 20 ? 'HIGH（改一处炸一片）' : fanIn > 5 ? 'MED' : 'LOW'
  console.log(`\n[风险] 扇入 ${fanIn} → 改动风险 ${risk}`)
}
