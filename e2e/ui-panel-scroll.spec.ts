import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * 面板「滚动 / 重叠 / 泄露 / 状态显示」的回归断言。
 *
 * 背景（2026-09-13 实机回归，用户报告）：
 *   - 备份导出页与写作 Skill 页「不能鼠标滚轮上下移动」；
 *   - 「页面重叠、页面泄露」；
 *   - MCP 工具看不到连接状态。
 * 调查时先用临时 diag spec **只测量不断言**，本文件把那些测量固化为断言，防止复发。
 *
 * 判据是真实渲染几何（`getBoundingClientRect` / `scrollHeight` / 真实滚轮事件），
 * 不是源码字符串匹配——布局缺陷只能在这层被抓到。
 */

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
}

// 与 ui-walkthrough.spec.ts 同口径的 14 个侧栏视图（横向覆盖面）
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

/** 打开"写作 Skill"子视图（技能包面板的宿主）。 */
async function openWritingSkillLibrary(page: Page): Promise<void> {
  await page.click('[data-view="skillLibrary"]')
  await page.waitForSelector('[data-testid="unified-skill-library-view"]', { timeout: 10000 })
  await page.getByRole("button", { name: "写作 Skill", exact: true }).click()
  await page.waitForSelector('[data-testid="skill-pack-section"]', { timeout: 10000 })
}

