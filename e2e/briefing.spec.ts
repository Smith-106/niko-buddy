import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * F-003 续写简报的 e2e（TASK-003 verify 项二）。
 *
 * ## 覆盖范围与诚实边界
 *
 * playwright 的 webServer 是 `vite build && vite preview`（见 playwright.config.ts:9-30），
 * 只提供**构建产物**，因此浏览器里无法动态 import 源码模块（实测 `/src/.../*.ts` 取不到，
 * 报 `Failed to fetch dynamically imported module`）。据此本 spec 改为覆盖三件可在此层
 * 确实观测到的事：
 *
 * 1. 应用启动过程**没有任何写入类 IPC**（默认无写入路径在边界上的直接体现）；
 * 2. 简报的 4 个 i18n 键在 en/zh 双侧都存在（TASK-002 代写、TASK-003 消费）；
 * 3. 聚合器与渲染器源码里**不存在写入调用**（verify 项三的静态复核）。
 *
 * F-003 的逻辑覆盖（每条断言带 source、无 source 不渲染、canon 冲突走 divergence、
 * dueChapter 不被臆造、facts schema 不匹配降级）在
 * `src/lib/novel/briefing/__tests__/digest-aggregator.spec.ts` 有 15 个用例。
 * `BriefingPanel` 尚无应用壳层挂载点，因此没有可点击入口可走 UI 走查——缺口已登记。
 */

const REPO = process.cwd()

const WRITE_IPC = /(^|_)(write|create|delete|remove|rename|copy|export|save)/i

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.addInitScript(() => {
    const w = window as unknown as { __MOCK_CALLS__?: string[] }
    w.__MOCK_CALLS__ = []
  })
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await page.evaluate(() => {
    const w = window as unknown as {
      __MOCK_CALLS__: string[]
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
    }
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args?: unknown) => {
      w.__MOCK_CALLS__.push(cmd)
      return original(cmd, args)
    }
  })
}

test.describe("F-003 续写简报 / 只读边界", () => {
  test("应用启动不带任何写入类 IPC 调用", async ({ page }) => {
    await boot(page)
    // 触发一次渲染往返，确保初始化链路确实跑过。
    await page.waitForSelector("#root", { state: "attached" })
    await page.waitForTimeout(300)

    const calls = await page.evaluate(
      () => (window as unknown as { __MOCK_CALLS__?: string[] }).__MOCK_CALLS__ || [],
    )
    const writes = calls.filter((c) => WRITE_IPC.test(c))
    expect(writes).toEqual([])
  })

  test("briefing.* i18n 键在 en/zh 双侧齐备", () => {
    const keys = [
      "briefing.title",
      "briefing.source.badge",
      "briefing.divergence.warning",
      "briefing.patch.optin",
    ]
    for (const file of ["src/i18n/en.json", "src/i18n/zh.json"]) {
      const raw = readFileSync(resolve(REPO, file), "utf8")
      for (const key of keys) {
        expect(raw, `${file} 缺少 ${key}`).toContain(`"${key}"`)
      }
    }
  })

  test("聚合器与渲染器都不含写入通道（默认无写入路径）", () => {
    const targets = [
      "src/lib/novel/briefing/digest-aggregator.ts",
      "src/lib/novel/briefing/briefing-renderer.ts",
    ]
    for (const rel of targets) {
      const src = readFileSync(resolve(REPO, rel), "utf8")
      expect(src, `${rel} 出现写入调用`).not.toMatch(/writeFile|writeTextFile|invoke\(/);
    }
    const aggregator = readFileSync(resolve(REPO, targets[0]), "utf8")
    expect(aggregator).toContain("jsonPointer")
    const renderer = readFileSync(resolve(REPO, targets[1]), "utf8")
    expect(renderer).toContain("divergence")
    expect(renderer).toContain("QM/memory/")
  })
})
