import { test, expect } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

/**
 * 面板接线 e2e：`CloudBackupPanel`（F-004 云端备份）与 `SnapshotTimeline`（F-002 快照时间机器）
 * 此前**均未挂进应用外壳**（各自 e2e 里自述「未挂进应用外壳，本任务不改路由」），真实应用里
 * 没有任何入口。本 spec 驱动**真实应用壳层**验证接线已生效，即：
 *   侧栏 `backupExport` 视图 → 两个面板以真实组件渲染（非 mock 替身）。
 *
 * 边界声明：本 spec 只证明**可达性**（入口存在、组件渲染、设备标识可用）。
 * 面板自身的行为契约仍由 `cloud-backup.spec.ts` / `timemachine.spec.ts` 的 IPC 边界断言覆盖。
 */

async function openBackupExport(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
  await page.click('[data-view="backupExport"]')
  await page.waitForSelector('[data-testid="backup-export-view"]', { timeout: 10000 })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
})

test("backupExport 视图内两个面板均以真实组件渲染", async ({ page }) => {
  const errors = collectErrors(page)
  await openBackupExport(page)

  await expect(page.locator('[data-testid="cloud-backup-panel"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="snapshot-timeline"]')).toBeVisible({ timeout: 10000 })
  // 面板自带的标题来自既有 i18n 键，出现即证明键可解析（不是裸 key）
  await expect(page.getByText("云端备份", { exact: false }).first()).toBeVisible()
  await expect(page.getByText("快照时间线", { exact: false }).first()).toBeVisible()

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test("本机标识：首次即生成、随输入清洗、写入 localStorage 并流向面板", async ({ page }) => {
  const errors = collectErrors(page)
  await openBackupExport(page)

  const input = page.locator("#backup-device-id")
  const generated = await input.inputValue()
  expect(generated).toMatch(/^dev-[A-Za-z0-9_-]+$/)
  expect(await page.evaluate(() => localStorage.getItem("qmai.deviceId"))).toBe(generated)

  // 非法字符被剔除后持久化（空格 / 斜杠 / 井号）
  await input.fill("desk top/01#x")
  await expect(input).toHaveValue("desktop01x")
  expect(await page.evaluate(() => localStorage.getItem("qmai.deviceId"))).toBe("desktop01x")

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test("设备标识在重载后保持（冲突副本命名不会因重启而漂移）", async ({ page }) => {
  const errors = collectErrors(page)
  await openBackupExport(page)
  const first = await page.locator("#backup-device-id").inputValue()

  await page.reload()
  await page.waitForSelector("#root", { state: "attached" })
  await openBackupExport(page)

  await expect(page.locator("#backup-device-id")).toHaveValue(first)

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})
