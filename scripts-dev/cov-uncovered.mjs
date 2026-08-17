// Helper: run vitest coverage for a spec+source pair, print uncovered lines/branches/functions.
// Usage: node scripts-dev/cov-uncovered.mjs <spec> <source>
import { execSync } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const spec = process.argv[2]
const source = process.argv[3]
if (!spec || !source) {
  console.error('usage: node scripts-dev/cov-uncovered.mjs <spec> <source>')
  process.exit(1)
}

const dir = path.resolve('coverage-tmp-uncovered')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const cmd = `npx vitest run ${spec} --coverage --coverage.provider=v8 --coverage.include=${source} --coverage.exclude='src/**/*.spec.ts' --coverage.reporter=json --coverage.reportsDirectory=${dir}`
try {
  execSync(cmd, { stdio: 'inherit', shell: 'cmd' })
} catch (e) {
  // vitest exits non-zero when coverage thresholds? not set here; ignore
}

const reportPath = path.join(dir, 'coverage-final.json')
const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
for (const [file, data] of Object.entries(report)) {
  console.log('FILE:', file)
  // statements: keys are statement ids -> {start,end,count}
  const stmts = Object.values(data.statementMap).map((loc, i) => ({ loc, count: data.s[String(i)] ?? 0 }))
  const uncoveredStmts = stmts.filter((s) => s.count === 0)
  console.log('-- uncovered statements:')
  for (const s of uncoveredStmts) {
    console.log(`   line ${s.loc.start.line}${s.loc.start.column !== undefined ? ':' + s.loc.start.column : ''} (id ${stmts.indexOf(s)})`)
  }
  const branchEntries = Object.entries(data.branchMap)
  const uncoveredBranches = branchEntries.filter(([id]) => (data.b[id] ?? []).some((c) => c === 0))
  console.log('-- uncovered branches:')
  for (const [id, loc] of uncoveredBranches) {
    const counts = data.b[id] ?? []
    const types = counts.map((c, i) => `[${i}]=${c}`).join(' ')
    const start = loc?.loc?.start?.line ?? loc?.line ?? loc?.start?.line
    const locStr = start ? `line ${start}` : 'loc=no-start'
    console.log(`   ${locStr} type=${loc?.type ?? '?'} id=${id} counts: ${types}`)
  }
  const fnEntries = Object.entries(data.fnMap)
  const uncoveredFns = fnEntries.filter(([id]) => (data.f[id] ?? 0) === 0)
  console.log('-- uncovered functions:')
  for (const [id, loc] of uncoveredFns) {
    const start = loc?.loc?.start?.line ?? loc?.line ?? loc?.start?.line
    console.log(`   line ${start ?? '?'} id=${id}`)
  }
  console.log('-- summary:', `stmts ${data.s ? Object.values(data.s).filter((c) => c === 0).length : '?'} uncovered / ${Object.keys(data.s).length}`)
}
