#!/usr/bin/env node
/**
 * baseline-skip-worktree.mjs — perf baseline JSON 归档（65 号共识 G7）
 *
 * 背景：vitest perf baseline 测试（bench-helpers saveBaseline）每次运行
 * 无条件写回 src/test-helpers/baselines/*.json（机器相关抖动），造成
 * 工作树长期 M 状态。.gitignore 对已跟踪文件无效、rm --cached 断历史，
 * 故采用 git update-index --skip-worktree：本地写回不污染工作树，
 * 仓库保留基线历史，新 clone 正常检出。
 *
 * 用法：
 *   node scripts/baseline-skip-worktree.mjs        # 应用 skip-worktree
 *   node scripts/baseline-skip-worktree.mjs --list # 列出已归档文件
 *   node scripts/baseline-skip-worktree.mjs --reset # 解除（恢复跟踪状态）
 */
import { execFileSync } from "node:child_process"

const FILES = [
  "src/test-helpers/baselines/ipc-latency.json",
  "src/test-helpers/baselines/lancedb.json",
  "src/test-helpers/baselines/llm-latency.json",
  "src/test-helpers/baselines/memory.json",
  "src/test-helpers/baselines/search.json",
  "src/test-helpers/baselines/startup.json",
]

const mode = process.argv[2] ?? "apply"

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
}

switch (mode) {
  case "apply":
    for (const f of FILES) {
      try {
        git(["update-index", "--skip-worktree", f])
        console.log(`skip-worktree: ${f}`)
      } catch (e) {
        console.error(`FAILED: ${f} — ${e.message.split("\n")[0]}`)
      }
    }
    break
  case "--list": {
    const out = git(["ls-files", "-v"])
    for (const line of out.split("\n")) {
      if (line.startsWith("S ") && FILES.some((f) => line.endsWith(f))) console.log(`archived: ${line.slice(2)}`)
    }
    break
  }
  case "--reset":
    for (const f of FILES) {
      git(["update-index", "--no-skip-worktree", f])
      console.log(`unarchived: ${f}`)
    }
    break
  default:
    console.error(`unknown mode: ${mode} (use apply | --list | --reset)`)
    process.exit(1)
}
