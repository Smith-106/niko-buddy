#!/usr/bin/env node
/**
 * check-release-cadence.mjs — 发布渠道与节奏机械检查（RELEASING「节奏审计」G5 的可执行化）
 *
 * 设计口径：
 *   - **门禁只判「被审版本」**（默认 Latest，可用 --tag 指定），不回头重判历史。
 *     历史违规以 INFO 汇总输出，供审计可见，不影响退出码。
 *   - 被审版本的三条节奏规则（stable = 非 prerelease 且非 draft）：
 *       weekly-stable       同 ISO 周（周一为周首，本机时区）stable ≤ 1
 *       same-day-duplicate  同日 stable = 0
 *       thirty-day-stable   被审版本发布时间往前推 30 天内 stable ≤ 4
 *   - 资产：latest.json + 安装包 *.exe 必有同名 .sig；*_portable.exe 按设计无 sig。
 *   - 主干：被审版本 tag 必须是 smith/master 祖先（本地无 tag 则 WARN）。
 *   - 豁免：release-cadence-exemptions.json 登记且 scope 覆盖该规则的 tag 判通过，
 *     并打印豁免依据（RELEASING 要求用户明确批准 + 理由 + 范围）。
 *
 * 用法：node scripts/check-release-cadence.mjs [--repo <owner/name>] [--tag <tag>] [--json]
 * 退出码：0 = 通过（含豁免）；1 = 有违规；2 = 环境不可用（gh / git 失败）
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_REPO = "Smith-106/niko-buddy"
const EXEMPTIONS_PATH = join(ROOT, "release-cadence-exemptions.json")
const DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAY_LIMIT = 4

/** 本机时区下的 YYYY-MM-DD。 */
export function localDay(iso) {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, "0")
  const day = `${d.getDate()}`.padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** 本机时区下 ISO 周键（周一为周首）：返回该周周一的 YYYY-MM-DD。 */
export function isoWeekKey(iso) {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7 // 周一=0
  d.setDate(d.getDate() - dow)
  return localDay(d.toISOString())
}

/** releases → stable 列表（发布时间升序）。 */
export function stableReleases(releases) {
  return releases
    .filter((r) => r && !r.isPrerelease && !r.isDraft && r.publishedAt)
    .slice()
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))
}

export function readExemptions(path = EXEMPTIONS_PATH) {
  if (!existsSync(path)) return { exemptions: [] }
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  return { exemptions: Array.isArray(parsed.exemptions) ? parsed.exemptions : [] }
}

export function exemptionFor(exemptions, tag, rule) {
  return exemptions.find((e) => e && e.tag === tag && (!e.scope || e.scope.includes(rule)))
}

/**
 * 纯函数：只判定被审版本 targetTag 自身是否违反节奏。
 * @returns {{tag: string, rules: Array<{rule:string,detail:string,exempted?:boolean,reason?:string,approvedAt?:string}>}}
 */
export function evaluateTarget(releases, targetTag, exemptions = []) {
  const stables = stableReleases(releases)
  const target = stables.find((r) => r.tagName === targetTag)
  if (!target) return { tag: targetTag, rules: [], missing: true }

  const at = new Date(target.publishedAt)
  const rules = []
  const push = (rule, detail) => {
    const ex = exemptionFor(exemptions, targetTag, rule)
    rules.push(ex ? { rule, detail, exempted: true, reason: ex.reason, approvedAt: ex.approvedAt } : { rule, detail })
  }

  const week = isoWeekKey(target.publishedAt)
  const sameWeek = stables.filter((r) => isoWeekKey(r.publishedAt) === week)
  if (sameWeek.length > 1) {
    push("weekly-stable", `ISO 周 ${week} 有 ${sameWeek.length} 个 stable：${sameWeek.map((r) => r.tagName).join(", ")}`)
  }

  const day = localDay(target.publishedAt)
  const sameDay = stables.filter((r) => localDay(r.publishedAt) === day)
  if (sameDay.length > 1) {
    push("same-day-duplicate", `${day} 有 ${sameDay.length} 个 stable：${sameDay.map((r) => r.tagName).join(", ")}`)
  }

  const windowStart = new Date(at.getTime() - 30 * DAY_MS)
  const inWindow = stables.filter((r) => {
    const t = new Date(r.publishedAt)
    return t >= windowStart && t <= at
  })
  if (inWindow.length > THIRTY_DAY_LIMIT) {
    push("thirty-day-stable", `发布前 30 天 stable ${inWindow.length} 个（上限 ${THIRTY_DAY_LIMIT}）：${inWindow.map((r) => r.tagName).join(", ")}`)
  }

  return { tag: targetTag, rules }
}

