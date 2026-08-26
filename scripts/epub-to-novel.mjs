#!/usr/bin/env node
/**
 * epub-to-novel.mjs — 将 epub 书稿提取为 QMAI .novel 项目骨架（chapters/N/draft.md + status.json）。
 *
 * 用法:
 *   node scripts/epub-to-novel.mjs --epub <path.epub> --project <dest> [--chapters 1-210] [--title <书题>]
 *
 * 输出（与 8人 同契约）:
 *   <project>/.novel/chapters/N/draft.md     每章正文（清理 HTML）
 *   <project>/.novel/status.json             {chapters: {N: {title,status,word_count,draft_path,created_at}}}
 *
 * 只生成骨架，不调用 LLM；快照由 formal-llm-chapter-extract.mjs 后续生成。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

// 用 node:zlib 不需要额外依赖；epub 是 zip。用内置无 zip 库时回退到命令行？
// 直接用纯 JS：读 epub 需要 unzip —— 用 python 子进程更稳（Windows 环境 zip 库可用）。
// 简化：本脚本调 python 解包，Node 只做编排。
import { execFileSync } from "node:child_process"

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const epub = resolve(arg("--epub", ""))
const project = resolve(arg("--project", ""))
const chaptersArg = arg("--chapters", "1-210")

if (!epub || !existsSync(epub) || !project) {
  console.error('Usage: node scripts/epub-to-novel.mjs --epub <path.epub> --project <dest> [--chapters 1-210]')
  process.exit(1)
}

function parseChapters(spec) {
  if (spec.includes("-")) {
    const [a, b] = spec.split("-").map((x) => parseInt(x, 10))
    return [a, b]
  }
  const n = parseInt(spec, 10)
  return [n, n]
}
const [chStart, chEnd] = parseChapters(chaptersArg)

// 用 python 解 epub（系统有 python；zipfile 标准库）
const pythonCode = `
import sys, zipfile, re, html, json
sys.stdout.reconfigure(encoding='utf-8')
epub = sys.argv[1]
start, end = int(sys.argv[2]), int(sys.argv[3])
z = zipfile.ZipFile(epub)
names = sorted(n for n in z.namelist() if re.match(r'index_split_\\d+\\.html$', n))
# index_split_000 = 第1章
def chapter_num(n):
    m = re.search(r'index_split_(\\d+)\\.html$', n)
    return int(m.group(1)) + 1
out = {}
for n in names:
    cn = chapter_num(n)
    if cn < start or cn > end: continue
    raw = z.read(n).decode('utf-8', errors='replace')
    text = re.sub(r'<[^>]+>', '', raw)
    text = html.unescape(text)
    text = re.sub(r'\\n{3,}', '\\n\\n', text).strip()
    # 去掉首行垃圾 token（ev52xfn0 类）与空白
    lines = [l.rstrip() for l in text.split('\\n')]
    while lines and (not lines[0].strip() or len(lines[0].strip()) < 12 and not lines[0].strip().startswith('第')):
        lines.pop(0)
    text = '\\n'.join(lines).strip()
    out[cn] = text
import json
sys.stdout.write(json.dumps(out, ensure_ascii=True))
`
const outJson = execFileSync("python", ["-c", pythonCode, epub, String(chStart), String(chEnd)], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
const chapters = JSON.parse(outJson)

// 建立项目骨架
const novelDir = join(project, ".novel")
const chaptersDir = join(novelDir, "chapters")
mkdirSync(chaptersDir, { recursive: true })

const statusChapters = {}
for (let cn = chStart; cn <= chEnd; cn++) {
  const text = chapters[cn]
  if (!text) continue
  const title = (text.split("\n")[0] || `第${cn}章`).slice(0, 40)
  const dir = join(chaptersDir, String(cn))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "draft.md"), text + "\n", "utf8")
  statusChapters[String(cn)] = {
    title,
    status: "draft",
    word_count: text.length,
    draft_path: `.novel/chapters/${cn}/draft.md`,
    created_at: new Date().toISOString(),
  }
}

const status = {
  $schema: ".novel/status.schema.json",
  project_name: basename(project),
  project_path: project,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  current_chapter: chStart,
  total_chapters: Object.keys(statusChapters).length,
  status: "draft",
  chapters: statusChapters,
  decision_gates: {},
  metadata: { source_epub: epub, source_chapters: `${chStart}-${chEnd}` },
}
writeFileSync(join(novelDir, "status.json"), JSON.stringify(status, null, 2) + "\n", "utf8")
console.log(`epub 提取完成: ${Object.keys(statusChapters).length} 章 (${chStart}-${chEnd}) → ${project}`)
console.log(`  status.json: ${Object.keys(statusChapters).length} chapters, total ${status.total_chapters}`)
