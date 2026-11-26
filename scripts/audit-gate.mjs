#!/usr/bin/env node
// Dependency audit gate（替代裸 `npm audit --audit-level=high`，2026-10-03）。
//
// 动机：GHSA-vfj7-8cjw-p6xm（braces stack-exhaustion，range <=3.0.3）覆盖 braces
// 最新版，上游暂无 patch。裸 audit 门对此类「无修复版」advisory 永久红灯，
// 逼人用 --force 倒退依赖（曾拒：boundaries 1.1.1 / shadcn 1.0.0 倒退建议）。
// 本门做法：JSON 全量审查 + 显式例外清单 + fail-closed 报文校验。例外必须逐条记录
// 理由与复查条件，非清单 high/critical、网络错或报文畸形一律失败。门禁只增不减。
import { execSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

// 例外清单：每条必须有 advisory URL + 接受理由 + 自动复查条件
export const AUDIT_EXCEPTIONS = [
  {
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    reason:
      'braces stack-exhaustion；range <=3.0.3 覆盖最新版，上游无 patch；' +
      '经由 eslint-plugin-boundaries(dev-only lint 门禁，不进生产 bundle) 传递引入；' +
      '生产可达性：构建产物 CSS/JS 不含 braces（服务静态文件，无用户输入进 glob 模式）。',
    // 复查条件：任一条件成立或查询异常即例外失效（fail-closed，逼人工复审）
    revalidate: (exec = execSync) => {
      try {
        const raw = exec('npm view braces version --json', { encoding: 'utf8' })
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          return 'braces 版本复查返回空结果（fail-closed）'
        }
        const braces = JSON.parse(raw)
        const vers = Array.isArray(braces) ? braces : [braces]
        const latest = vers[vers.length - 1]
        if (typeof latest !== 'string' || latest.trim().length === 0) {
          return 'braces 版本复查响应缺少有效版本号（fail-closed）'
        }
        if (latest !== '3.0.3') {
          return `braces 已发布新版 ${latest}，请复审 GHSA-vfj7-8cjw-p6xm 是否已修复并移除例外`
        }
        return null
      } catch (err) {
        return `braces 版本复查失败（fail-closed）：${toMessage(err)}`
      }
    },
  },
]

/**
 * 解析并强校验 `npm audit --json` 原始输出（E5-02 fail-closed）。
 * 拒绝空串、非 JSON、`report.error`、缺失或非法的 `vulnerabilities` 与
 * `metadata.vulnerabilities`，彻底封堵网络失败/畸形响应假绿。
 */
export function parseAndValidateAuditReport(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('AUDIT-GATE-FAIL: npm audit output is empty')
  }

  let report
  try {
    report = JSON.parse(raw)
  } catch (err) {
    throw new Error(`AUDIT-GATE-FAIL: npm audit output is not valid JSON (${toMessage(err)})`)
  }

  if (!isPlainObject(report)) {
    throw new Error('AUDIT-GATE-FAIL: npm audit report must be a JSON object')
  }

  if (report.error !== undefined && report.error !== null) {
    const code = isPlainObject(report.error) && typeof report.error.code === 'string'
      ? report.error.code
      : 'UNKNOWN'
    const summary = isPlainObject(report.error) && typeof report.error.summary === 'string'
      ? report.error.summary
      : toMessage(report.error)
    throw new Error(`AUDIT-GATE-FAIL: npm audit returned error (${code}): ${summary}`)
  }

  if (!isPlainObject(report.vulnerabilities)) {
    throw new Error('AUDIT-GATE-FAIL: npm audit report missing valid vulnerabilities object')
  }

  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!isPlainObject(entry)) {
      throw new Error(`AUDIT-GATE-FAIL: invalid vulnerability entry for "${name}"`)
    }
  }

  if (!isPlainObject(report.metadata) || !isPlainObject(report.metadata.vulnerabilities)) {
    throw new Error('AUDIT-GATE-FAIL: npm audit report missing valid metadata.vulnerabilities')
  }

  const metaVulns = report.metadata.vulnerabilities
  for (const level of ['high', 'critical']) {
    const count = metaVulns[level]
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`AUDIT-GATE-FAIL: invalid metadata.vulnerabilities.${level}`)
    }
  }

  let actualHigh = 0
  let actualCritical = 0
  for (const entry of Object.values(report.vulnerabilities)) {
    if (entry.severity === 'high') actualHigh += 1
    else if (entry.severity === 'critical') actualCritical += 1
  }

  if (actualHigh !== metaVulns.high || actualCritical !== metaVulns.critical) {
    throw new Error(
      `AUDIT-GATE-FAIL: metadata.vulnerabilities mismatch (metadata high=${metaVulns.high}, critical=${metaVulns.critical}; actual high=${actualHigh}, critical=${actualCritical})`,
    )
  }

  return report
}

