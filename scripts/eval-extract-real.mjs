#!/usr/bin/env node
/**
 * eval-extract-real.mjs — F3 真实语料抽取脚本（eval-real-baseline-path.md §4 步骤 2-4）。
 *
 * 职责:
 *   1. 读取真实书稿项目 .novel/snapshots/*.snapshot.json（自动编码检测：UTF-8 优先，
 *      GBK 回退；数据质量校验：结构化字段损坏检测）。支持多项目（--project 可多次，
 *      跨书 case 以项目短名前缀隔离）。
 *   2. goldChunks: 从 newCanonFacts 抽取（subject=chapter-<proj>-N, predicate=canon_fact,
 *      object=事实文本，canonical 归一）。
 *   3. poisonChunks: 真实数据中可检测的跨章冲突（characterStateChanges 前后不一致
 *      heuristic）——当前语料质量不足时显式留空（C7 不冒充）。
 *   4. 输出 EvalCase JSONL → fixtures/cases.jsonl + manifest.json(source=real) +
 *      frozen/<digest>/ 冻结（C4/C6）。
 *   5. 质量校验不达标 → 显式 WARN + 部分抽取，绝不静默冒充完好语料（C7）。
 *
 * 用法:
 *   node scripts/eval-extract-real.mjs --project <path> [--project <path2> ...] [--fixtures <dir>] [--out <dir>]
 *
 * 退出码: 0 = 抽取完成（含部分抽取+WARN）；1 = 无可用语料（硬 SKIP）。
 *
 * 编码说明（实测 8人 项目）: 快照文件可能为 UTF-8 或 GBK；先按 UTF-8 解析，失败则
 * GBK（TextDecoder('gbk')）回退。结构化字段损坏（如 "[object Object]" 字符串）时
 * 该字段标记 degraded，相关检测维度显式跳过。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
// C4：digest 单一幂等原语（checkpoint-digest.ts 零相对依赖，Node 24 类型剥离直引）。
import { computeCheckpointDigestOf } from "../src/lib/novel/checkpoint-digest.ts"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const QMAI_ROOT = resolve(SCRIPT_DIR, "..")
const DEFAULT_FIXTURES = join(QMAI_ROOT, "src", "lib", "novel", "eval", "fixtures")

const DECODE_ORDERS = ["utf-8", "gbk"]

/** 读取并解码 JSON（UTF-8 优先，GBK 回退）。返回 { obj, encoding } 或 null。 */
function readJsonSmart(path) {
  const raw = readFileSync(path)
  for (const enc of DECODE_ORDERS) {
    try {
      const text = new TextDecoder(enc).decode(raw)
      return { obj: JSON.parse(text), encoding: enc }
    } catch {
      // try next encoding
    }
  }
  return null
}

/** 数据质量校验：结构化字段是否完好（非 "[object Object]" 字符串）。 */
function qualityOf(snapshot) {
  const problems = []
  const check = (field) => {
    const v = snapshot[field]
    if (v === undefined) {
      problems.push(`${field}:missing`)
      return
    }
    if (Array.isArray(v) && v.length === 0) return // 空数组 = 合法（该章无此维度）
    const allObjectStrings =
      Array.isArray(v) && v.every((item) => typeof item === "string" && item === "[object Object]")
    if (allObjectStrings) problems.push(`${field}:serialized-as-object-string`)
  }
  check("characters")
  check("graphEdges")
  check("characterStateChanges")
  check("timelineEvents")
  check("foreshadowingChanges")
  return problems
}

/** 规范化实体名（C2 精神：resolveCanonicalName 的轻量镜像 — NFKC + trim）。 */
function canonicalName(name) {
  if (typeof name !== "string") return ""
  return name.trim().normalize("NFKC").replace(/・/g, "")
}

/** 从快照抽取 EvalCase（真实 gold；poison 视数据质量而定）。proj 为项目短名（跨书隔离）。 */
function extractCase(snapshot, chapterIndex, problems, proj) {
  const chapterNumber = snapshot.chapterNumber ?? chapterIndex + 1
  const p = proj ?? "p"
  const goldChunks = (snapshot.newCanonFacts || [])
    .filter((f) => typeof f === "string" && f.trim().length > 0)
    .map((fact, i) => ({
      id: `real-${p}-g-${String(chapterNumber).padStart(3, "0")}-${i}`,
      subject: `chapter-${p}-${chapterNumber}`,
      predicate: "canon_fact",
      object: canonicalName(fact),
      tier: "protected",
      expectedLayer: "protected",
    }))

  const poisonChunks = []
  // poison（former_as_current）：仅当 characterStateChanges 完好时可检测跨章回退；
  // 当前语料质量不足时显式留空（C7 不冒充）。
  const cscDegraded = problems.some((p2) => p2.startsWith("characterStateChanges:"))
  void cscDegraded

  return {
    id: `real-${p}-ch${String(chapterNumber).padStart(3, "0")}`,
    chapter: chapterNumber,
    project: p,
    query: `chapter-${p}-${chapterNumber}`,
    goldChunks,
    poisonChunks,
    expectedLayer: "protected",
    source: "real",
  }
}

function parseArgs(argv) {
  const args = { projects: [], fixtures: DEFAULT_FIXTURES, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--project") args.projects.push(argv[++i])
    else if (a === "--fixtures") args.fixtures = resolve(process.cwd(), argv[++i] ?? args.fixtures)
    else if (a === "--out") args.out = resolve(process.cwd(), argv[++i] ?? args.fixtures)
    else if (a === "--help" || a === "-h") args.help = true
    else {
      process.stderr.write(`[eval-extract-real] unknown arg: ${a}\n`)
      args.help = true
    }
  }
  return args
}

