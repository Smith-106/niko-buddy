import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

/**
 * F-002 技能包离线协议的 e2e（TASK-006 verify 项三）。
 *
 * **范围声明（诚实边界）**：本 spec 覆盖的是**页面内 IPC 边界**——浏览器环境下的
 * `window.__TAURI_INTERNALS__.invoke` 信封形状与失败语义（confirmed 门 / 写入权威拒绝），
 * 以及应用启动契约。它**不**驱动导入对话框的 UI 走查：`SkillBundleImportDialog` 目前
 * 尚未被应用壳层挂载（无宿主调用方），因此没有可点击入口可走。该缺口已在波次记录中
 * 显式登记为待接线项，不以本 spec 冒充覆盖。
 *
 * Rust 侧的安全语义（路径穿越 / 可执行扩展名 / 回滚）由
 * `src-tauri/src/commands/skill_bundle.rs` 的内联 `#[cfg(test)]` 用例覆盖。
 */

async function invokeInPage(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
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

async function rejectedMessage(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    await invokeInPage(page, cmd, args)
    return ""
  } catch (cause) {
    return String(cause)
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(MOCK_INIT)
})

test("skill bundle IPC envelope round-trips and enforces the import gate", async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto("/")
  await expect(page.locator("#root")).not.toBeEmpty()

  // 导出：返回指纹与计数，不含任何可执行路径信息。
  const exported = (await invokeInPage(page, "skill_bundle_export", {
    skillIds: ["demo-a"],
    sourceRoot: "C:/mock/src",
    destPath: "C:/mock/user-assets/out/demo.nbskill.zip",
  })) as { id: string; content_hash: string; manifest_sha256: string }
  expect(exported.id).toBe("demo-a")
  expect(exported.content_hash).toHaveLength(64)
  expect(exported.manifest_sha256).toHaveLength(64)

  // 校验：清单可达（对话框据此逐项展示），信任级别恒为 untrusted。
  const verified = (await invokeInPage(page, "skill_bundle_verify", {
    bundlePath: "C:/mock/user-assets/out/demo.nbskill.zip",
  })) as {
    ok: boolean
    trust_level: string
    rejected: string[]
    manifest: { schema: string; allowlist: { writable_artifacts: string[] } }
  }
  expect(verified.ok).toBe(true)
  expect(verified.trust_level).toBe("untrusted")
  expect(verified.rejected).toEqual([])
  expect(verified.manifest.schema).toBe("nbskill/1")
  expect(verified.manifest.allowlist.writable_artifacts).toContain(".novel/drafts/")

  // 导入门：未确认即拒绝（RequireGate 的机械约束）。
  const unconfirmed = await rejectedMessage(page, "skill_bundle_import", {
    bundlePath: "C:/mock/user-assets/out/demo.nbskill.zip",
    destRoot: "C:/mock/user-assets",
    confirmed: false,
  })
  expect(unconfirmed).toContain("confirmation required")

  // 写入权威：canon 落点一律拒绝（即使已确认）。
  const denied = await rejectedMessage(page, "skill_bundle_import", {
    bundlePath: "C:/mock/user-assets/out/demo.nbskill.zip",
    destRoot: "C:/mock/project/canon",
    confirmed: true,
  })
  expect(denied).toContain("write denied")

  // 确认后导入成功，且落点在用户资产域、信任级别仍为 untrusted。
  const imported = (await invokeInPage(page, "skill_bundle_import", {
    bundlePath: "C:/mock/user-assets/out/demo.nbskill.zip",
    destRoot: "C:/mock/user-assets",
    confirmed: true,
  })) as { ok: boolean; trust_level: string; installed_dir: string; warnings: string[] }
  expect(imported.ok).toBe(true)
  expect(imported.trust_level).toBe("untrusted")
  expect(imported.installed_dir).toContain("skill_bundle/demo-a")
  expect(imported.warnings.join("|")).toContain("untrusted")

  expect(errors, `unexpected console/page errors: ${errors.join(" || ")}`).toEqual([])
})
