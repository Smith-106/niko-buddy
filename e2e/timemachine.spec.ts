import { test, expect, type Page } from "@playwright/test"
import { MOCK_INIT, collectErrors } from "./tauri-mock"

/**
 * F-002 快照时间机器的 e2e（TASK-002 verify 项三）。
 *
 * **范围声明（诚实边界）**：本 spec 覆盖的是**页面内 IPC 边界**——`snapshot_list_chain`
 * 的分页信封、`snapshot_preview_point` 的前后对照载荷、以及 `snapshot_restore_atomic`
 * 的确认令牌门与回滚失败语义。它**不**驱动 `SnapshotTimeline` 的 UI 走查：该组件尚未被
 * 应用壳层挂载（无宿主调用方），因此没有可点击入口可走。该缺口已在波次记录中显式登记。
 *
 * Rust 侧的原子性与回滚语义（`.tmp` + rename + 逆序还原 + canon 复验）由
 * `src-tauri/src/snapshot_timemachine.rs` 的内联 `#[cfg(test)]` 用例覆盖。
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

async function invokeExpectError(
  page: Page,
  cmd: string,
  args: Record<string, unknown>,
): Promise<string> {
  return page.evaluate(
    async (payload) => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
      try {
        await w.__TAURI_INTERNALS__.invoke(payload.cmd, payload.args)
        return "__NO_ERROR__"
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    { cmd, args },
  )
}

async function boot(page: Page): Promise<void> {
  await page.addInitScript(MOCK_INIT)
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
}

test.describe("F-002 快照时间机器 / IPC 边界", () => {
  test("时间线枚举带回分页字段与章节跨度", async ({ page }) => {
    await boot(page)
    const errors = collectErrors(page)

    const chain = (await invokeInPage(page, "snapshot_list_chain", {
      projectPath: "C:/mock/proj",
      offset: 0,
      limit: 50,
    })) as {
      points: Array<{ id: string; chapter_span: string | null; file_count: number }>
      total: number
      page_size: number
    }

    expect(chain.total).toBe(2)
    expect(chain.page_size).toBe(50)
    expect(chain.points.map((p) => p.id)).toEqual(["ch-10-20", "ch-1-9"])
    expect(chain.points[0].chapter_span).toBe("10-20")
    expect(errors).toEqual([])
  })

  test("单点前后对照返回三个面的 diff", async ({ page }) => {
    await boot(page)

    const diff = (await invokeInPage(page, "snapshot_preview_point", {
      projectPath: "C:/mock/proj",
      snapshotId: "ch-10-20",
    })) as {
      snapshot_id: string
      status_diff: unknown[]
      projection_status_diff: unknown[]
      world_state_diffs: Array<{ state: string }>
    }

    expect(diff.snapshot_id).toBe("ch-10-20")
    expect(diff.status_diff).toHaveLength(1)
    expect(diff.projection_status_diff).toHaveLength(1)
    expect(diff.world_state_diffs[0].state).toBe("characters")
  })

  test("原子恢复必须带确认令牌，回滚失败语义可判定", async ({ page }) => {
    await boot(page)

    const noToken = await invokeExpectError(page, "snapshot_restore_atomic", {
      projectPath: "C:/mock/proj",
      snapshotId: "ch-10-20",
      confirmToken: "   ",
    })
    expect(noToken).toContain("confirmation token")

    const rolled = await invokeExpectError(page, "snapshot_restore_atomic", {
      projectPath: "C:/mock/proj",
      snapshotId: "ch-10-20",
      confirmToken: "rollback",
    })
    expect(rolled).toContain("rolled back")

    const ok = (await invokeInPage(page, "snapshot_restore_atomic", {
      projectPath: "C:/mock/proj",
      snapshotId: "ch-10-20",
      confirmToken: "ui-ch-10-20",
    })) as {
      restored: string[]
      rolled_back: boolean
      gate_decision: string
      verify: { verified: boolean } | null
    }
    expect(ok.rolled_back).toBe(false)
    expect(ok.gate_decision).toBe("allowed")
    expect(ok.restored).toContain(".novel/status.json")
    expect(ok.verify?.verified).toBe(true)
  })
})
