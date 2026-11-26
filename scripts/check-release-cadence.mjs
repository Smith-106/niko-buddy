#!/usr/bin/env node
/**
 * check-release-cadence.mjs — 发布渠道与节奏机械检查（RELEASING「节奏审计」G5 的可执行化）
 *
 * 设计口径：
 *   - **门禁只判「被审版本」**（默认 Latest，可用 --tag 指定），不回头重判历史。
 *     历史违规以 INFO 汇总输出，供审计可见，不影响退出码。
 *   - 被审版本的三条节奏规则（stable = 非 prerelease 且非 draft）：
 *       weekly-stable       同 ISO 周（周一为周首，UTC 时区）stable ≤ 1
 *       same-day-duplicate  同日 stable = 0
 *       thirty-day-stable   被审版本发布时间往前推 30 天内 stable ≤ 4
 *   - 资产：latest.json + 安装包 *.exe 必有同名 .sig；*_portable.exe 按设计无 sig。
 *   - 主干：被审版本 tag 必须是主干基准（默认探测 refs/remotes/smith/master → refs/remotes/origin/master，可用 --base-ref 覆盖）祖先（本地无 tag 或基准不可解析则 FAIL（fail-closed））。
 *   - 豁免：release-cadence-exemptions.json 登记且 scope 覆盖该规则的 tag 判通过，
 *     并打印豁免依据（RELEASING 要求用户明确批准 + 理由 + 范围）。
 *
 * 用法：node scripts/check-release-cadence.mjs [--repo <owner/name>] [--tag <tag>] [--base-ref <ref>] [--draft-promotion] [--json]
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

/** UTC 时区下的 YYYY-MM-DD（消除本机时区漂移）。 */
export function localDay(iso) {
  const d = new Date(iso)
  const y = d.getUTCFullYear()
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0")
  const day = `${d.getUTCDate()}`.padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** UTC 时区下 ISO 周键（周一为周首）：返回该周周一的 YYYY-MM-DD。 */
export function isoWeekKey(iso) {
  const d = new Date(iso)
  const utcMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = (utcMidnight.getUTCDay() + 6) % 7 // 周一=0
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - dow)
  return localDay(utcMidnight.toISOString())
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
  if (!latest.isDraft && typeof latest.tagName === "string") {
    const versionMatch = latest.tagName.match(/^v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/)
    if (versionMatch) {
      const version = versionMatch[1]
      const expectedInstaller = `niko-buddy_${version}_windows_X64.exe`
      if (installers.length > 0 && !installers.includes(expectedInstaller)) {
        problems.push(`缺版本匹配安装包 ${expectedInstaller}`)
      }
      if (!latest.isPrerelease && !allowPrerelease) {
        const expectedPortable = `niko-buddy_${version}_windows_X64_portable.exe`
        if (!names.includes(expectedPortable)) {
          problems.push(`缺便携版资产 ${expectedPortable}`)
        }
      }
    }
  }
  return problems
}

function flattenApiPages(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid paginated GitHub response")
  return pages.flat()
}

function isUntaggedGitHubDraft(release) {
  return Boolean(
    release
      && release.draft === true
      && (release.tag_name === null || release.tag_name === undefined || release.tag_name === ""),
  )
}

export function readPublishedReleasePages(pages, latestTagName = null) {
  return flattenApiPages(pages).flatMap((release) => {
    if (isUntaggedGitHubDraft(release)) return []
    const validPublicationTime = typeof release?.published_at === "string" && Number.isFinite(Date.parse(release.published_at))
    if (!release
      || typeof release.tag_name !== "string" || !release.tag_name
      || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean"
      || (!validPublicationTime && !(release.draft && release.published_at === null))) {
      throw new Error("Invalid GitHub release metadata")
    }
    const isLatest = typeof latestTagName === "string" && latestTagName.length > 0
      && !release.draft && release.tag_name === latestTagName
    return [{
      tagName: release.tag_name,
      isDraft: release.draft,
      isPrerelease: release.prerelease,
      publishedAt: release.published_at,
      isLatest,
    }]
  })
}

function readLatestTagName(repo, run) {
  try {
    const latest = JSON.parse(run("gh", ["api", `repos/${repo}/releases/latest`]))
    if (!latest || typeof latest.tag_name !== "string" || !latest.tag_name) {
      throw new Error("Invalid GitHub latest release metadata")
    }
    return latest.tag_name
  } catch (err) {
    if (/\b404\b|Not Found/i.test(String(err?.message ?? ""))) return null
    throw err
  }
}

export function readDraftReleasePages(pages) {
  return flattenApiPages(pages).flatMap((release) => {
    if (isUntaggedGitHubDraft(release)) return []
    const validPublicationTime = typeof release?.published_at === "string" && Number.isFinite(Date.parse(release.published_at))
    if (!release || !Number.isSafeInteger(release.id) || release.id <= 0
      || typeof release.tag_name !== "string" || !release.tag_name
      || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean"
      || (!validPublicationTime && !(release.draft && release.published_at === null))) {
      throw new Error("Invalid GitHub release metadata")
    }
    return [{ id: release.id, tagName: release.tag_name, isDraft: release.draft, isPrerelease: release.prerelease, publishedAt: release.published_at, isLatest: false }]
  })
}

