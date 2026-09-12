import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * 写作工作区工具抽屉的 e2e（T5 接线验收）。
 *
 * 范围声明：PDF 导出与批量替换此前**未挂进应用外壳**，2026-09-12 已接线到写作工作区
 * 底部工具条。本组用例只断言两件可观察的事：
 *   1. 两个面板都能从真实壳层点开、可切换；
 *   2. **展开抽屉本身不触发任何写盘/IPC 写操作**（面板只在自己按钮被点时调用命令，
 *      批量替换仍走「预览（只读）→ 写前门 → 人工确认」）。
 * 导出产物与事务/门的语义由 `e2e/pdf-export.spec.ts`、`e2e/batch-replace.spec.ts`
 * 与 Rust 单测覆盖，这里不重复。
 */

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  // 计数包装必须装在 MOCK_INIT 之后（后者才定义了 __TAURI_INTERNALS__）
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => unknown }
      __INVOKES__: string[]
    }
    w.__INVOKES__ = []
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
      w.__INVOKES__.push(cmd)
      return original(cmd, args)
    }
  })
  await page.goto("/")
  await page.getByRole("button", { name: "小说目录" }).click()
  await page.waitForSelector('[data-view="wiki"]', { timeout: 10000 })
}

const WRITEISH = /write_file|write_file_atomic|export_pdf|batch_replace|delete_file/

test.describe("写作工具抽屉 / 壳层可达性", () => {
  test("PDF 导出与批量替换可点开、可切换，且展开不触发写盘 IPC", async ({ page }) => {
    await boot(page)
    await page.waitForSelector('[data-testid="workspace-tools-bar"]', { timeout: 10000 })

    const baseline = await page.evaluate(() => {
      const w = window as unknown as { __INVOKES__: string[]; __MOCK_WRITES__?: unknown[] }
      return { invokes: w.__INVOKES__.length, writes: (w.__MOCK_WRITES__ ?? []).length }
    })

    // 展开 PDF 导出
    await page.click('[data-testid="workspace-tools-toggle-pdf"]')
    await expect(page.locator('[data-testid="pdf-export-dialog"]')).toBeVisible()
    await expect(page.locator('[data-testid="pdfexport-submit"]')).toBeVisible()
    await expect(page.locator('[data-testid="pdfexport-target"]')).toBeVisible()

    // 切到批量替换：PDF 面板收起，替换面板出现（入口互斥、不叠加）
    await page.click('[data-testid="workspace-tools-toggle-batch"]')
    await expect(page.locator('[data-testid="batch-replace-panel"]')).toBeVisible()
    await expect(page.locator('[data-testid="batchreplace-preview"]')).toBeVisible()
    await expect(page.locator('[data-testid="pdf-export-dialog"]')).toHaveCount(0)

    // 再点一次收起
    await page.click('[data-testid="workspace-tools-toggle-batch"]')
    await expect(page.locator('[data-testid="batch-replace-panel"]')).toHaveCount(0)

    const after = await page.evaluate(() => {
      const w = window as unknown as { __INVOKES__: string[]; __MOCK_WRITES__?: unknown[] }
      return { invokes: w.__INVOKES__.slice(), writes: w.__MOCK_WRITES__ ?? [] }
    })
    const newInvokes = after.invokes.slice(baseline.invokes)
    expect(newInvokes.filter((cmd) => WRITEISH.test(cmd))).toEqual([])
    // 启动/开项目本身会写 .qmai/owner.json，因此按**点击前后的增量**断言：
    // 展开与收起抽屉不得新增任何写入记录。
    expect(after.writes.slice(baseline.writes)).toEqual([])
  })
})
