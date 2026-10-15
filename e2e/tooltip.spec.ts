import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * 左侧图标栏悬浮提示的几何与文案检查。
 *
 * 起因（用户报告）：左侧小控制开关悬浮时的说明文字被一个小圆点遮住，
 * 且 `novel.nav.skillLibrary` / `novel.nav.storySimulation` 显示的是 i18n 键原文而非中文。
 *
 * 小圆点的来源是 tooltip 的箭头元素：Base UI 的 `Tooltip.Arrow` 只给出**沿边轴**的居中
 * 坐标，贴边方向必须由使用方按 `data-side` 指定；此前写死了 top 方向专用的 `translate-y`，
 * 于是 `side="right"`（左侧栏全部提示）的箭头停在弹层内部，看起来就是压在文字上的小点。
 *
 * 本 spec 把两个症状都变成可机器复核的断言：文案必须已本地化、箭头不得与文字矩形相交。
 */

const NAV_VIEWS = ["skillLibrary", "storySimulation", "wiki", "soul"]

async function openProject(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  # 208: 关使用引导弹窗（fixed left-48 z-50，会在 CI 视口下遮挡底部 settings 行）
  await page.addInitScript("localStorage.setItem('niko-buddy-usage-guide-prompt-dismissed','1')")
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
}

/** 悬浮后返回提示文案、文字矩形、箭头矩形及其重叠面积。
 *
 * #208（侧栏 w-44 图标+文字并排后）：导航行已改为行内文案 + 原生 title，不再挂载
 * Base UI Tooltip（无 [data-slot="tooltip-content"]）。本 probe 先读行内文案与
 * title；仅当 Tooltip 弹层存在时才走旧的箭头几何断言（后向兼容）。
 */
async function probe(page: Page, view: string) {
  const row = page.locator(`[data-view="${view}"]`)
  await expect(row).toBeVisible()
  const inlineText = ((await row.textContent()) ?? "").trim()
  const title = (await row.getAttribute("title")) ?? ""
  const popup = page.locator('[data-slot="tooltip-content"]')
  await row.hover()
  // 行内文案语义：悬浮不弹 Tooltip，行内已有本地化文案 + title 一致
  if ((await popup.count()) === 0) {
    return { inline: true, label: inlineText, title }
  }
  await expect(popup).toBeVisible()
  return page.evaluate(() => {
    const popupEl = document.querySelector('[data-slot="tooltip-content"]') as HTMLElement
    const arrowEl = popupEl?.querySelector('div[aria-hidden="true"]') as HTMLElement | null
    // 只量**文字节点**：量 popup 全内容会把装饰性箭头算进文字矩形，使重叠判定永远为真。
    const textNode = Array.from(popupEl?.childNodes ?? []).find(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 0,
    )
    const range = document.createRange()
    if (textNode) range.selectNodeContents(textNode)
    const r = (el: Element | Range | null) => {
      const b = el?.getBoundingClientRect()
      return b
        ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        : null
    }
    const text = r(range)
    const arrow = r(arrowEl)
    const popupRect = r(popupEl)
    let overlap = 0
    if (text && arrow) {
      const ox = Math.max(0, Math.min(text.x + text.w, arrow.x + arrow.w) - Math.max(text.x, arrow.x))
      const oy = Math.max(0, Math.min(text.y + text.h, arrow.y + arrow.h) - Math.max(text.y, arrow.y))
      overlap = Math.round(ox * oy)
    }
    return {
      label: (popupEl?.textContent ?? "").trim(),
      side: arrowEl?.dataset.side ?? null,
      text,
      arrow,
      popupRect,
      overlapAreaPx: overlap,
    }
  })
}

test.describe("左侧图标栏 tooltip", () => {
  test("提示文案已本地化，且箭头不覆盖文字", async ({ page }) => {
    await openProject(page)
    const rows: Record<string, unknown>[] = []
    for (const view of NAV_VIEWS) {
      rows.push({ view, ...(await probe(page, view)) })
      await page.mouse.move(600, 400)
    }
    console.log("[tooltip-probe]\n" + JSON.stringify(rows, null, 2))

    for (const row of rows) {
      const label = String(row.label)
      // 不得回落成 i18n 键原文（缺键时 i18next 会直接渲染键名）
      expect(label, `${row.view} 显示了未翻译的键`).not.toMatch(/^[a-z][\w.]*\.[a-zA-Z]/)
      expect(label.length, `${row.view} 文案为空`).toBeGreaterThan(0)
      if (row.inline) {
        // 行内文案语义：title 与行内文案一致（原生提示替代 Tooltip）
        expect(String(row.title), `${row.view} title 与行内文案不一致`).toBe(label)
      } else {
        // 旧 Tooltip 语义：箭头（小圆点）不得压在文字上
        expect(row.overlapAreaPx, `${row.view} 箭头与文字重叠 ${row.overlapAreaPx}px²`).toBe(0)
      }
    }
  })
})