/** 全体历史审计（INFO，不影响退出码）。 */
export function auditHistory(releases) {
  const stables = stableReleases(releases)
  const byWeek = new Map()
  const byDay = new Map()
  for (const r of stables) {
    const w = isoWeekKey(r.publishedAt)
    const d = localDay(r.publishedAt)
    byWeek.set(w, (byWeek.get(w) ?? 0) + 1)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  return {
    stableTotal: stables.length,
    weeks: [...byWeek.values()].filter((n) => n > 1).length,
    days: [...byDay.values()].filter((n) => n > 1).length,
    recent: stables.slice(-3).map((r) => `${r.tagName}@${localDay(r.publishedAt)}`),
  }
}

/**
 * 资产完整性：latest.json + 安装包 exe 同名 sig（portable 按设计无 sig）。
 * 审 Latest 时 prerelease 标记本身是问题（Latest 槽位不应指向内测版）；
 * 用 --tag 显式审某个 prerelease 时传 allowPrerelease，只查资产与 draft。
 */
export function evaluateLatestAssets(latest, assetNames, { allowPrerelease = false } = {}) {
  const problems = []
  if (!latest) return ["找不到被审 release"]
  if (latest.isPrerelease && !allowPrerelease) problems.push("被审 release 标记为 prerelease")
  if (latest.isDraft) problems.push("被审 release 是 draft")
  const names = assetNames ?? []
  if (!names.includes("latest.json")) problems.push("缺 latest.json")
  const installers = names.filter((n) => n.endsWith(".exe") && !n.includes("_portable"))
  if (installers.length === 0) problems.push("缺安装包 .exe 资产")
  for (const exe of installers) {
    if (!names.includes(`${exe}.sig`)) problems.push(`缺 ${exe}.sig`)
  }
  return problems
}

/** 被审 tag 不占 Latest 槽位时，prerelease 标记不算资产问题。 */
export function allowsPrerelease(releases, targetTag) {
  return releases.find((r) => r.isLatest)?.tagName !== targetTag
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function parseArgs(argv) {
  const pick = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return { repo: pick("--repo") ?? DEFAULT_REPO, tag: pick("--tag"), json: argv.includes("--json") }
}

export function main(argv = process.argv.slice(2)) {
  const { repo, tag, json } = parseArgs(argv)
  let releases
  try {
    releases = JSON.parse(
      sh("gh", ["release", "list", "--repo", repo, "--limit", "400", "--json", "tagName,publishedAt,isDraft,isPrerelease,isLatest"]),
    )
  } catch (err) {
    console.error(`[cadence] 无法读取 release 列表（${repo}）：${err.message}`)
    return 2
  }

  const targetTag = tag ?? releases.find((r) => r.isLatest)?.tagName
  if (!targetTag) {
    console.error("[cadence] 找不到被审 release（无 Latest 且未指定 --tag）")
    return 2
  }
  const target = releases.find((r) => r.tagName === targetTag) ?? null
  const { exemptions } = readExemptions()
  const gate = evaluateTarget(releases, targetTag, exemptions)
  const history = auditHistory(releases)

  let assetProblems = []
  if (target) {
    try {
      const names = JSON.parse(sh("gh", ["release", "view", targetTag, "--repo", repo, "--json", "assets"])).assets.map((a) => a.name)
      assetProblems = evaluateLatestAssets(target, names, { allowPrerelease: allowsPrerelease(releases, targetTag) })
    } catch (err) {
      assetProblems = [`资产读取失败：${err.message}`]
    }
  }

  const trunkWarnings = []
  let trunkFailed = null
  try {
    sh("git", ["rev-parse", "--verify", `refs/tags/${targetTag}`])
    try {
      sh("git", ["merge-base", "--is-ancestor", targetTag, "smith/master"])
    } catch {
      trunkFailed = `${targetTag} 不是 smith/master 的祖先（悬在旁支）`
    }
  } catch {
    trunkWarnings.push(`${targetTag}: 本地无此 tag，跳过主干校验`)
  }

  const real = gate.rules.filter((r) => !r.exempted)
  const exempted = gate.rules.filter((r) => r.exempted)
  const failed = real.length + assetProblems.length + (trunkFailed ? 1 : 0)

  if (json) {
    console.log(JSON.stringify({ repo, tag: targetTag, gate, history, assetProblems, trunkWarnings, trunkFailed }, null, 2))
  } else {
    console.log(`[cadence] 被审版本：${targetTag}${target ? `（${localDay(target.publishedAt)} 发布）` : "（不存在）"}`)
    console.log(
      `[cadence] INFO 历史：stable 共 ${history.stableTotal} 个，多 stable 周 ${history.weeks} 个、多 stable 日 ${history.days} 个（历史不参与门禁）`,
    )
    console.log(`[cadence] INFO 最近 stable：${history.recent.join(", ") || "无"}`)
    for (const r of exempted) console.log(`[cadence] EXEMPT ${r.rule} ${targetTag} -- ${r.reason ?? "已登记豁免"}（批准于 ${r.approvedAt ?? "?"}）`)
    for (const w of trunkWarnings) console.log(`[cadence] WARN ${w}`)
    for (const p of assetProblems) console.log(`[cadence] FAIL latest-assets ${targetTag} -- ${p}`)
    if (trunkFailed) console.log(`[cadence] FAIL trunk ${targetTag} -- ${trunkFailed}`)
    for (const r of real) console.log(`[cadence] FAIL ${r.rule} ${targetTag} -- ${r.detail}`)
    if (gate.missing) console.log(`[cadence] WARN ${targetTag} 不在 stable 列表中（prerelease 渠道不受节奏门约束）`)
  }

  console.log(
    failed === 0
      ? `[cadence] RESULT: PASS（${targetTag}，豁免 ${exempted.length} 项）`
      : `[cadence] RESULT: FAIL（${targetTag}，${failed} 项违规，其中 ${real.length} 项未豁免）`,
  )
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
