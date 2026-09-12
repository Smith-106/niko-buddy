import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-004 应用锁 + 凭据库的 e2e（TASK-004 verify 项三）。
 *
 * **范围声明**：`AppLockOverlay` 尚未被应用壳层挂载（无宿主入口），本 spec 因此覆盖
 * 页面内的 IPC 边界（锁状态 / 验证 / 凭据四命令）与三条静态硬约束（manifest 恒
 * `credentials_included: false`、i18n 键双侧齐备、lib.rs 注册 7 条命令）。
 * Rust 侧的派生与不落盘性质由 `app_lock::applock::wrong_passphrase_rejects` 与
 * `credential_vault::vault::secret_not_in_data_sections` 覆盖。
 */

const REPO = process.cwd()

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
}

async function call(
  page: Page,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate((payload) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }
    return w.__TAURI_INTERNALS__.invoke(payload.cmd, payload.args)
  }, { cmd, args })
}

test.describe("F-004 应用锁与凭据库 / IPC 边界", () => {
  test("锁状态与验证：错误口令不放行", async ({ page }) => {
    await boot(page)

    expect(await call(page, "app_lock_state")).toBe("locked")
    expect(await call(page, "app_lock_verify", { passphrase: "wrong-horse" })).toBe(false)
    expect(await call(page, "app_lock_state")).toBe("locked")
    expect(await call(page, "app_lock_verify", { passphrase: "correct-horse" })).toBe(true)
  })

  test("凭据四命令往返且 credential_ref 不含明文", async ({ page }) => {
    await boot(page)

    const ref = (await call(page, "vault_put_secret", {
      key: "api-key",
      secret: "SECRET-VALUE",
    })) as string
    expect(ref).toBe("com.nikobuddy.app:api-key")
    expect(ref).not.toContain("SECRET-VALUE")

    expect(await call(page, "vault_get_secret", { key: "api-key" })).toBe("SECRET-VALUE")
    expect(await call(page, "vault_has_secret", { key: "api-key" })).toBe(true)
    expect(await call(page, "vault_delete_secret", { key: "api-key" })).toBe(true)
    expect(await call(page, "vault_has_secret", { key: "api-key" })).toBe(false)
    expect(await call(page, "vault_get_secret", { key: "api-key" })).toBeNull()
    expect(await call(page, "vault_delete_secret", { key: "api-key" })).toBe(false)
  })

  test("过短口令被拒（与 Rust 侧 MIN_PASSPHRASE_LEN 一致）", async ({ page }) => {
    await boot(page)
    const rejected = await page.evaluate(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
      try {
        await w.__TAURI_INTERNALS__.invoke("app_lock_set_passphrase", { passphrase: "abc" })
        return "__ACCEPTED__"
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    })
    expect(rejected).toContain("at least 6")
  })
})

test.describe("F-004 静态硬约束", () => {
  test("backup manifest 恒标 credentials_included: false", () => {
    const src = readFileSync(resolve(REPO, "src-tauri/src/commands/backup.rs"), "utf8")
    expect(src).toContain("credentials_included")
    expect(src).toMatch(/credentials_included:\s*false/)
  })

  test("i18n：vault.backup.excluded 双侧齐备", () => {
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = readFileSync(resolve(REPO, file), "utf8")
      expect(raw, `${file} 缺少 vault.backup.excluded`).toContain('"vault.backup.excluded"')
      expect(raw).toContain('"lock.overlay.title"')
    }
  })

  test("lib.rs 注册 F-004 的 7 条命令", () => {
    const src = readFileSync(resolve(REPO, "src-tauri/src/lib.rs"), "utf8")
    for (const cmd of [
      "app_lock_set_passphrase",
      "app_lock_verify",
      "app_lock_state",
      "vault_put_secret",
      "vault_get_secret",
      "vault_has_secret",
      "vault_delete_secret",
    ]) {
      expect(src, `lib.rs 未注册 ${cmd}`).toContain(cmd)
    }
  })
})
