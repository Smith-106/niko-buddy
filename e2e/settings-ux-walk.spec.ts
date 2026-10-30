// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 设置页 UX 走查：逐分类截图 + 可访问性度量，供改造前后对比。
 * 截图落到 `.workflow/ui-audit-20261030-settings/shots/<label>/`。
 *   UI_AUDIT_LABEL=after npx playwright test e2e/settings-ux-walk.spec.ts
 */
import { test, expect } from "@playwright/test"
import { expandNavGroups } from "./nav"
import { MOCK_INIT, collectErrors } from "./tauri-mock"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LABEL = process.env.UI_AUDIT_LABEL ?? "before"
const SHOT_DIR = path.resolve(HERE, "..", "..", ".workflow", "ui-audit-20261030-settings", "shots", LABEL)

test("设置页逐分类度量 + 截图", async ({ page }) => {
  test.setTimeout(180_000)
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(MOCK_INIT)
  await page.addInitScript("localStorage.setItem('niko-buddy-usage-guide-prompt-dismissed','1')")
  const errors = collectErrors(page)
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 15_000 })
  await expandNavGroups(page)
  await page.locator('[data-view="settings"]').click()
  const nav = page.locator("aside nav").last()
  await expect(nav).toBeVisible()
  const count = await nav.locator("button").count()
  const rows: string[] = []
  for (let i = 0; i < count; i++) {
    const btn = nav.locator("button").nth(i)
    const name = ((await btn.textContent()) ?? "").trim()
    await btn.click()
    await page.waitForTimeout(400)
    const m = await page.evaluate(() => {
      const main = document.querySelector("aside")?.nextElementSibling ?? document.body
      const vis = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (el as HTMLElement).offsetParent !== null
      }
      const controls = Array.from(main.querySelectorAll<HTMLElement>("button, a[href], [role=button], [role=switch], input, select, textarea")).filter(vis)
      const small = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24 }).length
      const unnamed = controls.filter((el) => !(el.textContent ?? "").trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title") && !(el as HTMLInputElement).labels?.length).length
      const toggleLike = controls.filter((el) => el.tagName === "BUTTON" && /rounded-full/.test(el.className) && /\bw-(8|9|10|11)\b/.test(el.className))
      const switchNoRole = toggleLike.filter((el) => el.getAttribute("role") !== "switch").length
      const labels = Array.from(main.querySelectorAll("label")).filter(vis)
      const orphanLabels = labels.filter((l) => !(l as HTMLLabelElement).control).length
      const ariaExpanded = main.querySelectorAll("[aria-expanded]").length
      const saveBar = !!document.querySelector('[data-testid="settings-save-domain"]')
      return { controls: controls.length, small, unnamed, switchNoRole, labels: labels.length, orphanLabels, ariaExpanded, saveBar }
    })
    const file = String(i).padStart(2, "0") + ".png"
    await page.screenshot({ path: path.join(SHOT_DIR, file), fullPage: false })
    rows.push(`${file}\t${name}\t${JSON.stringify(m)}`)
  }
  fs.writeFileSync(path.join(SHOT_DIR, "metrics.tsv"), rows.join("\n") + "\n")
  console.log("[SETTINGS-UX]\n" + rows.join("\n"))
  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})
