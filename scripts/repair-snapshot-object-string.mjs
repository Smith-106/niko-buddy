#!/usr/bin/env node
/**
 * repair-snapshot-object-string.mjs — 修复 8人 快照 "[object Object]" 字段损坏。
 *
 * 根因（三模型共识，源码级锁定）: formal-llm-chapter-extract.mjs normalizeSnapshot()
 * 中 `const arr = (v) => (Array.isArray(v) ? v.map(String) : [])` 将 LLM 返回的对象
 * 数组逐项 String() → "[object Object]"，写盘前信息即丢失（不可恢复）。
 *
 * 修复裁决（三路一致）：❌ 种子全量覆盖（facts 80→29 数据销毁）→ ✅ 字段级逐章
 * 逐字段条件合并：
 *   - 文本字段（newCanonFacts/events/characterStateChanges/knowledgeChanges/
 *     foreshadowingChanges/conflicts/summary/endingHook/relationshipChanges）零改动；
 *   - 对象字段（characters/locations/organizations/items/timelineEvents/graphNodes/
 *     graphEdges）：字段级损坏检测（含任一 "[object Object]"）→ 仅该字段从种子同名
 *     数组回填（元素级：主版好元素保留 + 种子名称去重补足）；主版完好字段字节级保留；
 *   - graphEdges 种子全空（不可恢复）→ 留空 + extractMeta.repair.gaps 标记（C7 不冒充）；
 *   - 校验断言全绿才写盘；先落 staging 目录，--apply 时备份原件到 _backup-pre-repair-<ts>。
 *
 * 用法:
 *   node scripts/repair-snapshot-object-string.mjs --project <path>            # dry-run 到 staging
 *   node scripts/repair-snapshot-object-string.mjs --project <path> --apply     # 备份原件 + 原子写入
 *   node scripts/repair-snapshot-object-string.mjs --project <path> --rollback  # 从备份还原
 *   node scripts/repair-snapshot-object-string.mjs --help
 *
 * 退出码: 0 = 成功（dry-run/apply/rollback）；1 = 校验失败/硬错误。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** 文本字段（零改动，T0 保护）。ch002 events 实测损坏（LLM 返回对象），故 events 归对象字段类。 */
const TEXT_FIELDS = [
  "summary", "characterStateChanges", "relationshipChanges",
  "knowledgeChanges", "foreshadowingChanges", "newCanonFacts", "conflicts",
  "endingHook", "chapterTitle", "characterAliases",
]
/** 对象字段（损坏时回填；events 亦可能被 map(String) 损坏，随同处理）。 */
const OBJ_FIELDS = [
  "events", "characters", "locations", "organizations", "items",
  "timelineEvents", "graphNodes", "graphEdges",
]
const BAD = "[object Object]"

const isBadElement = (e) => typeof e === "string" && e === BAD
const fieldBad = (arr) => Array.isArray(arr) && arr.some(isBadElement)

function parseArgs(argv) {
  const args = { project: null, apply: false, rollback: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--project") args.project = argv[++i]
    else if (a === "--apply") args.apply = true
    else if (a === "--rollback") args.rollback = true
    else if (a === "--help" || a === "-h") args.help = true
    else {
      process.stderr.write(`[repair] unknown arg: ${a}\n`)
      args.help = true
    }
  }
  return args
}

