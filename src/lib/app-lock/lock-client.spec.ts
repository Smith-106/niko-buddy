import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import {
  APP_LOCK_KEY,
  MIN_PASSPHRASE_LEN,
  VAULT_ACCOUNT_PREFIX,
  VAULT_SERVICE,
  backupExcludesCredentials,
  isPassphraseAcceptable,
  lockState,
  passphraseRejectionReason,
  setPassphrase,
  shouldShowOverlay,
  toLockState,
  vaultDeleteSecret,
  vaultGetSecret,
  vaultHasSecret,
  vaultPutSecret,
  verifyPassphrase,
} from "./lock-client";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
});

describe("lock-client / 状态归一", () => {
  it("识别三种状态字面量", () => {
    expect(toLockState("not_configured")).toBe("not_configured");
    expect(toLockState("locked")).toBe("locked");
    expect(toLockState("unlocked")).toBe("unlocked");
    expect(toLockState("Unlocked")).toBe("unlocked");
  });

  it("未知形态保守返回 locked（不静默放行）", () => {
    expect(toLockState(undefined)).toBe("locked");
    expect(toLockState(42)).toBe("locked");
    expect(toLockState("weird")).toBe("locked");
  });

  it("serde 枚举对象形态也能归一", () => {
    expect(toLockState({ Locked: null })).toBe("locked");
    expect(toLockState({ NotConfigured: null })).toBe("not_configured");
  });

  it("只有 locked 才显示遮挡层", () => {
    expect(shouldShowOverlay("locked")).toBe(true);
    expect(shouldShowOverlay("unlocked")).toBe(false);
    expect(shouldShowOverlay("not_configured")).toBe(false);
  });
});

describe("lock-client / 口令规则与 IPC", () => {
  it("口令长度规则与 Rust 对齐", () => {
    expect(MIN_PASSPHRASE_LEN).toBe(6);
    expect(isPassphraseAcceptable("correct-horse")).toBe(true);
    expect(isPassphraseAcceptable("abc")).toBe(false);
    expect(isPassphraseAcceptable("      ")).toBe(false);
    expect(passphraseRejectionReason("abc")).toBe("passphrase_too_short:6");
    expect(passphraseRejectionReason("correct-horse")).toBeNull();
  });

  it("setPassphrase 走 app_lock_set_passphrase 并归一返回值", async () => {
    invokeMock.mockResolvedValue("Unlocked");
    await expect(setPassphrase("correct-horse")).resolves.toBe("unlocked");
    expect(invokeMock).toHaveBeenCalledWith("app_lock_set_passphrase", {
      passphrase: "correct-horse",
    });
  });

  it("verifyPassphrase 返回布尔", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(verifyPassphrase("correct-horse")).resolves.toBe(true);
    invokeMock.mockResolvedValue(false);
    await expect(verifyPassphrase("wrong")).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("app_lock_verify", { passphrase: "wrong" });
  });

  it("lockState 归一 Rust 侧取值", async () => {
    invokeMock.mockResolvedValue("NotConfigured");
    await expect(lockState()).resolves.toBe("not_configured");
  });
});

describe("lock-client / 凭据库", () => {
  it("命名空间常量与 Rust 侧一致", () => {
    expect(VAULT_SERVICE).toBe("com.nikobuddy.app");
    expect(VAULT_ACCOUNT_PREFIX).toBe("niko-buddy:");
    expect(APP_LOCK_KEY).toBe("applock:passphrase");
  });

  it("四个凭据命令的信封", async () => {
    invokeMock.mockResolvedValue("com.nikobuddy.app:api-key");
    await expect(vaultPutSecret("api-key", "SECRET")).resolves.toBe(
      "com.nikobuddy.app:api-key",
    );
    expect(invokeMock).toHaveBeenCalledWith("vault_put_secret", {
      key: "api-key",
      secret: "SECRET",
    });

    invokeMock.mockResolvedValue("SECRET");
    await expect(vaultGetSecret("api-key")).resolves.toBe("SECRET");
    expect(invokeMock).toHaveBeenCalledWith("vault_get_secret", { key: "api-key" });

    invokeMock.mockResolvedValue(true);
    await expect(vaultHasSecret("api-key")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("vault_has_secret", { key: "api-key" });

    invokeMock.mockResolvedValue(false);
    await expect(vaultDeleteSecret("api-key")).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("vault_delete_secret", { key: "api-key" });
  });

  it("返回值不含明文凭据（credential_ref 只到键名）", async () => {
    invokeMock.mockResolvedValue("com.nikobuddy.app:api-key");
    const ref = await vaultPutSecret("api-key", "SECRET");
    expect(ref).not.toContain("SECRET");
  });
});

describe("lock-client / 备份与凭据", () => {
  it("manifest 缺省或 false 都表示备份不含凭据", () => {
    expect(backupExcludesCredentials({ credentials_included: false })).toBe(true);
    expect(backupExcludesCredentials({})).toBe(true);
    expect(backupExcludesCredentials(null)).toBe(true);
  });

  it("manifest 声称含凭据时返回 false（需显式告知用户）", () => {
    expect(backupExcludesCredentials({ credentials_included: true })).toBe(false);
  });
});
