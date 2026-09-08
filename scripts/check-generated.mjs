#!/usr/bin/env node
/**
 * check-generated.mjs — 生成物闭环门禁 (P0 B3)
 *
 * 校验 QMAI 仓内 4 个 generated 产物的一致性，纯 Node stdlib，零依赖：
 *
 *   1. t2s-map.generated.ts            幂等可再生 → 临时路径重生成 + 字节比对（禁止全局 git diff）
 *   2. anti-ai-thresholds.generated.ts 与 docs/p2/anti-ai-thresholds.json 仓内源断言
 *                                      （该文件由 anti-ai-calibrate.js 标定产出，非纯再生成器；
 *                                       重跑标定会丢 selfRepetition 激活项，故不做字节重生成）
 *   3. kb-routing-view.generated.json  合法 JSON + builtFrom 存在性 + schemaVersion 期望集
 *                                      （独立判定，不依赖 hub reference/ 源）
 *   4. anti-ai-seeds.generated.json    合法 JSON + 顶层字段集 + samples 最小条数 + 条目字段集
 *
 * 实现纪律（R11 防御）：所有比较走「临时路径 + 字节比对」，禁止 git diff --exit-code。
 *
 * 用法：node scripts/check-generated.mjs
 * 输出：每项 PASS/FAIL + 总体结果；exit 0 = 全部通过，非 0 = 存在失败。
 * 输出纯 ASCII（子进程输出做 ASCII 消毒）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 子进程输出消毒为纯 ASCII（诊断信息可能含中文，门禁自身输出保持 ASCII）。 */
function toAscii(s) {
  return String(s ?? "").replace(/[^\x20-\x7e\n\r\t]/g, "?")
}

/** 输出用 ROOT 相对路径（仓内绝对路径可能含非 ASCII 目录名）。 */
function rel(p) {
  const r = String(p).replace(/\\/g, "/")
  const root = ROOT.replace(/\\/g, "/") + "/"
  return r.startsWith(root) ? r.slice(root.length) : toAscii(r)
}

