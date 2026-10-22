// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * UI 可用性走查 harness（多专家 UI 审计的实证臂）。
 *
 * 与 ui-walkthrough.spec.ts 的分工：
 * - ui-walkthrough 断言「导航可达 + 无 console error」；
 * - 本 spec 额外采集可用性度量（可点击密度 / 小目标 / 图标无标签 / 视图正文长度 / 导航层级），
 *   并把逐视图截图落到 `.workflow/ui-audit-20261016/shots/<label>/`，供改造前后对比。
 *
 * 环境变量 `UI_AUDIT_LABEL`（默认 "before"）决定截图目录后缀，例如：
 *   UI_AUDIT_LABEL=after npx playwright test e2e/ui-audit-walk.spec.ts
 */
import { test, expect } from "@playwright/test"
import { expandNavGroups } from "./nav"
import { MOCK_INIT, collectErrors } from "./tauri-mock"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LABEL = process.env.UI_AUDIT_LABEL ?? "before"
const SHOT_DIR = path.resolve(HERE, "..", "..", ".workflow", "ui-audit-20261016", "shots", LABEL)

const SIDEBAR_VIEWS = [
  "workbench",
  "wiki",
  "director",
  "sources",
  "graph",
  "lint",
  "soul",
  "skillLibrary",
  "storySimulation",
  "bookAnalysis",
  "canonEditor",
  "backupExport",
  "diagnosticsCenter",
  "reviewCenter",
  "dataManager",
  "search",
  "trash",
  "settings",
] as const

interface ViewMetrics {
  view: string
  contentTextLength: number
  clickableCount: number
  smallTargetCount: number
  iconOnlyWithoutLabel: number
  minFontSizePx: number
  maxNestingDepth: number
  headings: string[]
}

/** 内容区 = #root 内除左侧导航栏（[data-view] 的最近公共容器）外的可滚动主区。 */
async function measureView(page: import("@playwright/test").Page, view: string): Promise<ViewMetrics> {
  return page.evaluate((viewName) => {
    const root = document.querySelector("#root")
    const nav = document.querySelector('[data-view="wiki"]')?.closest("div")
    const navRail = nav?.parentElement ?? null
    const scope = root ?? document.body
    const controls = Array.from(scope.querySelectorAll<HTMLElement>("button, a[href], [role=button], input, select, textarea"))
      .filter((el) => {
        if (navRail && navRail.contains(el)) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null
      })
    const smallTargets = controls.filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width < 24 || rect.height < 24
    })
    const iconOnlyWithoutLabel = controls.filter((el) => {
      const text = (el.textContent ?? "").trim()
      if (text.length > 0) return false
      return !el.getAttribute("aria-label") && !el.getAttribute("title")
    })
    const fontSizes = Array.from(scope.querySelectorAll<HTMLElement>("*"))
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((n) => Number.isFinite(n) && n > 0)
    let maxDepth = 0
    const walk = (el: Element, depth: number) => {
      maxDepth = Math.max(maxDepth, depth)
      for (const child of Array.from(el.children)) walk(child, depth + 1)
    }
    const main = document.querySelector("main") ?? root
    if (main) walk(main, 1)
    const headings = Array.from(scope.querySelectorAll("h1, h2, h3"))
      .map((el) => (el.textContent ?? "").trim())
      .filter((t) => t.length > 0)
      .slice(0, 12)
    const contentText = (document.querySelector("main") ?? scope).textContent ?? ""
    return {
      view: viewName,
      contentTextLength: contentText.trim().length,
      clickableCount: controls.length,
      smallTargetCount: smallTargets.length,
      iconOnlyWithoutLabel: iconOnlyWithoutLabel.length,
      minFontSizePx: fontSizes.length ? Math.min(...fontSizes) : 0,
      maxNestingDepth: maxDepth,
      headings,
    }
  }, view)
}