export function readDraftAssetPages(pages) {
  return flattenApiPages(pages).map((asset) => {
    if (!asset || typeof asset.name !== "string" || !asset.name || asset.state !== "uploaded"
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      throw new Error("Incomplete GitHub draft asset metadata")
    }
    return asset.name
  })
}

/** 模拟晋升未发布的 stable 草稿，不修改发行列表。 */
export function evaluateDraftPromotion(releases, targetTag, assetNames, publishedAt, exemptions = []) {
  const candidates = releases.filter((r) => r.tagName === targetTag)
  const target = candidates[0]
  if (candidates.length !== 1 || !target?.isDraft || target.isPrerelease || target.publishedAt || target.isLatest) {
    return { gate: { tag: targetTag, rules: [], missing: true }, assetProblems: ["Expected one unpublished stable release draft"] }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(targetTag) || !Number.isFinite(Date.parse(publishedAt))) {
    return { gate: { tag: targetTag, rules: [], missing: true }, assetProblems: ["Invalid stable tag or promotion time"] }
  }
  const exe = `niko-buddy_${targetTag.slice(1)}_windows_X64.exe`
  const expected = ["latest.json", exe, `${exe}.sig`, exe.replace(/\.exe$/, "_portable.exe")]
  const names = assetNames ?? []
  const assetProblems = expected.filter((name) => !names.includes(name)).map((name) => `Missing ${name}`)
  if (names.length !== expected.length && assetProblems.length === 0) assetProblems.push("Unexpected draft asset set")
  const projected = releases.map((r) => (r === target ? { ...r, isDraft: false, publishedAt } : r))
  return { gate: evaluateTarget(projected, targetTag, exemptions), assetProblems }
}

