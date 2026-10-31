import type { Page } from "@playwright/test"

/**
 * 展开全部导航分组与组内「更多 (N)」。
 *
 * 有书时首刷只展开「写作」「审改」，其余分组的 data-view 按钮要等分组展开后才进 DOM；
 * 批次三导航改六组后，secondary tier 视图（lint / skillLibrary 等）还额外藏在每组的
 * 「更多 (N)」开关（data-testid=nav-more-<group>）之后，所以两层都要展开。
 */
export async function expandNavGroups(page: Page): Promise<void> {
  // 6 个分组 + 每组的「更多」最多 12 次点击，16 次留余量。
  for (let guard = 0; guard < 16; guard++) {
    const collapsedGroup = page.locator('[data-nav-group] > button[aria-expanded="false"]').first()
    if (await collapsedGroup.count()) {
      await collapsedGroup.click()
      continue
    }
    const collapsedMore = page.locator('[data-testid^="nav-more-"][aria-expanded="false"]').first()
    if (await collapsedMore.count()) {
      await collapsedMore.click()
      continue
    }
    return
  }
}