test.describe("面板滚动与布局回归", () => {
  test("备份导出页自身是滚动容器，滚轮不再串到 document", async ({ page }) => {
    await boot(page)
    await page.click('[data-view="backupExport"]')
    const view = page.locator('[data-testid="backup-export-view"]')
    await view.waitFor({ timeout: 10000 })

    // 契约：视图根自己持滚动（宿主只给 h-full，祖先 overflow-hidden）。
    const geo = await view.evaluate((node) => ({
      overflowY: getComputedStyle(node).overflowY,
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
    }))
    expect(geo.overflowY).toBe("auto")
    // 内容必须确实溢出，否则下面的滚轮断言等于没测
    expect(geo.scrollH).toBeGreaterThan(geo.clientH)

    await view.hover()
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    expect(await view.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    // 滚动必须落在视图自身，不能落到 document（那正是"泄露"的症状）
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)

    // 滚到底后最后一张卡片完全可达
    const reached = await view.evaluate((node) => {
      node.scrollTop = node.scrollHeight
      const children = Array.from(node.children) as HTMLElement[]
      const last = children[children.length - 1]
      return {
        scrollTop: node.scrollTop,
        lastBottom: Math.round(last.getBoundingClientRect().bottom),
        vh: window.innerHeight,
      }
    })
    expect(reached.scrollTop).toBeGreaterThan(0)
    expect(reached.lastBottom).toBeLessThanOrEqual(reached.vh + 1)
  })

  test("写作 Skill 页：技能包区块限高，正文区恢复滚动", async ({ page }) => {
    await boot(page)
    await openWritingSkillLibrary(page)
    const viewportH = page.viewportSize()!.height

    // 契约：宿主给确定高度上限（面板声明 h-full + 内部 overflow-auto，
    // 父链无确定高度时 h-full 会解析为 auto 并把区块撑到 2000px+）。
    const pack = await page.locator('[data-testid="skill-pack-section"]').evaluate((node) => ({
      h: Math.round(node.getBoundingClientRect().height),
      overflowY: getComputedStyle(node).overflowY,
    }))
    expect(pack.overflowY).toBe("auto")
    expect(pack.h).toBeLessThanOrEqual(Math.round(viewportH * 0.38) + 2)

    // 修复前 main 被挤到约 40px；它必须重新拿到可观高度且真的能滚
    const main = page.locator('[data-testid="writing-skill-library-view"] main')
    const mainGeo = await main.evaluate((node) => ({
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
    }))
    expect(mainGeo.clientH).toBeGreaterThan(200)
    expect(mainGeo.scrollH).toBeGreaterThan(mainGeo.clientH)

    await main.hover()
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    expect(await main.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  })

  test("外壳无整页泄露：图标侧栏内部消化溢出，底部组仍在视口内", async ({ page }) => {
    await boot(page)
    const vh = page.viewportSize()!.height

    // 整页不能有竖向溢出（修复前 documentElement scrollHeight 920 > 720）
    const doc = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      vh: window.innerHeight,
    }))
    expect(doc.scrollH).toBeLessThanOrEqual(doc.vh + 1)

    const rail = page.locator(".nav-rail-scroll")
    const railGeo = await rail.evaluate((node) => ({
      overflowY: getComputedStyle(node).overflowY,
      clientH: node.clientHeight,
      scrollH: node.scrollHeight,
      parentClientH: (node.parentElement as HTMLElement).clientHeight,
      parentScrollH: (node.parentElement as HTMLElement).scrollHeight,
    }))
    expect(railGeo.overflowY).toBe("auto")
    // 导航项确实超高，所以滚动区是必需的而不是摆设
    expect(railGeo.scrollH).toBeGreaterThan(railGeo.clientH)
    // 溢出必须在侧栏内部被消化（父列不再溢出 = 不再漏到 document）
    expect(railGeo.parentScrollH).toBeLessThanOrEqual(railGeo.parentClientH + 1)

    // 底部按钮组（设置等）必须仍在视口内 —— 修复前它 bottom=920 被推出屏幕
    const bottomGroupBottom = await rail.evaluate((node) => {
      const group = (node.parentElement as HTMLElement).lastElementChild as HTMLElement
      return Math.round(group.getBoundingClientRect().bottom)
    })
    expect(bottomGroupBottom).toBeLessThanOrEqual(vh + 1)
  })

  test("MCP 工具：连接状态可见，并随真实连接/断开结果变化", async ({ page }) => {
    await boot(page)
    await page.click('[data-view="settings"]')
    await page.getByRole("button", { name: "MCP 工具", exact: true }).click()

    const badge = page.locator('[data-testid="mcp-transport-connection"]')
    const label = page.locator('[data-testid="mcp-transport-connection-label"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute("data-state", "idle")
    await expect(label).toHaveText("未连接")

    await page.fill('[data-testid="mcp-server-id"]', "demo")
    // stdio 没有远程端点：Mock（与 Rust 同语义）会拒统 connect，
    // 状态必须如实显示失败，而不是假装连上了。
    await page.click('[data-testid="mcp-transport-connect"]')
    await expect(badge).toHaveAttribute("data-state", "failed")
    await expect(label).toHaveText("连接失败")
    await expect(page.locator('[data-testid="mcp-transport-status"]')).toContainText("stdio")

    // 切到 http + 显式 opt-in 并保存后，远程会话才真实建立
    await page.selectOption('[data-testid="mcp-transport-mode"]', "http")
    await page.check('[data-testid="mcp-transport-optin"]')
    await page.click('[data-testid="mcp-transport-save"]')
    await page.click('[data-testid="mcp-transport-connect"]')
    await expect(badge).toHaveAttribute("data-state", "connected")
    await expect(label).toHaveText("已连接")
    // 详情来自 Rust 返回的 RemoteSession（不是前端猜测）
    await expect(page.locator('[data-testid="mcp-transport-connection-detail"]')).toContainText(
      "http://127.0.0.1:9/mcp",
    )

    await page.click('[data-testid="mcp-transport-close"]')
    await expect(badge).toHaveAttribute("data-state", "closed")
    await expect(label).toHaveText("已断开")
  })

  test("批量替换面板：空态给操作引导，结论行全中文", async ({ page }) => {
    await boot(page)
    await page.waitForSelector('[data-testid="workspace-tools-bar"]', { timeout: 10000 })
    await page.click('[data-testid="workspace-tools-toggle-batch"]')
    const panel = page.locator('[data-testid="batch-replace-panel"]')
    await expect(panel).toBeVisible()

    // 未操作前：引导文案，而非把"你还没填表"报成三条英文告警
    await expect(page.locator('[data-testid="batchreplace-empty-hint"]')).toBeVisible()
    await expect(page.locator('[data-testid="batchreplace-summary"]')).toHaveCount(0)
    const emptyText = (await panel.textContent()) ?? ""
    expect(emptyText).not.toMatch(/empty find text|no target files|nothing to replace/)
    expect(emptyText).not.toMatch(/0 replacements|replacements in \d+ file/)

    // 点过预览后：结论与拒绝原因都是中文（英文串曾来自 lib 层 formatSummary/assessSafety）
    await page.click('[data-testid="batchreplace-preview"]')
    await expect(page.locator('[data-testid="batchreplace-summary"]')).toBeVisible()
    await expect(page.locator('[data-testid="batchreplace-empty-hint"]')).toHaveCount(0)
    const text = (await panel.textContent()) ?? ""
    expect(text).toMatch(/尚无命中|处替换/)
    expect(text).not.toMatch(/empty find text|no target files|nothing to replace/)
    expect(text).not.toMatch(/replacements in \d+ file/)
    await expect(page.locator('[data-testid="batchreplace-safety"]')).toContainText("查找内容为空")
  })

  test("技能包面板不再泄漏英文计数与信任级别字面量", async ({ page }) => {
    await boot(page)
    await openWritingSkillLibrary(page)
    const panel = page.locator('[data-testid="skill-pack-panel"]')
    await expect(panel).toBeVisible()
    const text = (await panel.textContent()) ?? ""
    expect(text).not.toMatch(/\d+ skills/)
    expect(text).not.toMatch(/\d+ imported/)
    expect(text).not.toMatch(/trustLevel:/)
    expect(text).toMatch(/个技能/)
  })

  test("GENERALIZE：全部 14 个 sidebar 视图均无整页泄露", async ({ page }) => {
    await boot(page)
    const leaks: string[] = []
    for (const view of SIDEBAR_VIEWS) {
      await page.click(`[data-view="${view}"]`)
      await page.waitForTimeout(200)
      const geo = await page.evaluate(() => ({
        scrollH: document.documentElement.scrollHeight,
        vh: window.innerHeight,
      }))
      if (geo.scrollH > geo.vh + 1) leaks.push(`${view}: ${geo.scrollH} > ${geo.vh}`)
    }
    // 根因（overflow 逃出固定栏）是全局性的，所以判定也必须是全局的：
    // 任何一个视图能把 document 撑高，就说明同一族缺陷又回来了。
    expect(leaks).toEqual([])
  })
})