test.describe("UI 审计走查", () => {
  test("写作闭环：未选章空态 + 选中章工具条度量 + 截图", async ({ page }) => {
    test.setTimeout(120_000)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.addInitScript(MOCK_INIT)
    await page.addInitScript("localStorage.setItem('niko-buddy-usage-guide-prompt-dismissed','1')")
    const errors = collectErrors(page)
    await page.goto("/")
    await page.waitForSelector("#root", { state: "attached" })
    await page.getByRole("button", { name: "小说目录" }).click()
    await page.waitForSelector('[data-view="wiki"]', { timeout: 15_000 })
    await page.waitForTimeout(600)

    // ① 未选章：编辑部空态
    await page.screenshot({ path: path.join(SHOT_DIR, "writing-empty-state.png") })
    const emptyState = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.querySelector("#root")!
      const buttons = Array.from(main.querySelectorAll<HTMLElement>("button")).filter(
        (el) => el.getBoundingClientRect().width > 0 && el.offsetParent !== null,
      )
      return { text: (main.textContent ?? "").trim().slice(0, 200), actionableInMain: buttons.length }
    })
    console.log(`[UI-EMPTY] text=${JSON.stringify(emptyState.text)} actionableInMain=${emptyState.actionableInMain}`)

    // ② 选中章：章节编辑器工具条
    const chapterNode = page.locator('[title*="chapter-001.md"]').first()
    await expect(chapterNode).toBeVisible({ timeout: 30_000 })
    await chapterNode.click()
    await expect(page.getByText("夜色沉静", { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(SHOT_DIR, "writing-with-chapter.png") })
    const toolbar = await page.evaluate(() => {
      const header = document.querySelector("[data-testid='chapter-editor-header']") ??
        Array.from(document.querySelectorAll("div")).find((d) => d.querySelector("input[title]") || d.querySelector("textarea")) ??
        document.querySelector("main")
      const scope = header as HTMLElement | null
      const buttons = scope
        ? Array.from(scope.querySelectorAll<HTMLElement>("button")).filter(
            (el) => el.getBoundingClientRect().width > 0 && el.offsetParent !== null,
          )
        : []
      return {
        toolbarButtonCount: buttons.length,
        toolbarLabels: buttons.map((b) => (b.textContent ?? b.getAttribute("title") ?? "").trim().slice(0, 12)).filter(Boolean),
        tooltipOnly: buttons.filter((b) => !(b.textContent ?? "").trim()).length,
      }
    })
    console.log(
      `[UI-TOOLBAR] count=${toolbar.toolbarButtonCount} tooltipOnly=${toolbar.tooltipOnly} labels=${JSON.stringify(toolbar.toolbarLabels)}`,
    )
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
  })

  test("18 视图逐屏度量 + 截图", async ({ page }) => {
    test.setTimeout(180_000)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.addInitScript(MOCK_INIT)
    await page.addInitScript("localStorage.setItem('niko-buddy-usage-guide-prompt-dismissed','1')")
    const errors = collectErrors(page)
    await page.goto("/")
    await page.waitForSelector("#root", { state: "attached" })
    // 首上手屏：先截图再进入主工作区
    await page.screenshot({ path: path.join(SHOT_DIR, "00-welcome.png"), fullPage: false })
    await page.getByRole("button", { name: "小说目录" }).click()
    await page.waitForSelector('[data-view="wiki"]', { timeout: 15_000 })
    await expandNavGroups(page)

    const metrics: ViewMetrics[] = []
    for (const view of SIDEBAR_VIEWS) {
      const btn = page.locator(`[data-view="${view}"]`)
      await expect(btn).toBeVisible()
      await btn.click()
      await expect(page.locator(`[data-view="${view}"].qm-selected`)).toBeVisible()
      await page.waitForTimeout(400)
      metrics.push(await measureView(page, view))
      await page.screenshot({ path: path.join(SHOT_DIR, `${view}.png`), fullPage: false })
    }

    const outFile = path.join(SHOT_DIR, "metrics.json")
    fs.writeFileSync(outFile, JSON.stringify(metrics, null, 2), "utf8")
    // 度量摘要（写入 stdout，便于审计报告引用）
    for (const m of metrics) {
      console.log(
        `[UI-METRIC] ${m.view} contentLen=${m.contentTextLength} clickable=${m.clickableCount} ` +
          `smallTargets=${m.smallTargetCount} iconNoLabel=${m.iconOnlyWithoutLabel} minFontPx=${m.minFontSizePx} ` +
          `depth=${m.maxNestingDepth} headings=${JSON.stringify(m.headings.slice(0, 4))}`,
      )
    }
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([])
    // 每个视图都必须渲染出可见内容（空屏 = 可用性缺陷）
    const empty = metrics.filter((m) => m.contentTextLength < 40)
    expect(empty.map((m) => m.view), "空视图（无可见正文）").toEqual([])
  })
})
