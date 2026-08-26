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
 *   3. poisonChunks: crossbook_leak 毒丸（两阶段装配）：caseIndex % 7 === 3 的 case
 *      标注 crossbook_leak，从「他书」factPool 以 chapterNumber 为偏移确定性轮转取
 *      1 条真实事实构造毒丸（expectedLanding=excluded）；与宿主 gold 归一冲突时跳过
 *      （最多 3 次尝试），不足则保留场景标注但 poison 为空。
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

/**
 * 从快照抽取 EvalCase（真实 gold）。proj 为项目短名（跨书隔离）。
 * scenario: 场景标注（canon_retrieval / crossbook_leak）。crossbook 毒丸由 main()
 * 第二轮装配后回填 poisonChunks（此处初始为空）。
 */
function extractCase(snapshot, chapterIndex, problems, proj, scenario) {
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
    scenario,
  }
}

/**
 * crossbook_leak 毒丸装配（镜像 eval-corpus-synth.ts 的 crossbook_leak case 形态）：
 *   - 只从「他书」factPool 取事实（宿主项目自身池不参与，源项目按扫描顺序轮转）；
 *   - 项目/事实轮转均以宿主 case 的 chapterNumber 作偏移：
 *     srcProj = otherProjOrder[(chapter + attempt) % len]，
 *     idx     = (chapter + attempt) % pool.length；
 *   - 去重护栏：候选事实 canonicalName 归一后与宿主 case 全部 goldChunks.object 相等
 *     → 换下一条（最多尝试 3 条）；仍无可用候选返回 null（调用方保留 scenario 标注，
 *     poisonChunks 为空）。
 * poisonSeq.n 为全局毒丸序号（id 跨 case 唯一，全流程确定性）。
 */
