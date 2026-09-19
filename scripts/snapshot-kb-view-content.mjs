#!/usr/bin/env node
/**
 * snapshot-kb-view-content.mjs — R1 全字段内容面快照（策展闸门 fixture）。
 *
 * 背景：sync-kb-view-to-niko-buddy.mjs 的投影面显式排除 content 类字段（summary/contentDigest），
 * 故策展闸门（8 字段 + 摘要 + 出处）必须在**全字段面**评分。hub 全量视图
 * （reference/REFERENCE-KB-VIEW.json）不在 本仓内，故冻结为仓内 fixture（文件名带
 * builtFrom sha 后缀），使 R1-d 门禁可在单仓内复跑且可检测漂移。
 *
 * 输入：../reference/REFERENCE-KB-VIEW.json（hub 生成产物）
 * 输出：src/lib/novel/__fixtures__/reference-kb-view.content-<sha>.json
 *   —— 仅写作面 collection（craft/lexicon/world_ref/corpus）+ 门禁相关字段（有界）。
 *
 * 用法：node scripts/snapshot-kb-view-content.mjs [--check]
 *   --check  现有 fixture 与源是否一致（exit 0 一致 / 1 漂移 / 2 源不可读）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const FIXTURE_DIR = resolve(REPO_ROOT, "src/lib/novel/__fixtures__")

const SOURCES = [
  process.env.KB_VIEW_SOURCE_FULL,
  resolve(REPO_ROOT, "../reference/REFERENCE-KB-VIEW.json"),
].filter(Boolean)

const WRITING_COLLECTIONS = ["craft", "lexicon", "world_ref", "corpus"]
const FIELDS = [
  "name",
  "collection",
  "title",
  "author",
  "lang",
  "era",
  "domain",
  "query_intent",
  "trust",
  "summary",
  "contentDigest",
  "upstream",
  "purpose",
]

const check = process.argv.includes("--check")

function fail(code, msg) {
  console.error(`[kb-view-content-snapshot] ${msg}`)
  process.exit(code)
}

const sourcePath = SOURCES.find((p) => existsSync(p))
if (!sourcePath) fail(2, `源不可读：尝试 ${SOURCES.join(" / ")}`)

const view = JSON.parse(readFileSync(sourcePath, "utf8"))
if (!view?.builtFrom) fail(2, "源缺 builtFrom（新鲜度指纹）")
const sha = String(view.builtFrom).replace(/^sha256:/, "").slice(0, 16)

const entries = []
for (const collection of WRITING_COLLECTIONS) {
  for (const entry of view.collections?.[collection] ?? []) {
    const projected = {}
    for (const f of FIELDS) if (entry[f] !== undefined) projected[f] = entry[f]
    projected.collection = collection
    entries.push(projected)
  }
}

const snapshot = {
  schemaVersion: 1,
  builtFrom: view.builtFrom,
  source: "reference/REFERENCE-KB-VIEW.json（hub 生成产物；内容面快照，禁手改）",
  collections: WRITING_COLLECTIONS,
  entryCount: entries.length,
  entries,
}

const outPath = resolve(FIXTURE_DIR, `reference-kb-view.content-${sha}.json`)
const payload = JSON.stringify(snapshot, null, 2) + "\n"

if (check) {
  if (!existsSync(outPath)) fail(1, `fixture 缺失：${outPath}`)
  const existing = readFileSync(outPath, "utf8")
  if (existing !== payload) fail(1, `fixture 漂移（源 ${view.builtFrom}）：请重跑快照生成器`)
  console.log(`[kb-view-content-snapshot] CHECK PASS：${outPath}（builtFrom ${view.builtFrom}，${entries.length} 条）`)
  process.exit(0)
}

mkdirSync(FIXTURE_DIR, { recursive: true })
// 旧快照保留一波（仅删除本前缀下的非当前 sha 文件）
for (const f of readdirSync(FIXTURE_DIR)) {
  if (f.startsWith("reference-kb-view.content-") && f !== `reference-kb-view.content-${sha}.json`) {
    try {
      unlinkSync(resolve(FIXTURE_DIR, f))
    } catch {
      /* 旧快照删除失败不阻断 */
    }
  }
}
writeFileSync(outPath, payload, "utf8")
console.log(`[kb-view-content-snapshot] ✓ 写出 ${outPath}`)
console.log(`  builtFrom=${view.builtFrom} 条目=${entries.length} 体积=${payload.length}B`)