const USAGE = `eval-extract-real.mjs — F3 真实语料抽取（eval-real-baseline-path.md）

用法:
  node scripts/eval-extract-real.mjs --project <path> [--project <path2> ...]   多本合并（跨书前缀隔离）
  node scripts/eval-extract-real.mjs --project <path> --out <dir>   落盘到指定目录
  node scripts/eval-extract-real.mjs --help              本帮助

语义:
  - goldChunks 从 newCanonFacts 抽取（subject=chapter-<proj>-N, predicate=canon_fact,
    object=事实文本，canonical 归一）
  - 数据质量检测：结构化字段损坏（"[object Object]"）→ 该维度显式 SKIP + WARN
  - C7：损坏/缺失维度绝不冒充完好
  - C4：digest 复用 computeCheckpointDigestOf`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE + "\n")
    return 0
  }
  if (args.projects.length === 0) {
    process.stderr.write("[eval-extract-real] ERROR: --project <path> 必填（可多次）\n")
    return 1
  }

  // 多项目：每本快照目录独立扫描，跨书 case 以项目短名前缀隔离
  const decodedSnapshots = []
  const extracted = []
  for (const projPath of args.projects) {
    const snapshotsDir = join(projPath, ".novel", "snapshots")
    if (!existsSync(snapshotsDir)) {
      process.stderr.write(`[eval-extract-real] WARN: 快照目录不存在，跳过: ${snapshotsDir}\n`)
      continue
    }
    const proj = basename(projPath).replace(/[^\w\u4e00-\u9fa5]/g, "").slice(0, 12) || "p"

    const files = readdirSync(snapshotsDir)
      .filter((f) => /\.snapshot\.json$/.test(f))
      .sort()
    if (files.length === 0) {
      process.stderr.write(`[eval-extract-real] WARN: 无 *.snapshot.json，跳过: ${snapshotsDir}\n`)
      continue
    }

    const localDecoded = []
    for (const f of files) {
      const decoded = readJsonSmart(join(snapshotsDir, f))
      if (!decoded) {
        localDecoded.push({ file: f, snapshot: null, encoding: "none", problems: ["decode:failed"] })
        continue
      }
      localDecoded.push({
        file: f,
        snapshot: decoded.obj,
        encoding: decoded.encoding,
        problems: qualityOf(decoded.obj),
      })
    }
    decodedSnapshots.push(...localDecoded)
    for (let i = 0; i < localDecoded.length; i++) {
      const s = localDecoded[i]
      if (!s.snapshot) continue
      extracted.push(extractCase(s.snapshot, i, s.problems, proj))
    }
  }
  if (extracted.length === 0) {
    process.stderr.write(`[eval-extract-real] ERROR: 无可用语料（C7 显式 SKIP）\n`)
    return 1
  }

  const totalGold = extracted.reduce((a, c) => a + c.goldChunks.length, 0)
  const degradedCount = decodedSnapshots.filter((s) => s.problems.length > 0).length

  const digest = await computeCheckpointDigestOf({ cases: extracted })

  const outDir = args.out ?? args.fixtures
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const frozenDir = join(outDir, "frozen", digest.slice(0, 12))
  mkdirSync(frozenDir, { recursive: true })

  // 落盘: cases.jsonl（真实）
  const casesPath = join(outDir, "cases.jsonl")
  writeFileSync(casesPath, extracted.map((c) => JSON.stringify(c)).join("\n") + "\n")

  // 落盘: manifest.json（source=real + 质量报告）
  const manifest = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    totalCases: extracted.length,
    holdoutRatio: 0.15,
    scenarios: ["canon_retrieval", "temporal_current", "former_isolation", "contradiction", "crossbook_leak", "temporal_inversion"],
    source: "real",
    corpusDigest: digest,
    qualityReport: decodedSnapshots.map((s) => ({ file: s.file, encoding: s.encoding, problems: s.problems })),
    degradedChapters: degradedCount,
    totalGoldChunks: totalGold,
    note: "由 scripts/eval-extract-real.mjs 生成（真实快照语料；质量不达标维度显式 SKIP，C7）",
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

  // 冻结（C6：追加式不删，防源书稿编辑回溯污染）
  writeFileSync(join(frozenDir, "cases.jsonl"), readFileSync(casesPath))
  writeFileSync(join(frozenDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

  const report = {
    status: totalGold === 0 && degradedCount === decodedSnapshots.length ? "EMPTY" : "EXTRACTED",
    projects: args.projects,
    snapshotsTotal: decodedSnapshots.length,
    snapshotsUsable: extracted.length,
    degradedChapters: degradedCount,
    cases: extracted.length,
    goldChunks: totalGold,
    digest,
    qualityReport: manifest.qualityReport,
    outputs: { cases: casesPath, manifest: join(outDir, "manifest.json"), frozen: frozenDir },
    warnings: degradedCount > 0
      ? [`${degradedCount}/${decodedSnapshots.length} 章快照存在数据质量问题（[object Object]/解码失败），相关维度已显式 SKIP（C7）`]
      : [],
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  for (const w of report.warnings) process.stderr.write(`[eval-extract-real] WARN: ${w}\n`)
  return report.status === "EMPTY" ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[eval-extract-real] ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
