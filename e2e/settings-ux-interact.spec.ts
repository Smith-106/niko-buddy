// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 设置页交互截图：数字框失焦提交、保存后回显、深蓝主题更新日志页。
 * 截图落到 `.workflow/ui-audit-20261030-settings/shots/interact/`。
 *   npx playwright test e2e/settings-ux-interact.spec.ts
 */
import { test, expect, type Page } from "@playwright/test"
import { expandNavGroups } from "./nav"
import { MOCK_INIT, collectErrors } from "./tauri-mock"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.resolve(HERE, "..", "..", ".workflow", "ui-audit-20261030-settings", "shots", "interact")

async function openSettings(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(MOCK_INIT)
  await page.addInitScript("localStorage.setItem('niko-buddy-usage-guide-prompt-dismissed','1')")
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 15_000 })
  await expandNavGroups(page)
  await page.locator('[data-view="settings"]').click()
  await expect(page.locator("aside nav").last()).toBeVisible()
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOT_DIR, name) })

test("数字框失焦提交 + 保存回显 + 深蓝主题", async ({ page }) => {
  test.setTimeout(120_000)
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const errors = collectErrors(page)
  const log: string[] = []
  await openSettings(page)

  const nav = page.locator("aside nav").last()
  await nav.getByRole("button", { name: /重排/ }).click()
  await page.waitForTimeout(300)
  const expand = page.locator("[aria-expanded]").filter({ hasText: "启用重排" }).first()
  const input = page.getByLabel("最大重排候选数")
  if (!(await input.isVisible().catch(() => false))) await expand.click()
  await expect(input).toBeVisible()
  await input.scrollIntoViewIfNeeded()

  await input.fill("")
  await input.pressSequentially("1")
  log.push(`typing "1": value=${await input.inputValue()} aria-invalid=${await input.getAttribute("aria-invalid")}`)
  await shot(page, "01-typing-1.png")
  await input.pressSequentially("8")
  log.push(`typing "18": value=${await input.inputValue()}`)
  await input.fill("50")
  log.push(`typing "50": value=${await input.inputValue()} aria-invalid=${await input.getAttribute("aria-invalid")}`)
  await shot(page, "02-typing-50-invalid.png")
  await input.blur()
  log.push(`after blur: value=${await input.inputValue()}`)
  await shot(page, "03-after-blur-clamped.png")
  log.push(`unsaved hint visible: ${await page.getByText("有未保存的改动").isVisible().catch(() => false)}`)

  await input.fill("")
  await input.press("Enter")
  log.push(`empty + Enter: value=${await input.inputValue()}`)
  await input.fill("7")
  await input.press("Escape")
  log.push(`"7" + Esc: value=${await input.inputValue()}`)

  await page.getByTestId("settings-save-domain").scrollIntoViewIfNeeded().catch(() => {})
  await page.getByRole("button", { name: /^保存$/ }).click()
  await page.waitForTimeout(600)
  log.push(`after save: value=${await input.inputValue()} unsaved=${await page.getByText("有未保存的改动").isVisible().catch(() => false)}`)
  await shot(page, "04-after-save.png")

  // 深蓝主题：循环标题栏主题按钮直到 html 带 deep-blue
  for (let i = 0; i < 6; i++) {
    const cls = await page.evaluate(() => document.documentElement.className + " " + (document.documentElement.dataset.theme ?? ""))
    if (/deep-blue/.test(cls)) break
    await page.getByRole("button", { name: /^切换到.*模式$/ }).first().click()
    await page.waitForTimeout(250)
  }
  const finalCls = await page.evaluate(() => document.documentElement.className)
  log.push(`theme class: ${finalCls}`)
  await nav.getByRole("button", { name: /更新日志/ }).click()
  await page.waitForTimeout(400)
  await shot(page, "05-changelog-deep-blue.png")

  fs.writeFileSync(path.join(SHOT_DIR, "log.txt"), log.join("\n") + "\n")
  console.log("[INTERACT]\n" + log.join("\n"))
  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})
