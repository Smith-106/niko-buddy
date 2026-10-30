import type { Page } from "@playwright/test"

/** 有书时首刷只展开「写作」「审改」。点开其余分组后，data-view 按钮才进入 DOM。 */
export async function expandNavGroups(page: Page): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    const toggle = page.locator('[data-nav-group] > button[aria-expanded="false"]').first()
    if ((await toggle.count()) === 0) return
    await toggle.click()
  }
}
