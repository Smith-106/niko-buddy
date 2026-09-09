#!/usr/bin/env node
/**
 * Release build orchestration (P2-3: PS1-free path).
 *
 * Replaces the two inline powershell -Command blocks that used to live in
 * package.json (`build:portable` / `build:github-release`). Node spawns the
 * same steps with env assembled in-process; child exit codes propagate via
 * process.exitCode semantics — no $LASTEXITCODE involved.
 *
 * Steps:
 *   1. assemble release build env (LTO/codegen-units/opt-level + signing key
 *      fallback for the github-release variant only)
 *   2. npx tauri build [--no-bundle]  (exit non-zero -> abort)
 *   3. node scripts/build-portable.mjs (exit non-zero -> abort)
 *   4. github-release variant: node scripts/prepare-github-release.mjs
 *
 * Signing key contract (P2-3): the PS1 copy of the
 * `TAURI_SIGNING_PRIVATE_KEY_PATH` fallback was removed; the only
 * definition now lives in scripts/signing-key.mjs and every consumer
 * imports it (dual-write cleared). This file only fail-fasts against
 * that shared contract before an expensive build.
 *
 * Usage:
 *   node scripts/build-release-env.mjs --portable
 *   node scripts/build-release-env.mjs --github-release
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { assertSigningKeyExists } from "./signing-key.mjs"

const root = resolve(process.cwd())
const mode = process.argv.includes("--github-release")
  ? "github-release"
  : process.argv.includes("--portable")
    ? "portable"
    : null

if (!mode) {
  console.error("usage: node scripts/build-release-env.mjs --portable | --github-release")
  process.exit(2)
}

const childEnv = {
  ...process.env,
  CARGO_PROFILE_RELEASE_LTO: "false",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "1",
}

if (mode === "github-release" && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  // tauri signer requires a password value (may be empty for unencrypted keys).
  childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
}

/** Spawn a step, inherit stdio, abort the chain on non-zero exit. */
function run(label, cmd, args) {
  console.log(`[build-release] ${label}: ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { stdio: "inherit", env: childEnv, shell: false })
  if (r.error) {
    console.error(`[build-release] ${label} failed to spawn: ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`[build-release] ${label} exited ${r.status} — aborting chain`)
    process.exit(r.status ?? 1)
  }
}

if (mode === "github-release") {
  // Fail fast before an expensive build when the signing key is missing.
  // Resolution is owned by scripts/signing-key.mjs (single source).
  try {
    assertSigningKeyExists()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

run("tauri build", "npx", mode === "portable" ? ["tauri", "build", "--no-bundle"] : ["tauri", "build"])
run("build-portable", process.execPath, [resolve(root, "scripts/build-portable.mjs")])
if (mode === "github-release") {
  run("prepare-github-release", process.execPath, [resolve(root, "scripts/prepare-github-release.mjs")])
}