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
]

const eslint = new ESLint({ cwd: root })
const failures = []

for (const testCase of CASES) {
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
