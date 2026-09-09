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

export const DEFAULT_SIGNING_KEY_NAME = ".tauri/qmai-updater.key"

/** Resolve the signing key path (env override wins over the home fallback). */
export function resolveSigningKeyPath() {
  return (
    process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ||
    resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", DEFAULT_SIGNING_KEY_NAME)
  )
}

/** Throw a descriptive error when the resolved key file is absent. */
export function assertSigningKeyExists() {
  const keyPath = resolveSigningKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error(`未找到 updater 签名私钥：${keyPath}`)
  }
  return keyPath
}