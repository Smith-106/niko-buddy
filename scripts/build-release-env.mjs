#!/usr/bin/env node
/**
 * Release build orchestration (P2-3: PS1-free path, R2-E02: Windows ENOENT & no-shell hardening).
 *
 * Replaces the two inline powershell -Command blocks that used to live in
 * package.json (`build:portable` / `build:github-release`). Node spawns the
 * same steps with env assembled in-process; child exit codes propagate via
 * process.exitCode semantics — no $LASTEXITCODE involved.
 *
 * Steps:
 *   1. assemble release build env (LTO/codegen-units/opt-level + signing key
 *      fallback for the github-release variant only)
 *   2. tauri build [--no-bundle] via local node_modules/@tauri-apps/cli/tauri.js
 *      (falls back to bundled npx-cli.js via process.execPath; fail-closed if absent,
 *      zero shell interpreter fallback)
 *   3. node scripts/build-portable.mjs (exit non-zero -> abort)
 *   4. github-release variant: node scripts/prepare-github-release.mjs
 *
 * Usage:
 *   node scripts/build-release-env.mjs --portable
 *   node scripts/build-release-env.mjs --github-release
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { assertSigningKeyExists } from "./signing-key.mjs"

/**
 * 解析 Tauri CLI 启动命令（零 shell 解释器回退，彻底杜绝环境壳变量劫持）：
 * 1. 优先用当前 Node 可执行文件直调本地 `node_modules/@tauri-apps/cli/tauri.js`；
 * 2. 若缺失，探测与 `execPath` 同级/标准布局的 `node_modules/npm/bin/npx-cli.js`（仍走 `execPath` + `shell: false`）；
 * 3. 若均不存在，fail-closed 抛出明确错误，提示先运行 `npm ci` 安装 `@tauri-apps/cli`。
 */
export function resolveTauriCommand({
  root = resolve(process.cwd()),
  tauriArgs = ["build"],
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  const localCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js")
  if (exists(localCli)) {
    return {
      cmd: execPath,
      args: [localCli, ...tauriArgs],
    }
  }

  const execDir = dirname(execPath)
  const npxCliCandidates = [
    ...new Set([
      resolve(execDir, "node_modules/npm/bin/npx-cli.js"),
      resolve(execDir, "../lib/node_modules/npm/bin/npx-cli.js"),
    ]),
  ]
  const npxCli = npxCliCandidates.find((candidate) => exists(candidate))
  if (npxCli) {
    return {
      cmd: execPath,
      args: [npxCli, "tauri", ...tauriArgs],
    }
  }

  throw new Error(
    `[build-release] 未找到本地 @tauri-apps/cli (${localCli}) 或 npx-cli.js，请先运行 npm ci 安装 @tauri-apps/cli。`,
  )
}

export function runReleaseBuild({
  argv = process.argv.slice(2),
  root = resolve(process.cwd()),
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  spawn = spawnSync,
  assertSigningKey = assertSigningKeyExists,
  log = console.log,
  error = console.error,
} = {}) {
  const mode = argv.includes("--github-release")
    ? "github-release"
    : argv.includes("--portable")
      ? "portable"
      : null

  if (!mode) {
    error("usage: node scripts/build-release-env.mjs --portable | --github-release")
    return 2
  }

  const childEnv = {
    ...env,
    CARGO_PROFILE_RELEASE_LTO: "false",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "1",
  }

  if (mode === "github-release" && !env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    // tauri signer requires a password value (may be empty for unencrypted keys).
    childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
  }

  if (mode === "github-release") {
    // Fail fast before an expensive build when the signing key is missing.
    // Resolution is owned by scripts/signing-key.mjs (single source).
    try {
      assertSigningKey()
    } catch (err) {
      error(err instanceof Error ? err.message : String(err))
      return 1
    }
  }

  /** Spawn a step, inherit stdio, abort the chain on non-zero exit. */
  function runStep(label, cmd, args) {
    log(`[build-release] ${label}: ${cmd} ${args.join(" ")}`)
    const r = spawn(cmd, args, { stdio: "inherit", env: childEnv, shell: false })
    if (r.error) {
      error(`[build-release] ${label} failed to spawn: ${r.error.message}`)
      return 1
    }
    if (r.status !== 0) {
      error(`[build-release] ${label} exited ${r.status} — aborting chain`)
      return r.status ?? 1
    }
    return 0
  }

  const tauriArgs = mode === "portable" ? ["build", "--no-bundle"] : ["build"]
  let tauriCmd
  try {
    tauriCmd = resolveTauriCommand({ root, tauriArgs, execPath, exists })
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    return 1
  }

  const steps = [
    ["tauri build", tauriCmd.cmd, tauriCmd.args],
    ["build-portable", execPath, [resolve(root, "scripts/build-portable.mjs")]],
  ]
  if (mode === "github-release") {
    steps.push(["prepare-github-release", execPath, [resolve(root, "scripts/prepare-github-release.mjs")]])
  }

  for (const [label, cmd, args] of steps) {
    const code = runStep(label, cmd, args)
    if (code !== 0) return code
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(runReleaseBuild())
}