/** 读 JSON；解析失败抛错。 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** 字段级合并：主版坏 → 种子名称 + 主版好元素（去重保序）；主版好 → 原样。 */
function repairField(mainArr, seedArr) {
  if (!Array.isArray(mainArr)) return mainArr
  if (!fieldBad(mainArr)) return mainArr // 字节级保留
  const seedNames = Array.isArray(seedArr) ? seedArr.map(String).map((x) => x.trim()).filter(Boolean) : []
  const goodMain = mainArr.filter((e) => !isBadElement(e)).map(String).map((x) => x.trim()).filter(Boolean)
  const seen = new Set()
  const out = []
  for (const n of [...seedNames, ...goodMain]) {
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

/** 逐章修复：主快照 + 种子 → 修复件 + 报告。 */
function repairChapter(mainPath, seedPath, ch) {
  const main = readJson(mainPath)
  const seed = seedPath && existsSync(seedPath) ? readJson(seedPath) : null
  const out = { ...main }
  const repaired = []
  const gaps = []

  for (const f of TEXT_FIELDS) {
    if (main[f] !== undefined) out[f] = main[f] // 显式保留（防御：拷贝语义）
  }
  for (const f of OBJ_FIELDS) {
    const original = main[f]
    if (!Array.isArray(original)) continue
    if (!fieldBad(original)) {
      out[f] = original // 字节级完好
      continue
    }
    const recovered = seed ? repairField(original, seed[f], f) : []
    out[f] = recovered
    repaired.push(f)
    if (recovered.length === 0 && original.length > 0) {
      gaps.push(`${f}:empty-after-recovery`)
    }
  }

  // 修订标记（追加语义，不覆盖 snapshotId 原值）
  out.revision = (main.revision ?? 0) + 1
  out.extractMeta = {
    ...(main.extractMeta ?? {}),
    repair: {
      at: new Date().toISOString(),
      strategy: "field-merge-from-seed",
      fieldsRepaired: repaired,
      gaps,
      seedBackupDir: basename(dirname(seedPath ?? "")) || "none",
    },
  }

  return { out, repaired, gaps, factsBefore: main.newCanonFacts?.length ?? 0, factsAfter: out.newCanonFacts?.length ?? 0 }
}

/** 校验断言：全绿返回 []；否则返回错误列表。 */
function validateChapter(repair) {
  const errors = []
  for (const f of OBJ_FIELDS) {
    const v = repair.out[f]
    if (Array.isArray(v) && v.some(isBadElement)) errors.push(`${f}: 残留 [object Object]`)
  }
  if (repair.factsAfter < repair.factsBefore) {
    errors.push(`newCanonFacts 减少: ${repair.factsBefore} -> ${repair.factsAfter}`)
  }
  try {
    JSON.parse(JSON.stringify(repair.out))
  } catch {
    errors.push("输出非法 JSON")
  }
  return errors
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`repair-snapshot-object-string.mjs — 修复快照 [object Object] 损坏

用法:
  node scripts/repair-snapshot-object-string.mjs --project <path>             dry-run → _repair-staging-<ts>/
  node scripts/repair-snapshot-object-string.mjs --project <path> --apply     备份原件 + 写回 .novel/snapshots/
  node scripts/repair-snapshot-object-string.mjs --project <path> --rollback  从 _backup-pre-repair-<ts>/ 还原
  node scripts/repair-snapshot-object-string.mjs --help
`)
    return 0
  }
  if (!args.project) {
    process.stderr.write("[repair] ERROR: --project <path> 必填\n")
    return 1
  }
  const snapDir = join(args.project, ".novel", "snapshots")
  if (!existsSync(snapDir)) {
    process.stderr.write(`[repair] ERROR: 快照目录不存在: ${snapDir}\n`)
    return 1
  }

  // 种子目录探测：_backup-seed-* 取最新
  const seedDirs = readdirSync(snapDir).filter((d) => /^_backup-seed-/.test(d)).sort()
  if (seedDirs.length === 0) {
    process.stderr.write("[repair] ERROR: 无 _backup-seed-* 种子目录\n")
    return 1
  }
  const seedDir = join(snapDir, seedDirs[seedDirs.length - 1])
  const ts = timestamp()

  // --- rollback 路径 ---
  if (args.rollback) {
    const backups = readdirSync(snapDir).filter((d) => /^_backup-pre-repair-/.test(d)).sort()
    if (backups.length === 0) {
      process.stderr.write("[repair] ERROR: 无 _backup-pre-repair-* 备份可还原\n")
      return 1
    }
    const b = join(snapDir, backups[backups.length - 1])
    for (const f of readdirSync(b)) {
      if (/\.snapshot\.json$/.test(f)) {
        cpSync(join(b, f), join(snapDir, f))
      }
    }
    process.stdout.write(`[repair] rollback OK from ${backups[backups.length - 1]}\n`)
    return 0
  }

  // --- 逐章修复 ---
  const mainFiles = readdirSync(snapDir).filter((f) => /^\d{3}\.snapshot\.json$/.test(f)).sort()
  if (mainFiles.length === 0) {
    process.stderr.write("[repair] ERROR: 无主快照（NNN.snapshot.json）\n")
    return 1
  }

  const staging = join(snapDir, `_repair-staging-${ts}`)
  mkdirSync(staging, { recursive: true })
  const report = { at: new Date().toISOString(), seedDir, chapters: [], pass: true }
  const allErrors = []

  for (const f of mainFiles) {
    const ch = f.slice(0, 3)
    const seedPath = join(seedDir, f)
    const repair = repairChapter(join(snapDir, f), seedPath, ch)
    const errors = validateChapter(repair)
    report.chapters.push({
      chapter: ch,
      fieldsRepaired: repair.repaired,
      gaps: repair.gaps,
      facts: { before: repair.factsBefore, after: repair.factsAfter },
      errors,
    })
    if (errors.length > 0) {
      allErrors.push(...errors.map((e) => `${ch}: ${e}`))
      report.pass = false
      continue
    }
    writeFileSync(join(staging, f), JSON.stringify(repair.out, null, 2) + "\n")
  }

  if (allErrors.length > 0) {
    for (const e of allErrors) process.stderr.write(`[repair] ERROR: ${e}\n`)
    process.stderr.write("[repair] 校验失败：修复件保留于 staging（未写回主目录）\n")
    report.pass = false
  }
  writeFileSync(join(staging, "repair-report.json"), JSON.stringify(report, null, 2) + "\n")
  process.stdout.write(`[repair] dry-run 完成：${mainFiles.length} 章 → staging ${staging}\n`)

  // --- apply 路径 ---
  if (args.apply && report.pass) {
    const backupDir = join(snapDir, `_backup-pre-repair-${ts}`)
    mkdirSync(backupDir, { recursive: true })
    for (const f of mainFiles) {
      cpSync(join(snapDir, f), join(backupDir, f))
    }
    for (const f of readdirSync(staging)) {
      if (/\.snapshot\.json$/.test(f)) {
        cpSync(join(staging, f), join(snapDir, f))
      }
    }
    process.stdout.write(`[repair] applied: 备份=${backupDir} 写回=${mainFiles.length} 章\n`)
  } else if (args.apply && !report.pass) {
    process.stderr.write("[repair] 校验失败，未写回主目录（防损坏扩散）\n")
    return 1
  } else {
    process.stdout.write("[repair] dry-run：未写回（使用 --apply 生效）\n")
  }
  return allErrors.length > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[repair] ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
