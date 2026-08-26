#!/usr/bin/env node
/**
 * corpus-check.js — T01b-2 验收命令薄壳（蓝图验收路径 scripts/corpus-check.js --verify）
 * 单一真源为 corpus-check.mjs；本文件仅转发表单，保证验收命令可执行。
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = spawnSync(process.execPath, [join(__dirname, "corpus-check.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
})
process.exit(result.status ?? 1)
