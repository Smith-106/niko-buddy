#!/usr/bin/env node
/**
 * gold-promote.mjs — 黄金集 pending→confirmed 批量升级（T01b-3 共识）
 * 前置条件：κ ≥0.7（kappa-round2.mjs gold_qualified=true）后由人工执行；
 * 默认 dry-run（--apply 才真正翻转），--batch <id> 可按批次筛选。
 * 升级标记：pending:false + confirmed_by + confirmed_at（保留原值于 git 历史）
 *
 * 用法：
 *   node scripts/gold-promote.mjs --dry-run              # 预览将翻转多少条
 *   node scripts/gold-promote.mjs --apply --reason 人工抽检通过
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const GOLD = resolve("docs/p0/corpus/gold")
const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const bi = args.indexOf("--batch")
const batchFilter = bi >= 0 ? (args[bi + 1] ?? null) : null
const reason = args[args.indexOf("--reason") + 1] ?? `confirmed-${new Date().toISOString().slice(0, 10)}`

const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = d + "/" + f
    if (statSync(p).isDirectory()) walk(p)
    else if (f.endsWith(".json")) files.push(p)
  }
}
walk(GOLD)

let flipped = 0, skipped = 0
for (const p of files) {
  const d = JSON.parse(readFileSync(p, "utf8"))
  if (d.type !== "chapter_end" && d.type !== "arc") { skipped++; continue }
  if (batchFilter && d.batch_id !== batchFilter) { skipped++; continue }
  if (d.pending !== true) { skipped++; continue }
  if (APPLY) {
    d.pending = false
    d.confirmed_by = "human"
    d.confirmed_at = new Date().toISOString().slice(0, 10)
    d.confirm_reason = reason
    writeFileSync(p, JSON.stringify(d, null, 2), "utf8")
  }
  flipped++
}
console.log(`[gold-promote] ${APPLY ? "已翻转" : "预览"} ${flipped} 条（跳过 ${skipped}）`)
if (!APPLY) console.log("[gold-promote] 加 --apply 生效；升级前请确认 κ≥0.7 与人工抽检通过")
