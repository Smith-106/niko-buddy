/**
 * verify-dod-v273.js — DoD v2.7.3 断言薄壳（vitest 转发）
 *
 * P1-3 迁 vitest：原 check 断言已逐条迁移至
 *   src/lib/quality/__tests__/v273.dod.spec.ts（10 个 it 块，1:1 对应原 10 条 check）。
 * 本文件保留 node scripts/verify-dod-v273.js 可执行入口：spawn vitest 跑对应 spec，
 * 透传 exit code（spec 全绿 → 0；任一 it 失败 → 1）。
 *
 * 用法：
 *   node scripts/verify-dod-v273.js           # 跑 DoD v2.7.3 断言
 *   node scripts/verify-dod-v273.js --help    # 打印本帮助（退出 0）
 *
 * node scripts/verify-dod-v2611.js 同批已归档（结构性坏死，见
 * scripts/archive/verify-dod/verify-dod-v2611.js 头部注记）。
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HELP = `verify-dod-v273.js — DoD v2.7.3 断言（vitest 转发薄壳）
用法：node scripts/verify-dod-v273.js [--help|-h]
行为：spawn vitest run src/lib/quality/__tests__/v273.dod.spec.ts 并透传 exit code
说明：原 10 条 check 断言已转为 10 个 it 块（console.log PASS 计数已移除，
测试数 = 原 PASS 数）`

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(HELP)
  process.exit(0)
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url))
const specPath = fileURLToPath(new URL("../src/lib/quality/__tests__/v273.dod.spec.ts", import.meta.url))
const r = spawnSync(process.execPath, [vitestCli, "run", specPath], { cwd: repoRoot, stdio: "inherit" })
process.exit(r.status ?? 1)