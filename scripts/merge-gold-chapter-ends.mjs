#!/usr/bin/env node
/**
 * merge-gold-chapter-ends.mjs — 章末标注合并：标注数组 → gold JSON
 * 读取 tmp-annot-b*.mjs（ANNOT_BN 数组）追加生成 gold/batch-20260826-t01b-chapter-ends/
 * 用法：node scripts/merge-gold-chapter-ends.mjs [b1|b2|...]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const OUT = resolve("docs/p0/corpus/gold/batch-20260826-t01b-chapter-ends")
mkdirSync(OUT, { recursive: true })

// 读取所有 tmp-annot-*.mjs 文件并收集标注
const scriptsDir = resolve(__dirname)
const files = readdirSync(scriptsDir).filter(f => /^tmp-annot-b\d+\.mjs$/.test(f))
let all = []
for (const f of files) {
  const mod = await import(pathToFileURL(join(scriptsDir, f)).href)
  const key = Object.keys(mod).find(k => k.startsWith("ANNOT_"))
  all = all.concat(mod[key])
}

let written = 0, skipped = 0
for (const [src, hookType, strength, evidence] of all) {
  const genre = src.split("-")[0]
  const outPath = join(OUT, `${src.replace(".txt", "")}-end.json`)
  if (existsSync(outPath)) {
    skipped++
    continue
  }
  const gold = {
    gold_id: `gold-${genre}-end-${src.replace(".txt", "")}`,
    batch_id: "batch-20260826-t01b-chapter-ends",
    source_file: `human/batch-20260826-t01b1-human/${src}`,
    layer: "gold",
    genre,
    type: "chapter_end",
    annotator: "ai-assisted-pending-review",
    annotation_date: "2026-08-26",
    chapter_id: src.replace(".txt", ""),
    hook_type: hookType,
    strength,
    evidence,
    pending: true,
  }
  writeFileSync(outPath, JSON.stringify(gold, null, 2), "utf8")
  written++
}
console.log(`[merge-gold] 写入 ${written} 条（跳过 ${skipped} 重复）→ ${OUT}`)
