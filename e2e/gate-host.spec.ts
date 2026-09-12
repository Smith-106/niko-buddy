import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT } from "./tauri-mock"

/**
 * 门与锁的**壳层宿主** e2e（B-F-001 / F-004 接线）。
 *
 * 与前两个 spec 的分工：
 * - `gate.spec.ts` / `app-lock.spec.ts` 覆盖页面内 IPC 边界（信封与裁决语义）；
 * - 本 spec 覆盖**真实应用壳层**：`App` 挂载 `GateHost` 与 `AppLockOverlay` 之后，
 *   轮询取回的待裁决请求会真的渲染成可点击弹窗、熔断会真的渲染成横幅、锁状态会真的
 *   挡住入口。此前这三个面板都没有宿主调用方，因此没有任何可点击路径。
 */

interface HostSeed {
  lock?: string
  pending?: unknown[]
  loop?: Record<string, unknown>
}

/** 先注入 mock，再注入宿主所需的初始状态（页面脚本执行前生效）。 */
async function boot(page: Page, seed: HostSeed = {}): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.addInitScript((s: HostSeed) => {
    const w = window as unknown as Record<string, unknown>
    if (s.lock !== undefined) w.__MOCK_LOCK_STATE__ = s.lock
    w.__MOCK_GATE_PENDING__ = s.pending ?? []
    if (s.loop !== undefined) w.__MOCK_GATE_LOOP__ = s.loop
  }, seed)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
}

function runningLoop(overrides: Record<string, unknown> = {}) {
  return {
    halted: false,
    fingerprint: null,
    halt_request_id: null,
    count: 0,
    window_ms: 60_000,
    threshold: 3,
    since_ms: null,
    reason: null,
    ...overrides,
  }
}

test.describe("门与锁的壳层宿主", () => {
  test("锁屏：未解锁前遮挡，错误口令不放行，正确口令后消失", async ({ page }) => {
    await boot(page, { lock: "locked" })

    const overlay = page.getByTestId("app-lock-overlay")
    await expect(overlay).toBeVisible({ timeout: 15_000 })
    // 遮罩层不接受关闭语义：没有关闭按钮。
    await expect(page.getByRole("button", { name: /关闭|取消|close/i })).toHaveCount(0)

    await page.getByTestId("app-lock-input").fill("wrong-horse")
    await page.getByTestId("app-lock-unlock").click()
    await expect(page.getByTestId("app-lock-error")).toBeVisible()
    await expect(overlay).toBeVisible()

    await page.getByTestId("app-lock-input").fill("correct-horse")
    await page.getByTestId("app-lock-unlock").click()
    await expect(overlay).toHaveCount(0)
    expect(await page.evaluate(() => (window as never as Record<string, unknown>).__MOCK_LAST_VERIFY__)).toBe(
      "correct-horse",
    )
  })

  test("待裁决请求渲染成弹窗，拒绝走既有 resolve", async ({ page }) => {
    await boot(page, {
      lock: "unlocked",
      pending: [
        {
          request_id: "req-e2e-1",
          op: "batchReplace",
          target: "QM/memory/facts.md",
          class: "irreversible",
          hit_criteria: ["protected_prefix"],
          actor: "external",
          created_at_ms: Date.now(),
          deadline_ms: Date.now() + 120_000,
          diff_summary: "-旧 +新",
        },
      ],
      loop: runningLoop(),
    })

    const dialog = page.getByTestId("confirm-gate-dialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("confirm-gate-target")).toContainText("QM/memory/facts.md")
    await expect(page.getByTestId("confirm-gate-criteria")).toContainText("受保护区真源面")

    await page.getByTestId("confirm-gate-reject").click()
    const resolved = await page.evaluate(
      () => (window as never as Record<string, unknown>).__MOCK_GATE_RESOLVED__,
    )
    expect(resolved).toMatchObject({ requestId: "req-e2e-1", decision: "denied" })

    // 请求被裁决后从待裁决集合移除 → 宿主下一轮轮询应收回弹窗。
    await page.evaluate(() => {
      ;(window as never as Record<string, unknown>).__MOCK_GATE_PENDING__ = []
    })
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  })

  test("熔断渲染横幅，恢复只带 halt_request_id", async ({ page }) => {
    await boot(page, {
      lock: "unlocked",
      pending: [],
      loop: runningLoop({ halted: true, halt_request_id: "halt-e2e-9", count: 3, reason: "loop threshold reached" }),
    })

    const banner = page.getByTestId("gate-halt-banner")
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText("不会自行恢复")

    await page.getByTestId("gate-halt-resume").click()
    const resolved = await page.evaluate(
      () => (window as never as Record<string, unknown>).__MOCK_GATE_RESOLVED__,
    )
    expect(resolved).toMatchObject({ requestId: "halt-e2e-9", decision: "resume_after_halt" })
  })
})
