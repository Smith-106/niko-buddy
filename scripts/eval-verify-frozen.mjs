/**
 * eval-verify-frozen.mjs — 冻结语料只读校验（不写盘、不修改任何状态）。
 *
 * 作用：对 `src/lib/novel/eval/fixtures/frozen/<digest>/` 下的每个冻结快照，
 * 用与 `scripts/eval-extract-real.mjs` 完全相同的归一化原语
 * `computeCheckpointDigestOf({ cases })` 重算 corpusDigest，并校验：
 *   1. 重算 digest === manifest.json 记录的 `corpusDigest`；
 *   2. 冻结目录名（取 digest 前 12 位）=== 重算 digest 前 12 位
 *      === manifest.corpusDigest 前 12 位。
 *
 * 三处一致 → 该冻结快照 PASS；任一不一致 → FAIL（并列出差异）。
 *
 * 设计约束（P1 #17）：
 *   - 只读：仅读取 fixtures，绝不 writeFileSync / mkdirSync。
 *   - 复用 computeCheckpointDigestOf（C4 单一幂等原语，归一化），不另起一套 hashing。
 *   - 不修改 package.json（另一 agent 占用 npm 操作）。手动运行命令见报告。
 *
 * 手动运行（与 eval:baseline 同一 .ts 加载机制，Node 24 原生 strip-types）：
 *   node scripts/eval-verify-frozen.mjs
 *   node scripts/eval-verify-frozen.mjs --frozen <绝对或相对 frozen 根目录>
 *
 * 退出码：全部 PASS=0；存在 FAIL=1；无冻结目录=2。
 *
 * MIT License — independently implemented (read-only verification).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { computeCheckpointDigestOf } from "../src/lib/novel/checkpoint-digest.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 解析 --frozen <path> 参数（可选，覆盖默认 fixtures/frozen 根）。 */
function resolveFrozenRoot() {
  const idx = process.argv.indexOf("--frozen")
  if (idx !== -1 && process.argv[idx + 1]) {
    return resolve(process.cwd(), process.argv[idx + 1])
  }
  return resolve(__dirname, "../src/lib/novel/eval/fixtures/frozen")
}

function loadCases(frozenDir) {
  const casesPath = join(frozenDir, "cases.jsonl")
  if (!existsSync(casesPath)) return null
  const raw = readFileSync(casesPath, "utf-8")
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

async function verdictOf(frozenDir, manifest, cases) {
  const dirName = frozenDir.split(/[\\/]/).pop() || ""
  const checks = []
  let ok = true

  if (cases === null) {
    return { dirName, ok: false, checks: [{ label: "cases.jsonl 存在", pass: false, detail: "缺失" }] }
  }

  // 重算 corpusDigest（与 eval-extract-real 同形：computeCheckpointDigestOf({ cases })）
  let computed = ""
  let computeErr = ""
  try {
    computed = await computeCheckpointDigestOf({ cases })
  } catch (e) {
    computeErr = String(e && e.message ? e.message : e)
  }

  if (computeErr) {
    return { dirName, ok: false, checks: [{ label: "重算 digest", pass: false, detail: computeErr }] }
  }

  const manifestDigest = manifest.corpusDigest || ""
  const computed12 = computed.slice(0, 12)
  const manifest12 = manifestDigest.slice(0, 12)

  // ① manifest.corpusDigest 与重算一致
  const c1 = computed === manifestDigest
  checks.push({
    label: "manifest.corpusDigest === 重算 digest",
    pass: c1,
    detail: c1 ? computed : `manifest=${manifestDigest}\n      重算  =${computed}`,
  })
  ok = ok && c1

  // ② 目录名 === 重算 digest 前 12 位
  const c2 = dirName === computed12
  checks.push({
    label: "冻结目录名 === 重算 digest[:12]",
    pass: c2,
    detail: c2 ? dirName : `dir=${dirName}  computed12=${computed12}`,
  })
  ok = ok && c2

  // ③ 目录名 === manifest.corpusDigest 前 12 位（三方一致闭环）
  const c3 = dirName === manifest12
  checks.push({
    label: "冻结目录名 === manifest.corpusDigest[:12]",
    pass: c3,
    detail: c3 ? dirName : `dir=${dirName}  manifest12=${manifest12}`,
  })
  ok = ok && c3

  return { dirName, ok, checks, computed, manifestDigest }
}

async function main() {
  const frozenRoot = resolveFrozenRoot()
  if (!existsSync(frozenRoot)) {
    process.stderr.write(`[verify-frozen] 未找到冻结根目录：${frozenRoot}\n`)
    process.stdout.write("RESULT: NO_FROZEN_DIR\n")
    process.exit(2)
  }

  const dirs = readdirSync(frozenRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  if (dirs.length === 0) {
    process.stderr.write(`[verify-frozen] 冻结根目录无子目录：${frozenRoot}\n`)
    process.stdout.write("RESULT: NO_FROZEN_DIR\n")
    process.exit(2)
  }

  process.stderr.write(`[verify-frozen] frozenRoot=${frozenRoot} 发现 ${dirs.length} 个冻结快照\n`)

  let allPass = true
  const reports = []

  for (const dir of dirs) {
    const frozenDir = join(frozenRoot, dir)
    const manifestPath = join(frozenDir, "manifest.json")
    if (!existsSync(manifestPath)) {
      allPass = false
      reports.push({ dir, ok: false, reason: "manifest.json 缺失" })
      continue
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    const cases = loadCases(frozenDir)
    const r = await verdictOf(frozenDir, manifest, cases)
    if (!r.ok) allPass = false
    reports.push(r)
  }

  // 文本摘要到 stdout（机器可解析：RESULT / DIR / CHECK）
  for (const r of reports) {
    if (r.reason) {
      process.stdout.write(`DIR: ${r.dir}  RESULT: FAIL  (${r.reason})\n`)
      continue
    }
    const status = r.ok ? "PASS" : "FAIL"
    process.stdout.write(`DIR: ${r.dirName}  RESULT: ${status}\n`)
    for (const c of r.checks) {
      process.stdout.write(`  CHECK[${c.pass ? "PASS" : "FAIL"}] ${c.label}\n`)
      if (!c.pass) process.stdout.write(`         ${c.detail.replace(/\n/g, "\n         ")}\n`)
    }
  }

  process.stdout.write(`RESULT: ${allPass ? "PASS" : "FAIL"}  (snapshots=${reports.length})\n`)
  process.exit(allPass ? 0 : 1)
}

main()
