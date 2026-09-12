import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

/**
 * F-001 写入确认门的 e2e（TASK-001 verify 项三）。
 *
 * **范围声明（诚实边界）**：本 spec 覆盖的是**页面内 IPC 边界**——浏览器环境下的
 * `window.__TAURI_INTERNALS__.invoke` 信封与裁决语义（受保护区硬拒 / 不可重建要确认 /
 * 可重建放行），以及应用启动契约。它**不**驱动 `ConfirmGateDialog` 的 UI 走查：
 * 该对话框尚未被应用壳层挂载（无宿主调用方），因此没有可点击入口可走。该缺口已在
 * 波次记录中显式登记为待接线项，不以本 spec 冒充覆盖。
 *
 * Rust 侧的真实语义（超时即拒绝 / CLI 不可绕过 / 熔断不自动恢复）由
 * `src-tauri/src/agent_gate.rs` 的内联 `#[cfg(test)]` 用例覆盖。
 */

async function invokeInPage(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate((payload) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }
    return w.__TAURI_INTERNALS__.invoke(payload.cmd, payload.args)
  }, { cmd, args })
}

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
}

test.describe("F-001 写入确认门 / IPC 边界", () => {
  test("受保护区对破坏性操作硬拒，CLI 也不能绕过", async ({ page }) => {
    await boot(page)
    const errors = collectErrors(page)

    for (const target of [".novel/status.json", "QM/raw/notes.md", "canon/entities.json"]) {
      const decision = await invokeInPage(page, "confirm_gate_classify", {
        op: "deleteFile",
        target,
        actor: "cli",
      })
      expect(decision, `target ${target} must be denied`).toBe("denied")
    }

    expect(errors).toEqual([])
  })

  test("不可重建目标要求确认，可重建目标直接放行", async ({ page }) => {
    await boot(page)

    expect(
      await invokeInPage(page, "confirm_gate_classify", {
        op: "deleteFile",
        target: "book/chapter-1.md",
        actor: "agent",
      }),
    ).toBe("require_confirm")

    expect(
      await invokeInPage(page, "confirm_gate_classify", {
        op: "deleteFile",
        target: ".novel/snapshots/ch1/body.md",
        actor: "agent",
      }),
    ).toBe("allowed")

    expect(
      await invokeInPage(page, "confirm_gate_classify", {
        op: "writeFile",
        target: "book/chapter-1.md",
        actor: "agent",
      }),
    ).toBe("allowed")
  })

  test("pending / resolve / loop_state 三个入口信封正确", async ({ page }) => {
    await boot(page)

    const pending = await invokeInPage(page, "confirm_gate_pending", {})
    expect(Array.isArray(pending)).toBe(true)
    expect(pending).toHaveLength(0)

    const resolved = (await invokeInPage(page, "confirm_gate_resolve", {
      requestId: "gate-1-0",
      decision: "denied",
      note: "rejected in e2e",
    })) as { decision: string; request_id: string }
    expect(resolved.decision).toBe("denied")
    expect(resolved.request_id).toBe("gate-1-0")

    const loop = (await invokeInPage(page, "confirm_gate_loop_state", {})) as {
      halted: boolean
      threshold: number
      window_ms: number
    }
    expect(loop.halted).toBe(false)
    expect(loop.threshold).toBe(3)
    expect(loop.window_ms).toBe(60000)
  })
})