/** 读取文件；缺失/不可读返回 null（区分于「内容为 null」的场景）。 */
function tryRead(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/**
 * 从 TS 源码提取 `export const <name> = { ... }` / `[ ... ]` 字面量文本。
 * 用括号深度扫描（感知字符串与转义），返回字面量原文本；找不到返回 null。
 */
function extractConstLiteral(src, constName) {
  const marker = `export const ${constName} = `
  const idx = src.indexOf(marker)
  if (idx < 0) return null
  const openIdx = src.indexOf("{", idx + marker.length)
  const arrIdx = src.indexOf("[", idx + marker.length)
  let start = -1
  if (openIdx < 0) start = arrIdx
  else if (arrIdx < 0) start = openIdx
  else start = Math.min(openIdx, arrIdx)
  if (start < 0) return null
  const openCh = src[start]
  const closeCh = openCh === "{" ? "}" : "]"
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 解析生成物里的对象字面量：生成器产物可能用未加引号的裸键（合法 TS，非 JSON），
 * 先直读，失败则把裸键补引号后重试。
 */
function parseConstLiteral(lit) {
  try {
    return JSON.parse(lit)
  } catch {
    const normalized = lit
      .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":') // 裸键补引号
      .replace(/,+\s*}/g, "}") // 去掉尾逗号（TS 合法，JSON 非法）
    return JSON.parse(normalized)
  }
}

/** 递归路径级 diff：返回 `path: expected=.. actual=..` 行；相等返回空数组。 */
function diffPaths(expected, actual, prefix = "") {
  const out = []
  const label = prefix || "(root)"
  if (typeof expected !== typeof actual) {
    out.push(`${label}: type expected=${typeof expected} actual=${typeof actual}`)
    return out
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual ?? {})])
    for (const k of keys) {
      out.push(...diffPaths(expected[k], actual?.[k], prefix ? `${prefix}.${k}` : k))
    }
    return out
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push(`${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
  }
  return out
}

/** 字节级首个差异位置（两个 Buffer）。 */
function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  if (a.length !== b.length) return n
  return -1
}

/** 结果注册表。 */
const RESULTS = []
function record(name, pass, detail) {
  RESULTS.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 检查 1：t2s-map.generated.ts — 临时路径重生成 + 字节比对
// ---------------------------------------------------------------------------

function checkT2sMap() {
  const genScript = join(ROOT, "scripts/gen-t2s-map.mjs")
  const committedPath = join(ROOT, "src/lib/novel/t2s-map.generated.ts")
  const genSrc = tryRead(genScript)
  if (genSrc === null) {
    record("t2s-map.generated.ts", false, `generator missing: ${rel(genScript)}`)
    return
  }
  if (!existsSync(committedPath)) {
    record("t2s-map.generated.ts", false, `artifact missing: ${rel(committedPath)}`)
    return
  }

  // 生成器不支持输出参数：把脚本复制到临时目录，改为
  //   a) 把 root 推导钉死为仓内 QMAI 根（临时脚本的 import.meta.url 会指向 %TEMP%，
  //      root 随之漂移到临时目录，导致 BASE/源表读取失败）
  //   b) 仅把 writeFileSync 目标改写为临时路径（BASE 自读仍指向仓内产物，
  //      与真实生成语义一致）
  // 再 spawn 临时副本。
  const rootLine = "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), \"..\")"
  const writeCall = 'path.join(root, "src/lib/novel/t2s-map.generated.ts"),'
  if (!genSrc.includes(rootLine) || !genSrc.includes(writeCall)) {
    record("t2s-map.generated.ts", false, "generator structure changed; check must be updated (fail-closed)")
    return
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "qmai-gencheck-"))
  try {
    const tmpOut = join(tmpDir, "t2s-map.generated.ts")
    const tmpScript = join(tmpDir, "gen-t2s-map.mjs")
    const patched = genSrc
      .replace(rootLine, `const root = ${JSON.stringify(ROOT)}`)
      .replace(writeCall, `${JSON.stringify(tmpOut)},`)
    writeFileSync(tmpScript, patched, "utf8")
    const r = spawnSync(process.execPath, [tmpScript], { encoding: "utf8", timeout: 120000 })
    if (r.status !== 0) {
      record(
        "t2s-map.generated.ts",
        false,
        `regeneration failed status=${r.status} stderr=${toAscii(r.stderr).slice(0, 500)}`,
      )
      return
    }
    if (!existsSync(tmpOut)) {
      record("t2s-map.generated.ts", false, "regeneration produced no temp output")
      return
    }
    const committed = readFileSync(committedPath)
    const fresh = readFileSync(tmpOut)
    const off = firstDiffOffset(committed, fresh)
    if (off < 0) {
      record("t2s-map.generated.ts", true, `byte-identical (${committed.length} bytes, idempotently reproducible)`)
      return
    }
    const ctx = (b, i) => {
      const s = b.slice(Math.max(0, i - 20), i + 40)
      return toAscii(s.toString("utf8")).replace(/\n/g, "\\n")
    }
    record(
      "t2s-map.generated.ts",
      false,
      `byte drift at offset ${off}: committed[..]=${ctx(committed, off)} fresh[..]=${ctx(fresh, off)}`,
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 检查 2：anti-ai-thresholds.generated.ts — 与 docs/p2 源 JSON 一致性断言
// ---------------------------------------------------------------------------

const KB_SCHEMA_VERSIONS = [2] // 与 src/lib/novel/kb-routing-view.spec.ts fixture 代际一致

function checkThresholds() {
  const jsonPath = join(ROOT, "docs/p2/anti-ai-thresholds.json")
  const tsPath = join(ROOT, "src/lib/novel/anti-ai-thresholds.generated.ts")
  let sourceJson
  try {
    sourceJson = JSON.parse(readFileSync(jsonPath, "utf8"))
  } catch (err) {
    record("anti-ai-thresholds.generated.ts", false, `source JSON invalid: ${rel(jsonPath)} (${toAscii(err.message)})`)
    return
  }
  const ts = tryRead(tsPath)
  if (ts === null) {
    record("anti-ai-thresholds.generated.ts", false, `artifact missing: ${rel(tsPath)}`)
    return
  }

  const problems = []
  const lit = extractConstLiteral(ts, "ANTI_AI_THRESHOLDS")
  if (lit === null) {
    problems.push("ANTI_AI_THRESHOLDS literal not found")
  } else {
    let parsed
    try {
      parsed = parseConstLiteral(lit)
    } catch (err) {
      problems.push(`ANTI_AI_THRESHOLDS is not a valid literal: ${toAscii(err.message)}`)
    }
    if (parsed !== undefined) {
      for (const d of diffPaths(sourceJson.thresholds, parsed)) problems.push(`thresholds.${d}`)
    }
  }

  const metaLit = extractConstLiteral(ts, "ANTI_AI_CALIBRATION_META")
  if (metaLit === null) {
    problems.push("ANTI_AI_CALIBRATION_META literal not found")
  } else {
    let meta
    try {
      meta = parseConstLiteral(metaLit)
    } catch (err) {
      problems.push(`ANTI_AI_CALIBRATION_META is not a valid literal: ${toAscii(err.message)}`)
    }
    if (meta) {
      const pairs = [
        ["corpusHash", meta.corpusHash, sourceJson.corpus?.hash],
        ["human", meta.human, sourceJson.corpus?.human],
        ["ai", meta.ai, sourceJson.corpus?.ai],
        ["gitCommit", meta.gitCommit, sourceJson.provenance?.gitCommit],
        ["date", meta.date, sourceJson.provenance?.date],
      ]
      for (const [k, got, want] of pairs) {
        if (got !== want) problems.push(`meta.${k}: expected=${JSON.stringify(want)} actual=${JSON.stringify(got)}`)
      }
    }
  }

  // 组合因子激活保护：ANTI_AI_COMBINED_FACTORS 含 selfRepetition 是 55 号设计的有意激活
  // （decision-log 20260904-55），重跑 anti-ai-calibrate.js 会丢失该激活（文件头注释明示），
  // 此断言防止标定重跑造成静默回退。
  const factorsLit = extractConstLiteral(ts, "ANTI_AI_COMBINED_FACTORS")
  if (factorsLit === null) {
    problems.push("ANTI_AI_COMBINED_FACTORS literal not found")
  } else {
    try {
      const factors = parseConstLiteral(factorsLit)
      if (!Array.isArray(factors)) problems.push("ANTI_AI_COMBINED_FACTORS is not an array")
      else if (!factors.includes("selfRepetition"))
        problems.push('ANTI_AI_COMBINED_FACTORS missing "selfRepetition" activation (guards against recalibration rollback)')
    } catch (err) {
      problems.push(`ANTI_AI_COMBINED_FACTORS is not a valid literal: ${toAscii(err.message)}`)
    }
  }

  record(
    "anti-ai-thresholds.generated.ts",
    problems.length === 0,
    problems.length === 0
      ? `consistent with ${rel(jsonPath)} (thresholds + calibration meta + combined-factors activation)`
      : problems.join(" | "),
  )
}

// ---------------------------------------------------------------------------
// 检查 3：kb-routing-view.generated.json — 独立结构判定（不依赖 hub 源）
// ---------------------------------------------------------------------------

function checkKbRoutingView() {
  const p = join(ROOT, "src/lib/novel/kb/kb-routing-view.generated.json")
  let view
  try {
    view = JSON.parse(readFileSync(p, "utf8"))
  } catch (err) {
    record("kb-routing-view.generated.json", false, `invalid JSON: ${rel(p)} (${toAscii(err.message)})`)
    return
  }
  const problems = []
  const bf = view?.builtFrom
  if (typeof bf !== "string" || bf.length === 0) {
    problems.push("builtFrom missing or not a non-empty string")
  } else if (!bf.startsWith("sha256:")) {
    problems.push(`builtFrom fingerprint format unexpected: ${bf.slice(0, 40)} (expects sha256: prefix)`)
  }
  const sv = view?.schemaVersion
  if (typeof sv !== "number" || !Number.isInteger(sv) || !KB_SCHEMA_VERSIONS.includes(sv)) {
    problems.push(`schemaVersion=${JSON.stringify(sv)} not in expected set ${JSON.stringify(KB_SCHEMA_VERSIONS)}`)
  }
  if (!view?.routing || typeof view.routing.agent !== "object" || view.routing.agent === null) {
    problems.push("routing.agent missing (consumer routing contract)")
  }
  if (!view?.collectionCounts || typeof view.collectionCounts !== "object") {
    problems.push("collectionCounts missing (consumer contract)")
  }
  record(
    "kb-routing-view.generated.json",
    problems.length === 0,
    problems.length === 0
      ? `valid JSON; builtFrom=${bf} schemaVersion=${sv} (standalone; no hub source dependency)`
      : problems.join(" | "),
  )
}

// ---------------------------------------------------------------------------
// 检查 4：anti-ai-seeds.generated.json — 结构完整性
// ---------------------------------------------------------------------------

const SEEDS_SCHEMA_VERSION = 1 // scripts/generate-anti-ai-corpus-bundle.mjs SCHEMA_VERSION
const SEEDS_MIN_SAMPLES = 60 // 当前仓内批 (20260821-001, human 30 + ai 30) 的expected最小count
const SEEDS_SAMPLE_FIELDS = ["file", "genre", "layer", "words", "text"]
const SEEDS_LAYERS = ["human", "ai"]

function checkSeeds() {
  const p = join(ROOT, "src/lib/novel/anti-ai-seeds.generated.json")
  let data
  try {
    data = JSON.parse(readFileSync(p, "utf8"))
  } catch (err) {
    record("anti-ai-seeds.generated.json", false, `invalid JSON: ${rel(p)} (${toAscii(err.message)})`)
    return
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    record("anti-ai-seeds.generated.json", false, `invalid top-level JSON structure: ${rel(p)}`)
    return
  }
  const problems = []
  for (const k of ["schemaVersion", "source", "batchIds", "generatedAt", "samples"]) {
    if (!(k in data)) problems.push(`missing top-level field ${k}`)
  }
  if (data.schemaVersion !== SEEDS_SCHEMA_VERSION) {
    problems.push(`schemaVersion=${JSON.stringify(data.schemaVersion)} expected ${SEEDS_SCHEMA_VERSION}`)
  }
  if (typeof data.source !== "string" || data.source.length === 0) problems.push("source missing or empty")
  if (!Array.isArray(data.batchIds) || data.batchIds.length === 0 || data.batchIds.some((b) => typeof b !== "string" || b.length === 0)) {
    problems.push("batchIds must be a non-empty string array")
  }
  if (typeof data.generatedAt !== "string" || data.generatedAt.length === 0) problems.push("generatedAt missing or empty")
  if (!Array.isArray(data.samples)) {
    problems.push("samples missing or not an array")
  } else {
    if (data.samples.length < SEEDS_MIN_SAMPLES) {
      problems.push(`samples count ${data.samples.length} < expected minimum ${SEEDS_MIN_SAMPLES}`)
    }
    for (let i = 0; i < data.samples.length; i++) {
      const s = data.samples[i]
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        problems.push(`samples[${i}] not an object`)
        continue
      }
      for (const f of SEEDS_SAMPLE_FIELDS) {
        if (!(f in s)) problems.push(`samples[${i}] missing field ${f}`)
      }
      if (!SEEDS_LAYERS.includes(s.layer)) problems.push(`samples[${i}].layer=${JSON.stringify(s.layer)} not in {${SEEDS_LAYERS.join(",")}}`)
      if (typeof s.words !== "number" || !(s.words > 0)) problems.push(`samples[${i}].words must be a positive number`)
      if (typeof s.text !== "string" || s.text.length === 0) problems.push(`samples[${i}].text missing or empty`)
    }
  }
  record(
    "anti-ai-seeds.generated.json",
    problems.length === 0,
    problems.length === 0
      ? `valid JSON; schemaVersion=${data.schemaVersion} samples=${data.samples.length} (>= ${SEEDS_MIN_SAMPLES})`
      : problems.join(" | "),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  checkT2sMap()
  checkThresholds()
  checkKbRoutingView()
  checkSeeds()

  for (const r of RESULTS) {
    const tag = r.pass ? "PASS" : "FAIL"
    process.stdout.write(`[gen:check] ${tag} ${r.name} -- ${r.detail}\n`)
  }
  const passed = RESULTS.filter((r) => r.pass).length
  const total = RESULTS.length
  process.stdout.write(`[gen:check] RESULT: ${passed}/${total} passed\n`)
  process.exitCode = passed === total ? 0 : 1
}

main()
