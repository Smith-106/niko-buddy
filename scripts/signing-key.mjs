/**
 * Updater signing key resolution — single source of truth (P2-3).
 *
 * Before P2-3 the home-directory key fallback was
 * written twice (package.json inline PS1 + prepare-github-release.mjs).
 * The PS1 copy is gone and this module now owns the only definition;
 * every consumer (build-release-env.mjs fail-fast probe,
 * prepare-github-release.mjs signing step) imports from here.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export const DEFAULT_SIGNING_KEY_NAME = ".tauri/niko-buddy-updater.key"
const LEGACY_SIGNING_KEY_NAME = ".tauri/qmai-updater.key"

/** Resolve the signing key path (env override wins, then new name, then legacy qmai name). */
export function resolveSigningKeyPath() {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "."
  const newPath = resolve(home, DEFAULT_SIGNING_KEY_NAME)
  if (existsSync(newPath)) return newPath
  const legacyPath = resolve(home, LEGACY_SIGNING_KEY_NAME)
  if (existsSync(legacyPath)) return legacyPath
  return newPath
}

/** Throw a descriptive error when the resolved key file is absent. */
export function assertSigningKeyExists() {
  const keyPath = resolveSigningKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error(`未找到 updater 签名私钥：${keyPath}`)
  }
  return keyPath
}