/** 被审 tag 不占 Latest 槽位时，prerelease 标记不算资产问题。 */
export function allowsPrerelease(releases, targetTag) {
  return releases.find((r) => r.isLatest)?.tagName !== targetTag
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/** 解析主干对比基准 ref：显式参数优先，否则依次探测 smith/master → origin/master，兜底 smith/master。 */
export function resolveBaseRef(explicitBaseRef, draftPromotion = false, run = sh) {
  if (explicitBaseRef) return explicitBaseRef
  void draftPromotion
  const candidates = ["refs/remotes/smith/master", "refs/remotes/origin/master"]
  for (const ref of candidates) {
    try {
      run("git", ["rev-parse", "--verify", ref])
      return ref
    } catch {
      // 当前远端主干 ref 不存在，继续探测下一个候选
    }
  }
  return "refs/remotes/smith/master"
}

function parseArgs(argv) {
  const pick = (flag) => {
    const i = argv.indexOf(flag)
    if (i < 0) return null
    const value = argv[i + 1]
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`)
    return value
  }
  return {
    repo: pick("--repo") ?? DEFAULT_REPO,
    tag: pick("--tag"),
    baseRef: pick("--base-ref"),
    json: argv.includes("--json"),
    draftPromotion: argv.includes("--draft-promotion"),
  }
}

export function main(argv = process.argv.slice(2), run = sh) {
  const wantsJson = argv.includes("--json")
  const emitEarlyError = (exitCode, error, extra = {}) => {
    if (wantsJson) {
      console.log(JSON.stringify({ ok: false, exitCode, error, ...extra }, null, 2))
    } else {
      console.error(error)
    }
    return exitCode
  }

  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    return emitEarlyError(2, err instanceof Error ? err.message : String(err))
  }
  const { repo, tag, baseRef, json, draftPromotion } = args
  if (draftPromotion && (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || repo !== DEFAULT_REPO)) {
    return emitEarlyError(2, "--draft-promotion requires a stable --tag vX.Y.Z for Smith-106/niko-buddy", {
      repo,
      tag: tag ?? null,
      draftPromotion,
    })
  }
  let releases
  try {
    const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]))
    if (draftPromotion) {
      releases = readDraftReleasePages(pages)
    } else {
      const parsed = readPublishedReleasePages(pages)
      const latestTagName = readLatestTagName(repo, run)
      releases = latestTagName
        ? parsed.map((r) => ({ ...r, isLatest: !r.isDraft && r.tagName === latestTagName }))
        : parsed
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return emitEarlyError(2, `[cadence] 无法读取 release 列表（${repo}）：${msg}`, {
      repo,
      tag: tag ?? null,
      draftPromotion,
    })
  }

  const targetTag = tag ?? releases.find((r) => r.isLatest)?.tagName
  if (!targetTag) {
    return emitEarlyError(2, "[cadence] 找不到被审 release（无 Latest 且未指定 --tag）", {
      repo,
      tag: null,
      draftPromotion,
    })
  }
  const target = releases.find((r) => r.tagName === targetTag) ?? null
  if (!target && !draftPromotion) {
    return emitEarlyError(1, `[cadence] Release not found: ${targetTag}`, {
      repo,
      tag: targetTag,
      draftPromotion,
    })
  }
  const { exemptions } = readExemptions()
  let gate = evaluateTarget(releases, targetTag, exemptions)
  const history = auditHistory(releases)

  let assetProblems = []
  if (draftPromotion) {
    const promotionTime = new Date().toISOString()
    // No asset lookup by draft tag; bind the asset read to the unpublished release ID.
    const candidate = evaluateDraftPromotion(releases, targetTag, [], promotionTime, exemptions)
    gate = candidate.gate
    if (gate.missing) {
      assetProblems = candidate.assetProblems
    } else {
      try {
        const names = readDraftAssetPages(JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases/${target.id}/assets?per_page=100`])))
        ;({ gate, assetProblems } = evaluateDraftPromotion(releases, targetTag, names, promotionTime, exemptions))
      } catch (err) {
        assetProblems = [`资产读取失败：${err.message}`]
      }
    }
  } else if (target) {
    try {
      const names = JSON.parse(run("gh", ["release", "view", targetTag, "--repo", repo, "--json", "assets"])).assets.map((a) => a.name)
      assetProblems = evaluateLatestAssets(target, names, { allowPrerelease: allowsPrerelease(releases, targetTag) })
    } catch (err) {
      assetProblems = [`资产读取失败：${err.message}`]
    }
  }

  const trunkWarnings = []
  let trunkFailed = null
  const revRef = `refs/tags/${targetTag}^{commit}`
  try {
    run("git", ["rev-parse", "--verify", revRef])
    const trunkRef = resolveBaseRef(baseRef, draftPromotion, run)
    try {
      run("git", ["merge-base", "--is-ancestor", revRef, trunkRef])
    } catch {
      trunkFailed = `${targetTag} 不是 ${trunkRef} 的祖先（悬在旁支）`
    }
  } catch {
    trunkFailed = `${targetTag}: 本地无此 tag，主干校验失败`
  }

  if (!trunkFailed && (draftPromotion ? !gate.missing : Boolean(target))) {
    const ref = `refs/tags/${targetTag}`
    try {
      const localTag = run("git", ["rev-parse", "--verify", ref])
      const remote = JSON.parse(run("gh", ["api", `repos/${repo}/git/ref/tags/${targetTag}`]))
      if (!/^[a-f0-9]{40}$/.test(localTag) || remote?.ref !== ref || remote?.object?.sha !== localTag) {
        trunkFailed = `${targetTag}: remote tag does not match the local tag object`
      }
    } catch (err) {
      trunkFailed = `${targetTag}: remote tag could not be verified: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const real = gate.rules.filter((r) => !r.exempted)
  const exempted = gate.rules.filter((r) => r.exempted)
  const failed = real.length + assetProblems.length + (trunkFailed ? 1 : 0)

  if (json) {
    console.log(JSON.stringify({
      ok: failed === 0,
      exitCode: failed === 0 ? 0 : 1,
      repo,
      tag: targetTag,
      draftPromotion,
      gate,
      history,
      assetProblems,
      trunkWarnings,
      trunkFailed,
    }, null, 2))
  } else {
    console.log(`[cadence] 被审版本：${targetTag}${target?.isDraft ? "（未发布草稿）" : target ? `（${localDay(target.publishedAt)} 发布）` : "（不存在）"}`)
    console.log(
      `[cadence] INFO 历史：stable 共 ${history.stableTotal} 个，多 stable 周 ${history.weeks} 个、多 stable 日 ${history.days} 个（历史不参与门禁）`,
    )
    console.log(`[cadence] INFO 最近 stable：${history.recent.join(", ") || "无"}`)
    for (const r of exempted) console.log(`[cadence] EXEMPT ${r.rule} ${targetTag} -- ${r.reason ?? "已登记豁免"}（批准于 ${r.approvedAt ?? "?"}）`)
    for (const w of trunkWarnings) console.log(`[cadence] WARN ${w}`)
    for (const p of assetProblems) console.log(`[cadence] FAIL latest-assets ${targetTag} -- ${p}`)
    if (trunkFailed) console.log(`[cadence] FAIL trunk ${targetTag} -- ${trunkFailed}`)
    for (const r of real) console.log(`[cadence] FAIL ${r.rule} ${targetTag} -- ${r.detail}`)
    if (gate.missing && !draftPromotion) console.log(`[cadence] WARN ${targetTag} 不在 stable 列表中（prerelease 渠道不受节奏门约束）`)
    console.log(
      failed === 0
        ? `[cadence] RESULT: PASS（${targetTag}，豁免 ${exempted.length} 项）`
        : `[cadence] RESULT: FAIL（${targetTag}，${failed} 项违规，其中 ${real.length} 项未豁免）`,
    )
  }
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main())
}