function pickCrossbookPoison(caseItem, factPool, factSourceChapters, otherProjOrder, poisonSeq) {
  const others = otherProjOrder.filter((pj) => pj !== caseItem.project) // 「他书」：排除宿主自身
  if (others.length === 0) return null
  const base = caseItem.chapter
  for (let attempt = 0; attempt < 3; attempt++) {
    const srcProj = others[(base + attempt) % others.length]
    const pool = factPool.get(srcProj)
    const chapters = factSourceChapters.get(srcProj)
    if (!pool || pool.length === 0 || !chapters) continue
    const idx = (base + attempt) % pool.length
    const norm = canonicalName(pool[idx])
    if (caseItem.goldChunks.some((g) => g.object === norm)) continue // 去重护栏
    return {
      id: `real-${caseItem.project}-p-${poisonSeq.n++}`,
      subject: `chapter-${srcProj}-${chapters[idx]}`,
      predicate: "canon_fact",
      object: norm,
      poisonType: "crossbook_leak",
      expectedLanding: "excluded",
    }
  }
  return null
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
  - 场景装配：caseIndex%7===3 的 case 标注 crossbook_leak，从他书 factPool 确定性轮转注入 1 条毒丸（无随机；相位 3 与 holdout 步长 7 的 0 余类不同余，避免全部被抽入 holdout）
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

  // —— 第一轮：全项目扫描 + factPool 收集（两阶段：先集齐他书事实池，再逐 case 装配）——
  // factPool: Map<proj, string[]>（仅无 quality 问题的快照贡献事实：typeof==='string' 且非空）
  // factSourceChapters: Map<proj, number[]>（与 factPool 平行，记录每条事实的源章号，供 subject 用）
  const decodedSnapshots = []
  const caseSeeds = []
  const factPool = new Map()
  const factSourceChapters = new Map()
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
      caseSeeds.push({ snapshot: s.snapshot, chapterIndex: i, problems: s.problems, proj })
      // factPool 仅采纳无 quality 问题的章（degraded 章不贡献跨书事实池）
      if (s.problems.length === 0) {
        const chapterNumber = s.snapshot.chapterNumber ?? i + 1
        const facts = (s.snapshot.newCanonFacts || [])
          .filter((f) => typeof f === "string" && f.trim().length > 0)
        if (facts.length === 0) continue
        const pool = factPool.get(proj) ?? []
        const chapters = factSourceChapters.get(proj) ?? []
        for (const f of facts) {
          pool.push(f)
          chapters.push(chapterNumber)
        }
        factPool.set(proj, pool)
        factSourceChapters.set(proj, chapters)
      }
    }
  }
  if (caseSeeds.length === 0) {
    process.stderr.write(`[eval-extract-real] ERROR: 无可用语料（C7 显式 SKIP）\n`)
    return 1
  }

  // —— 第二轮：逐 case 场景标注 + crossbook_leak 毒丸装配（确定性，无随机）——
  // caseIndex % 7 === 3 → crossbook_leak（相位与 holdout 步长 7 的 0 余类不同余，毒丸留在 train）；其余 → canon_retrieval。
  // 毒丸装配必须在 holdout 分层之前完成（分层作用于完整 extracted 数组）。
  const otherProjOrder = [...factPool.keys()] // 项目扫描顺序 = 轮转基准（装配时排除宿主自身）
  const poisonSeq = { n: 0 }
  const extracted = []
  for (let ci = 0; ci < caseSeeds.length; ci++) {
    const seed = caseSeeds[ci]
    const scenario = ci % 7 === 3 ? "crossbook_leak" : "canon_retrieval"
    const c = extractCase(seed.snapshot, seed.chapterIndex, seed.problems, seed.proj, scenario)
    if (scenario === "crossbook_leak") {
      const poison = pickCrossbookPoison(c, factPool, factSourceChapters, otherProjOrder, poisonSeq)
      if (poison) c.poisonChunks.push(poison)
    }
    extracted.push(c)
  }

  const totalGold = extracted.reduce((a, c) => a + c.goldChunks.length, 0)
  const degradedCount = decodedSnapshots.filter((s) => s.problems.length > 0).length

  // holdout 分层（C8）：从提取 case 中按固定步长抽出 holdout（不参与日常基线训练集）
  const HOLD_OUT_COUNT = Number(process.env.EVAL_HOLDOUT_COUNT || 30)
  const holdoutCases = []
  let trainCases = extracted
  if (HOLD_OUT_COUNT > 0 && extracted.length > HOLD_OUT_COUNT) {
    const step = Math.floor(extracted.length / HOLD_OUT_COUNT)
    const idx = new Set()
    for (let i = 0; i < HOLD_OUT_COUNT; i++) idx.add(i * step)
    holdoutCases.push(...extracted.filter((_, i) => idx.has(i)))
    trainCases = extracted.filter((_, i) => !idx.has(i))
  }

  const digest = await computeCheckpointDigestOf({ cases: trainCases })

  const outDir = args.out ?? args.fixtures
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const frozenDir = join(outDir, "frozen", digest.slice(0, 12))
  mkdirSync(frozenDir, { recursive: true })

  // 落盘: cases.jsonl（真实，训练集=全量-holdout）
  const casesPath = join(outDir, "cases.jsonl")
  writeFileSync(casesPath, trainCases.map((c) => JSON.stringify(c)).join("\n") + "\n")

  // 落盘: holdout.jsonl（C8：分层留出，不参与日常基线）
  const holdoutPath = join(outDir, "holdout.jsonl")
  writeFileSync(holdoutPath, holdoutCases.map((c) => JSON.stringify(c)).join("\n") + (holdoutCases.length ? "\n" : ""))

  // 落盘: manifest.json（source=real + 质量报告）
  const manifest = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    totalCases: trainCases.length,
    holdoutCount: holdoutCases.length,
    holdoutRatio: 0.15,
    scenarios: ["canon_retrieval", "temporal_current", "former_isolation", "contradiction", "crossbook_leak", "temporal_inversion"],
    source: "real",
    corpusDigest: digest,
    qualityReport: decodedSnapshots.map((s) => ({ file: s.file, encoding: s.encoding, problems: s.problems })),
    degradedChapters: degradedCount,
    totalGoldChunks: totalGold,
    note: "由 scripts/eval-extract-real.mjs 生成（真实快照语料；质量不达标维度显式 SKIP，C7）。crossbook 装配：caseIndex%7===3 的 case 标注 crossbook_leak（相位与 holdout 步长 7 的 0 余类不同余），从他书 factPool 以 chapterNumber 为偏移确定性轮转取 1 条毒丸（expectedLanding=excluded，subject=chapter-<他书>-<源章号>）；与宿主 goldChunks 归一冲突时跳过（最多 3 次尝试），不足则保留场景标注且 poison 为空。",
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

  // 冻结（C6：追加式不删，防源书稿编辑回溯污染）
  writeFileSync(join(frozenDir, "cases.jsonl"), readFileSync(casesPath))
  writeFileSync(join(frozenDir, "holdout.jsonl"), readFileSync(holdoutPath))
  writeFileSync(join(frozenDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

  const report = {
    status: totalGold === 0 && degradedCount === decodedSnapshots.length ? "EMPTY" : "EXTRACTED",
    projects: args.projects,
    snapshotsTotal: decodedSnapshots.length,
    snapshotsUsable: extracted.length,
    degradedChapters: degradedCount,
    cases: trainCases.length,
    holdoutCases: holdoutCases.length,
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
