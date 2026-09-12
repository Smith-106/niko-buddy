import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MOCK_INIT } from "./tauri-mock"

/**
 * 界面文本完整性回归（三模型审计 round-1 的收敛判据）。
 *
 * 背景：round-1 实机确认了四类同源缺陷 —— 用户界面上出现
 *   ① i18n 占位符原样渲染（`{{n}} 个技能`：传了 `count`，翻译值写的是 `{{n}}`）；
 *   ② `t()` 用了不存在的键（`backup.cloud.save` / `settings.sections.mcp.transport`
 *      / `novel.snapshot.close` 直接把键名显示在按钮和 aria-label 上）；
 *   ③ lib 产出的英文自然语言被面板直接渲染；
 *   ④ 机器码（BLOCK/WARN/digest/supersede）进入可见文本。
 *
 * 这条断言是它们的**共同安全网**：任何一类的可见文本都会命中，且与具体面板无关。
 * 判据取真实渲染后的 `innerText` 与 `aria-label`，不是源码字符串匹配。
 */

/** 未渲染的插值占位符（i18next 缺参 / 名不符）。 */
const PLACEHOLDER = /\{\{|\}\}/

/**
 * 原始键名判据 = 可见文本里出现了**真实存在的 i18n 键**。
 *
 * 不用「点分三元组」启发式：设置页合法展示了 provider 主机名（`api.deepseek.com`）。
 * 键目录来自 zh/en 真源，误报率接近零且随语料自动更新。
 */
function flatten(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return prefix ? [prefix] : []
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key),
  )
}

function i18nKeys(): string[] {
  const root = process.cwd()
  const keys = ["zh.json", "en.json"].flatMap((name) =>
    flatten(JSON.parse(readFileSync(join(root, "src", "i18n", name), "utf8"))),
  )
  // 只保留点分键：单段键（id / name）会与内容撞车。
  return [...new Set(keys.filter((key) => key.includes(".")))].sort(
    (a, b) => b.length - a.length,
  )
}

const KEY_SOURCE = `(?<![\\w.:-])(?:${i18nKeys()
  .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})(?![\\w.-])`

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

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForSelector("#root", { state: "attached" })
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
}

interface Leaks {
  placeholders: string[]
  rawKeys: string[]
  ariaKeys: string[]
}

async function scan(page: Page): Promise<Leaks> {
  return page.evaluate(
    ({ keySource }) => {
      const re = new RegExp(keySource, "g")
      const leaks = (text: string): string[] => {
        const out = text.match(re) ?? []
        if (/\{\{|\}\}/.test(text)) out.push(`[placeholder] ${text.slice(0, 120)}`)
        return out
      }
      const body = document.body.innerText ?? ""
      const ariaKeys: string[] = []
      for (const node of Array.from(document.querySelectorAll("[aria-label]"))) {
        ariaKeys.push(...leaks(node.getAttribute("aria-label") ?? ""))
      }
      return {
        placeholders: /\{\{|\}\}/.test(body) ? [body.slice(0, 400)] : [],
        rawKeys: leaks(body).filter((hit) => !hit.startsWith("[placeholder]")),
        ariaKeys,
      }
    },
    { keySource: KEY_SOURCE },
  )
}

function expectClean(leaks: Leaks, where: string): void {
  expect(leaks.placeholders, `${where}: 可见文本含未渲染的 i18n 占位符`).toEqual([])
  expect(leaks.rawKeys, `${where}: 可见文本含原始 i18n 键名`).toEqual([])
  expect(leaks.ariaKeys, `${where}: aria-label 含未渲染占位符或原始键名`).toEqual([])
}

test.describe("界面文本完整性（i18n 与机器码不外泄）", () => {
  for (const view of SIDEBAR_VIEWS) {
    test(`侧栏视图 ${view} 的可见文本不含占位符/原始键`, async ({ page }) => {
      await boot(page)
      await page.click(`[data-view="${view}"]`)
      await page.waitForTimeout(600)
      expectClean(await scan(page), `视图 ${view}`)
    })
  }

  test("写作 Skill 视图（技能包面板）同口径", async ({ page }) => {
    await boot(page)
    await page.click('[data-view="skillLibrary"]')
    await page.waitForSelector('[data-testid="unified-skill-library-view"]', { timeout: 10000 })
    await page.getByRole("button", { name: "写作 Skill", exact: true }).click()
    await page.waitForSelector('[data-testid="skill-pack-panel"]', { timeout: 10000 })
    expectClean(await scan(page), "技能包面板")
  })

  test("批量替换面板：canon 写前门不得把 lib 诊断串当文案", async ({ page }) => {
    await boot(page)
    // 面板属于工作区工具条，先开工具条再开面板。
    await page.click('[data-view="wiki"]')
    const tools = page.locator('[data-testid="workspace-tools-bar"]')
    if (await tools.count()) {
      const toggle = tools.locator("button", { hasText: "批量替换" }).first()
      if (await toggle.count()) {
        await toggle.click()
        await page.waitForTimeout(400)
      }
    }
    expectClean(await scan(page), "批量替换面板")
  })
})
