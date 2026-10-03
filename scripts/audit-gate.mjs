#!/usr/bin/env node
// Dependency audit gate（替代裸 `npm audit --audit-level=high`，2026-10-03）。
//
// 动机：GHSA-vfj7-8cjw-p6xm（braces stack-exhaustion，range <=3.0.3）覆盖 braces
// 最新版，上游暂无 patch。裸 audit 门对此类「无修复版」advisory 永久红灯，
// 逼人用 --force 倒退依赖（曾拒：boundaries 1.1.1 / shadcn 1.0.0 倒退建议）。
// 本门做法：JSON 全量审查 + 显式例外清单。例外必须逐条记录理由与复查条件，
// 非清单 high/critical 依然失败。门禁只增不减。
import { execSync } from 'node:child_process'

// 例外清单：每条必须有 advisory URL + 接受理由 + 自动复查条件
const EXCEPTIONS = [
  {
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    reason:
      'braces stack-exhaustion；range <=3.0.3 覆盖最新版，上游无 patch；' +
      '经由 eslint-plugin-boundaries(dev-only lint 门禁，不进生产 bundle) 传递引入；' +
      '生产可达性：构建产物 CSS/JS 不含 braces（服务静态文件，无用户输入进 glob 模式）。',
    // 复查条件：任一条件成立即例外失效（脚本报错，逼人工复审）
    revalidate: () => {
      const braces = JSON.parse(
        execSync('npm view braces version --json', { encoding: 'utf8' }),
      )
      const vers = Array.isArray(braces) ? braces : [braces]
      const latest = vers[vers.length - 1]
      if (latest !== '3.0.3') {
        return `braces 已发布新版 ${latest}，请复审 GHSA-vfj7-8cjw-p6xm 是否已修复并移除例外`
      }
      return null
    },
  },
]

let raw
try {
  raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (e) {
  raw = e.stdout // exit 1 时 JSON 在 stdout
}
const report = JSON.parse(raw)
const vulns = report.vulnerabilities ?? {}
// 收集条目根因 advisory URL：via 字符串是包名（沿链递归），对象是 advisory 本体
function rootUrls(name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const v = vulns[name]
  if (!v) return []
  const urls = []
  for (const x of v.via ?? []) {
    if (typeof x === 'object' && x.url) urls.push(x.url)
    else if (typeof x === 'string') urls.push(...rootUrls(x, seen))
  }
  return [...new Set(urls)]
}
const offenders = []
for (const [name, v] of Object.entries(vulns)) {
  if (v.severity !== 'high' && v.severity !== 'critical') continue
  const urls = rootUrls(name)
  const exc = EXCEPTIONS.find((e) => urls.includes(e.url))
  if (exc) {
    console.log(`EXCEPT ${v.severity} ${name} <- ${urls.join(',')}\n  reason: ${exc.reason}`)
  } else {
    offenders.push(`${v.severity} ${name} <- ${urls.join(',') || 'no-advisory-url'}`)
  }
}
// 例外复查：条件触发即失败
for (const e of EXCEPTIONS) {
  const msg = e.revalidate()
  if (msg) {
    console.error(`REVALIDATE-FAIL ${e.url}: ${msg}`)
    process.exitCode = 1
  }
}
if (offenders.length > 0) {
  console.error(`AUDIT-GATE-FAIL ${offenders.length} non-excepted high/critical:`)
  for (const o of offenders) console.error(`  ${o}`)
  process.exitCode = 1
} else if (process.exitCode !== 1) {
  console.log('AUDIT-GATE-PASS: no non-excepted high/critical vulnerabilities')
}
