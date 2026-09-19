#!/usr/bin/env node
// extract-weknora-snapshot.mjs — R0-a1 WeKnora 评测集快照抽取（只读，不迁代码）。
//
// 共识来源：DeepSeek-flash + GLM-5.2 两路探讨共识 P0#1 同尺迁移评测；
// 批准计划 r2 §R0-a1，planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113。
//
// 输入（只读）：hub `reference/WeKnora` 独立仓（AGENTS.md 硬边界#2：reference 只读，
// 不迁移代码，只抽取评测集数据快照）——`dataset/samples/*.parquet`
// （queries 1 条 / corpus 4 条 / qrels gold pid 2,3 / answers 1 条，中文操作系统 QA demo）
// + 源 commit（`git rev-parse HEAD` 实测记录，不追上游——Q1 默认假设）。
// 输出：`src/lib/novel/__fixtures__/weknora-snapshot.<sha>.json`
// （ensure_ascii=False 的中文原文 JSON；旧快照保留一波再删）。
//
// 用法（仓库根执行）：
//   node scripts/extract-weknora-snapshot.mjs            # 抽取（幂等：同 commit 已有快照则跳过）
//   node scripts/extract-weknora-snapshot.mjs --check    # 只校验：快照与源一致（exit 0 一致 / 1 漂移 / 2 源不可读）
// 退出码：0 成功/一致；1 漂移（--check）或抽取失败；2 源不可读/参数错误。
// ASCII only 日志（防 PS 乱码）；parquet 解析委托系统 python（pandas+pyarrow）。

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const NIKO_BUDDY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const HUB_ROOT = join(NIKO_BUDDY_ROOT, "..")
const WEKNORA_ROOT = join(HUB_ROOT, "reference", "WeKnora")
const SAMPLES_DIR = join(WEKNORA_ROOT, "dataset", "samples")
const FIXTURE_DIR = join(NIKO_BUDDY_ROOT, "src", "lib", "novel", "__fixtures__")
const PARQUET_FILES = ["queries.parquet", "corpus.parquet", "qrels.parquet", "answers.parquet", "qas.parquet"]

const opts = { check: false }
for (const arg of process.argv.slice(2)) {
  if (arg === "--check") opts.check = true
  else {
    console.error(`[weknora-snapshot] 未知参数 ${arg}`)
    process.exit(2)
  }
}

function fail(code, message) {
  console.error(`[weknora-snapshot] ${message}`)
  process.exit(code)
}

if (!existsSync(SAMPLES_DIR)) fail(2, `源不可读：${SAMPLES_DIR} 不存在`)
for (const name of PARQUET_FILES) {
  if (!existsSync(join(SAMPLES_DIR, name))) fail(2, `源不可读：${name} 缺失`)
}

let sourceCommit
try {
  sourceCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: WEKNORA_ROOT,
    encoding: "utf8",
  }).trim()
} catch {
  fail(2, "源不可读：reference/WeKnora 非 git 仓或 git 不可用")
}

// parquet → JSON（python pandas+pyarrow；只读源目录）。
const PY_EXTRACT = `
import json, sys
import pandas as pd
out = {"files": {}, "tables": {}}
for name in ${JSON.stringify(PARQUET_FILES)}:
    path = ${JSON.stringify(SAMPLES_DIR)} + "/" + name
    df = pd.read_parquet(path)
    out["files"][name] = {"rows": int(len(df)), "columns": [str(c) for c in df.columns]}
    out["tables"][name] = df.astype(str).to_dict(orient="records")
print(json.dumps(out, ensure_ascii=False))
`

let extracted
try {
  const stdout = execFileSync("python", ["-c", PY_EXTRACT], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  extracted = JSON.parse(stdout)
} catch (error) {
  fail(1, `抽取失败：${error instanceof Error ? error.message : String(error)}`)
}

const snapshotPath = join(FIXTURE_DIR, `weknora-snapshot.${sourceCommit}.json`)
const snapshotBody = {
  schemaVersion: 1,
  source: "reference/WeKnora/dataset/samples（只读抽取，未迁移代码）",
  sourceCommit,
  files: extracted.files,
  tables: extracted.tables,
}

if (opts.check) {
  if (!existsSync(snapshotPath)) fail(1, `漂移：快照 ${snapshotPath} 不存在，先不带 --check 抽取`)
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"))
  const same =
    onDisk.sourceCommit === snapshotBody.sourceCommit &&
    JSON.stringify(onDisk.files) === JSON.stringify(snapshotBody.files) &&
    JSON.stringify(onDisk.tables) === JSON.stringify(snapshotBody.tables)
  if (!same) fail(1, "漂移：源与快照不一致，重跑不带 --check 的抽取并审查 diff")
  console.log(`[weknora-snapshot] CHECK PASS：${snapshotPath} 与源一致（commit ${sourceCommit}）`)
  process.exit(0)
}

// 非 --check：幂等（同 commit 已有快照则跳过）；旧快照保留（只提示，不自动删）。
mkdirSync(FIXTURE_DIR, { recursive: true })
if (existsSync(snapshotPath)) {
  console.log(`[weknora-snapshot] SKIP：同 commit 快照已存在 ${snapshotPath}`)
  process.exit(0)
}
const stale = readdirSync(FIXTURE_DIR).filter(
  (name) => name.startsWith("weknora-snapshot.") && name.endsWith(".json"),
)
writeFileSync(snapshotPath, `${JSON.stringify(snapshotBody, null, 2)}\n`, "utf8")
console.log(`[weknora-snapshot] WROTE ${snapshotPath}（commit ${sourceCommit}）`)
if (stale.length > 0) {
  console.log(`[weknora-snapshot] NOTE：旧快照保留一波再删：${stale.join("、")}`)
}
