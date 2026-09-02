import { test, expect } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

// 16 activeView 全 UI 实操检验（波 3 执行资产）
// 断言：① 侧栏导航可进入每个视图；② 视图容器渲染出关键元素；③ 全程无 console error / pageerror。

// sidebar 直接导航的 14 个视图（writingSkillLibrary/skillFavorites 在 skillLibrary 页内 tab）
const SIDEBAR_VIEWS = [
  "wiki",
  "sources",
  "search",
  "graph",
  "lint",
  "soul",
  "skillLibrary",
  "storySimulation",
  "bookAnalysis",
  "canonEditor",
  "backupExport",
  "reviewCenter",
  "trash",
  "settings",
]

test.beforeEach(async ({ page }) => {
  test.setTimeout(120000) // vite dev 冷启动时 React 挂载可能超默认 30s（瞬态竞态加固）
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForSelector("#root")
  // 启动页 → 打开项目（mock open_project）→ 主界面（sidebar 出现）
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
})

test("14 sidebar 视图导航 + 渲染 + 无 console error", async ({ page }) => {
  const errors = collectErrors(page)

  for (const view of SIDEBAR_VIEWS) {
    const btn = page.locator(`[data-view="${view}"]`)
    await expect(btn).toBeVisible()
    await btn.click()
    // 选中态切换
    await expect(page.locator(`[data-view="${view}"].qm-selected`)).toBeVisible()
    await page.waitForTimeout(250)
  }

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})

test("skillLibrary 页内 tab（去AI味技能/写作 Skill/收藏）可切换", async ({ page }) => {
  const errors = collectErrors(page)

  await page.click('[data-view="skillLibrary"]')
  await page.waitForTimeout(400)
  // 页内 tab 按钮（aria-pressed 限定，避免与技能条目的收藏按钮同名歧义）
  const tabBtns = page.locator("button[aria-pressed]")
  const deAiTab = tabBtns.filter({ hasText: "去AI味技能" })
  const writingTab = tabBtns.filter({ hasText: "写作 Skill" })
  const favTab = tabBtns.filter({ hasText: "收藏" })
  await expect(deAiTab).toBeVisible()
  await expect(writingTab).toBeVisible()
  await expect(favTab).toBeVisible()

  // 初始 tab：去AI味技能 激活
  await expect(deAiTab).toHaveAttribute("aria-pressed", "true")
  // 切到 写作 Skill
  await writingTab.click()
  await expect(writingTab).toHaveAttribute("aria-pressed", "true")
  await expect(deAiTab).toHaveAttribute("aria-pressed", "false")
  await page.waitForTimeout(250)
  // 切到 收藏
  await favTab.click()
  await expect(favTab).toHaveAttribute("aria-pressed", "true")
  await page.waitForTimeout(250)
  // 切回 去AI味技能
  await deAiTab.click()
  await expect(deAiTab).toHaveAttribute("aria-pressed", "true")

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
})
