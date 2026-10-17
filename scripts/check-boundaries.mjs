#!/usr/bin/env node
// boundaries 门禁正/负 fixture 回归（T18-G 残留项，2026-09-10）
//
// 动机：2026-09-09 发现 eslint-plugin-boundaries 7.2.0 的 elements 为「目录」匹配，
// 旧配置既把 barrel 自身判为违规（假阳），又可能放过直属深导入（漏判），且「把目录加进
// public」会得到 0 命中的假绿。假绿之所以能存活，是因为只有 lint 计数、没有正/负对照。
// 本脚本用 ESLint API 对 3 条固定导入形态做断言：
//   1) barrel 导入        → 必须放行（0 条 boundaries/dependencies）
//   2) 直属深导入        → 必须命中
//   3) 嵌套深导入        → 必须命中
// 第 2/3 条同时是熔断器：resolver 或元素分类一旦失效（导入无法被归类 → 静默放行），
// 它们会先变成 0 命中并失败，而不是让门禁悄悄假绿。
//
// 用法：node scripts/check-boundaries.mjs（由 npm run lint 串联，CI node-gates 覆盖）

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RULE = 'boundaries/dependencies'
// 探针文件本身不入库（lintText 虚拟路径）：只需位于 src/ 下以落入 app 分类。
const PROBE_FILE = path.join(root, 'src', '__boundaries_probe__', 'probe.ts')

const CASES = [
  {
    name: 'barrel 导入必须放行',
    expectation: 'allow',
    code: "import { applyFileEdits } from '@/lib/novel'\n\nexport const probe = applyFileEdits\n",
  },
  {
    name: '受控延迟公开面（动态叶子）必须放行',
    expectation: 'allow',
    code: "export async function probe() {\n  const { applyFileEdits } = await import('@/lib/novel/agent-tools')\n  return applyFileEdits\n}\n",
  },
  {
    name: '内部模块直属深导入必须命中',
    expectation: 'flag',
    code: "import { sanitizeEntitySlug } from '@/lib/novel/graph-adapter'\n\nexport const probe = sanitizeEntitySlug\n",
  },
  {
    name: '内部模块嵌套深导入必须命中',
    expectation: 'flag',
    code: "import type { AnalysisDepth } from '@/lib/novel/book-analysis/types'\n\nexport const probe: AnalysisDepth = 'fast'\n",
  },
  {
    // C6 步骤①：契约层零运行时依赖 —— store-config-slices 不得出现 wiki-store 运行时
    // import（防类型→运行时耦合倒灌）。静态文本熔断（与 boundaries/dependencies 正交：
    // 同 element 内互访默认放行，lint 规则拦不住，故此处用 grep 断言）。
    // 允许 `import type`（类型单向回指）；值 import 即 FAIL。
    name: 'C6 契约层不得依赖 wiki-store 运行时',
    expectation: 'absent',
    check: () => {
      const file = path.join(root, 'src', 'stores', 'store-config-slices.ts')
      const text = fs.readFileSync(file, 'utf-8')
      const lines = text.split('\n')
      const bad = lines.filter(
        (l) =>
          /from\s*['"]@\/stores\/wiki-store['"]/.test(l) &&
          !/^\s*import\s+type\b/.test(l),
      )
      return bad.length === 0 ? null : `发现 wiki-store 运行时 import ${bad.length} 行：${bad[0].trim()}`
    },
  },
]

const eslint = new ESLint({ cwd: root })
const failures = []

for (const testCase of CASES) {
  if (testCase.check) {
    const err = testCase.check()
    const passed = err === null
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.name} — ${passed ? '无运行时 import' : err}`)
    if (!passed) failures.push(testCase.name)
    continue
  }
  const results = await eslint.lintText(testCase.code, { filePath: PROBE_FILE })
  const messages = results.flatMap((r) => r.messages).filter((m) => m.ruleId === RULE)
  const passed = testCase.expectation === 'allow' ? messages.length === 0 : messages.length > 0
  const detail =
    messages.length > 0
      ? `${messages.length} 条：${messages[0].message}`
      : '0 条（未命中）'
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.name} — ${detail}`)
  if (!passed) failures.push(testCase.name)
}

if (failures.length > 0) {
  console.error(`\n[boundaries] ${failures.length} 个 fixture 未达预期：${failures.join(' / ')}`)
  process.exit(1)
}
console.log(`\n[boundaries] ${CASES.length}/${CASES.length} fixture 通过`)