/**
 * 基于已校验的 audit 报告与例外清单评估 high/critical 漏洞。
 */
export function evaluateAuditReport(report, options = {}) {
  const exceptions = options.exceptions ?? AUDIT_EXCEPTIONS
  if (!isPlainObject(report) || !isPlainObject(report.vulnerabilities)) {
    throw new Error('AUDIT-GATE-FAIL: invalid report passed to evaluateAuditReport')
  }

  const vulns = report.vulnerabilities
  // 收集条目根因 advisory URL：via 字符串是包名（沿链递归），对象是 advisory 本体
  function rootUrls(name, seen = new Set()) {
    if (seen.has(name)) return []
    seen.add(name)
    const v = vulns[name]
    if (!isPlainObject(v)) return []
    const urls = []
    for (const x of Array.isArray(v.via) ? v.via : []) {
      if (isPlainObject(x) && typeof x.url === 'string' && x.url) urls.push(x.url)
      else if (typeof x === 'string') urls.push(...rootUrls(x, seen))
    }
    return [...new Set(urls)]
  }

  const excepted = []
  const offenders = []
  const excUrls = new Set(exceptions.map((e) => e.url))

  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue
    const urls = rootUrls(name)
    // F15（arch -0.3）：advisory 级精确豁免——该条目全部根因 advisory 都在例外清单
    // 才放行；任一非例外 advisory（同链新增漏洞）即红灯。空 urls 永不豁免。
    const uncovered = urls.filter((u) => !excUrls.has(u))
    if (urls.length > 0 && uncovered.length === 0) {
      const exc = exceptions.find((e) => urls.includes(e.url))
      excepted.push({
        name,
        severity: v.severity,
        urls,
        reason: exc?.reason ?? '',
      })
    } else {
      offenders.push(`${v.severity} ${name} <- ${uncovered.join(',') || urls.join(',') || 'no-advisory-url'}`)
    }
  }

  return {
    ok: offenders.length === 0,
    excepted,
    offenders,
  }
}

/**
 * 运行完整依赖审计门禁（支持依赖注入，便于离线毫秒级单测）。
 * 返回进程退出码：0 表示通过，1 表示阻断（fail-closed）。
 */
export function runAuditGate(deps = {}) {
  const exec = deps.exec ?? execSync
  const exceptions = deps.exceptions ?? AUDIT_EXCEPTIONS
  const log = deps.log ?? console.log
  const error = deps.error ?? console.error

  let raw
  try {
    raw = exec('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    // npm audit 存在漏洞时返回 exit 1，JSON 报告位于 stdout；若无有效 stdout 则 fail-closed
    if (typeof e?.stdout === 'string') {
      raw = e.stdout
    } else if (Buffer.isBuffer(e?.stdout)) {
      raw = e.stdout.toString('utf8')
    } else {
      error(`AUDIT-GATE-FAIL: npm audit execution failed without stdout: ${toMessage(e)}`)
      return 1
    }
  }

  let report
  try {
    report = parseAndValidateAuditReport(raw)
  } catch (e) {
    const msg = toMessage(e)
    error(msg.startsWith('AUDIT-GATE-FAIL') ? msg : `AUDIT-GATE-FAIL: ${msg}`)
    return 1
  }

  const { excepted, offenders } = evaluateAuditReport(report, { exceptions })
  for (const item of excepted) {
    log(`EXCEPT ${item.severity} ${item.name} <- ${item.urls.join(',')}\n  reason: ${item.reason}`)
  }

  let failed = false
  // 例外复查：条件触发或复查失败即阻断（fail-closed）
  for (const exc of exceptions) {
    const msg = exc.revalidate(exec)
    if (msg) {
      error(`REVALIDATE-FAIL ${exc.url}: ${msg}`)
      failed = true
    }
  }

  if (offenders.length > 0) {
    error(`AUDIT-GATE-FAIL ${offenders.length} non-excepted high/critical:`)
    for (const o of offenders) error(`  ${o}`)
    failed = true
  }

  if (failed) return 1
  log('AUDIT-GATE-PASS: no non-excepted high/critical vulnerabilities')
  return 0
}

// 仅在 CLI 直接作为主入口运行时执行，保证模块 import 零副作用
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(runAuditGate())
}
