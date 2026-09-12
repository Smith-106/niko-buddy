import { invoke } from "@tauri-apps/api/core";

/**
 * 应用锁 + 凭据库的 TS 契约镜像（F-004）。
 *
 * 真源：`src-tauri/src/app_lock.rs` 与 `src-tauri/src/credential_vault.rs`。
 * 本文件不含裁决权——口令派生、设备绑定、凭据读写全在 Rust 侧，前端只能调用。
 */

export const APP_LOCK_KEY = "applock:passphrase";
export const VAULT_SERVICE = "com.nikobuddy.app";
export const VAULT_ACCOUNT_PREFIX = "niko-buddy:";
/** 与 Rust 侧 `MIN_PASSPHRASE_LEN` 对齐。 */
export const MIN_PASSPHRASE_LEN = 6;

export type LockState = "not_configured" | "locked" | "unlocked";

/**
 * 把 Rust 侧返回（serde `snake_case` 字符串、PascalCase 变体名或 `{Locked:null}` 形态）
 * 归一为字面量联合。无法识别时**保守返回 `locked`**：宁可要求验证，也不静默放行。
 */
export function toLockState(raw: unknown): LockState {
  const normalize = (value: string): LockState | null => {
    switch (value.toLowerCase().replace(/[^a-z]/g, "")) {
      case "notconfigured":
        return "not_configured";
      case "locked":
        return "locked";
      case "unlocked":
        return "unlocked";
      default:
        return null;
    }
  };

  if (typeof raw === "string") {
    return normalize(raw) ?? "locked";
  }
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as Record<string, unknown>)[0];
    if (key) return normalize(key) ?? "locked";
  }
  return "locked";
}

/** 是否必须显示遮挡层。 */
export function shouldShowOverlay(state: LockState): boolean {
  return state === "locked";
}

/** 口令规则与 Rust 侧一致：去空白后长度达标。 */
export function isPassphraseAcceptable(passphrase: string): boolean {
  return passphrase.trim().length >= MIN_PASSPHRASE_LEN;
}

export function passphraseRejectionReason(passphrase: string): string | null {
  if (isPassphraseAcceptable(passphrase)) return null;
  return `passphrase_too_short:${MIN_PASSPHRASE_LEN}`;
}

export async function setPassphrase(passphrase: string): Promise<LockState> {
  return toLockState(await invoke<unknown>("app_lock_set_passphrase", { passphrase }));
}

export async function verifyPassphrase(passphrase: string): Promise<boolean> {
  return Boolean(await invoke<boolean>("app_lock_verify", { passphrase }));
}

export async function lockState(): Promise<LockState> {
  return toLockState(await invoke<unknown>("app_lock_state"));
}

export async function vaultPutSecret(key: string, secret: string): Promise<string> {
  return invoke<string>("vault_put_secret", { key, secret });
}

export async function vaultGetSecret(key: string): Promise<string | null> {
  return invoke<string | null>("vault_get_secret", { key });
}

export async function vaultHasSecret(key: string): Promise<boolean> {
  return invoke<boolean>("vault_has_secret", { key });
}

export async function vaultDeleteSecret(key: string): Promise<boolean> {
  return invoke<boolean>("vault_delete_secret", { key });
}

/**
 * 备份**从不**包含凭据：manifest 的 `credentials_included` 恒为 false。
 * 恢复对话框必须显式展示这一点（i18n: `vault.backup.excluded`）。
 */
export function backupExcludesCredentials(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return true;
  const flag = (manifest as Record<string, unknown>).credentials_included;
  return flag === false || flag === undefined;
}
