#!/usr/bin/env node
/**
 * generate-anti-ai-corpus-bundle.mjs — 语料打包策略方案②构建脚本
 *
 * 把合成种子批次（batch-20260821-001）预编译成单个 JSON，供 AntiAiCandidatePool
 * 在生产打包应用内嵌加载（零 node:fs / 零路径解析）。
 *
 * 授权防泄漏硬约束：路径含 "unlicensed-ref" 直接 throw（990 片未授权文本绝不入包）。
 *
 * 用法（在 QMAI/ 目录执行）：
 *   node scripts/generate-anti-ai-corpus-bundle.mjs          # 生成 JSON 入库
 *   node scripts/generate-anti-ai-corpus-bundle.mjs --check  # 漂移比对（有语料树时）
 *
 * 生成物：src/lib/novel/anti-ai-seeds.generated.json（必须提交仓库；
 *        fresh clone 无法访问仓库外语料树；self-authored 无许可问题可入库）
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
// 语料树在 hub 根（QMAI 仓库外）；QMAI/scripts/ → ../../docs/p0/corpus
const HUB_CORPUS_ROOT = resolve(__dirname, "../../docs/p0/corpus")
const OUTPUT = resolve(__dirname, "../src/lib/novel/anti-ai-seeds.generated.json")

const ALLOWED_BATCHES = ["20260821-001"]
const FORBIDDEN_FRAGMENT = "unlicensed-ref"
const SCHEMA_VERSION = 1

function decode(buf) {
  return new TextDecoder("utf-8").decode(buf)
}

function loadLayer(layer) {
  const samples = []
  for (const batchId of ALLOWED_BATCHES) {
    const dir = join(HUB_CORPUS_ROOT, layer, `batch-${batchId}`)
    if (!existsSync(dir)) {
      console.warn(`[gen] skip missing: ${dir}`)
      continue
    }
    if (dir.includes(FORBIDDEN_FRAGMENT)) {
      throw new Error(`[gen] RED LINE: forbidden path fragment in ${dir}`)
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()
    for (const file of files) {
      if (file.includes(FORBIDDEN_FRAGMENT)) {
        throw new Error(`[gen] RED LINE: forbidden file name ${file}`)
      }
      const fullPath = join(dir, file)
      const text = decode(readFileSync(fullPath))
      const genre = /^([a-z]+)-\d+/.exec(file)?.[1] ?? "unknown"
      samples.push({
        file: `${layer}/batch-${batchId}/${file}`,
        genre,
        layer,
        words: text.length,
        text,
      })
    }
  }
  return samples
}

function buildBundle() {
  const human = loadLayer("human")
  const ai = loadLayer("ai")
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "synthetic-degraded",
    batchIds: ALLOWED_BATCHES,
    generatedAt: new Date().toISOString(),
    samples: [...human, ...ai],
  }
}

function generate() {
  if (!existsSync(HUB_CORPUS_ROOT)) {
    console.error(`[gen] 语料树不存在: ${HUB_CORPUS_ROOT}`)
    console.error(`[gen] fresh clone 无外语料树 → 保留现有 JSON，跳过生成`)
    process.exit(0)
  }
  const bundle = buildBundle()
  console.log(`[gen] human: ${bundle.samples.filter((s) => s.layer === "human").length} 片 | ai: ${bundle.samples.filter((s) => s.layer === "ai").length} 片`)
  const json = JSON.stringify(bundle) + "\n"
  writeFileSync(OUTPUT, json, "utf-8")
  const kb = Math.round(Buffer.byteLength(json, "utf-8") / 1024)
  console.log(`[gen] → ${OUTPUT} (${kb}KB, ${bundle.samples.length} 片)`)
}

function check() {
  if (!existsSync(HUB_CORPUS_ROOT)) {
    console.log("[gen] --check: 语料树不存在，跳过漂移比对（CI 环境）")
    return
  }
  if (!existsSync(OUTPUT)) {
    console.error("[gen] --check: ✗ 生成物缺失，请重跑 generate-anti-ai-corpus-bundle.mjs")
    process.exit(1)
  }
  const existing = readFileSync(OUTPUT, "utf-8")
  const fresh = buildBundle()
  const freshJson = JSON.stringify(fresh) + "\n"
  // 比对排除时间戳
  const stripTs = (s) => s.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":""')
  if (stripTs(existing) === stripTs(freshJson)) {
    console.log("[gen] --check: ✓ 生成物与语料树一致")
  } else {
    console.error("[gen] --check: ✗ 漂移！请重跑 generate-anti-ai-corpus-bundle.mjs")
    process.exit(1)
  }
}

if (process.argv.includes("--check")) check()
else generate()
