// @vitest-environment jsdom
/**
 * C3 确认门错误态 spec：裁决 IPC 失败必须给可修复反馈（错误态 + 重试），
 * 且超时自动裁决每次请求只发起一次 —— 失败后不自动重发（防重试风暴）。
 */
import { cleanup as rtlCleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { act, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  confirmGate: vi.fn(),
  rejectGate: vi.fn(),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    confirmGate: mocks.confirmGate,
    rejectGate: mocks.rejectGate,
  }
})

// 本仓库的 gate.* 资源是「扁平点号键」，i18next 能同时解析扁平键与嵌套键；
// 全局 setup 的测试 mock 只做嵌套查找，这里按生产同口径查找（先扁平后嵌套）。
vi.mock("react-i18next", async () => {
  const zh = (await import("@/i18n/zh.json")).default as Record<string, unknown>
  function lookup(key: string): string | undefined {
    if (typeof zh[key] === "string") return zh[key] as string
    let o: unknown = zh
    for (const p of key.split(".")) {
      if (o == null || typeof o !== "object") return undefined
      o = (o as Record<string, unknown>)[p]
    }
    return typeof o === "string" ? o : undefined
  }
  const t = (key: string, opts?: Record<string, unknown>) => {
    let s = lookup(key) ?? key
    if (opts) {
      for (const [k, v] of Object.entries(opts)) s = s.split(`{{${k}}}`).join(String(v))
    }
    return s
  }
  const shared = { t, i18n: { language: "zh", changeLanguage: () => Promise.resolve("zh") } }
  return {
    initReactI18next: { type: "3rdParty", init: () => {} },
    useTranslation: () => shared,
    Trans: ({ children }: { children?: unknown }) => children,
    I18nextProvider: ({ children }: { children?: unknown }) => children,
  }
})

import type { PendingGate } from "@/lib/novel"

import { ConfirmGateDialog } from "./ConfirmGateDialog"

const OUTCOME = {
  decision: "allowed" as const,
  class: "irreversible" as const,
  hit_criteria: ["protected_prefix"],
  request_id: "req-1",
  reason: "",
}

/** 与 PendingGate 精确对齐（class: RebuildClass、actor: GateActor 均为字面量联合），
 *  避免工厂内对象字面量被宽化为 string 而与 PendingGate 不兼容。 */
function pendingGate(overrides: Partial<PendingGate> = {}): PendingGate {
  const createdAt = Date.now()
  return {
    request_id: "req-1",
    op: "batchReplace",
    target: "QM/memory/facts.md",
    class: "irreversible",
    hit_criteria: ["protected_prefix"],
    actor: "external",
    created_at_ms: createdAt,
    deadline_ms: createdAt + 120_000,
    diff_summary: "-旧 +新",
    ...overrides,
  }
}

describe("ConfirmGateDialog — C3 错误态与重试", () => {
  beforeEach(() => {
    setupDomGlobals()
    mocks.confirmGate.mockReset().mockResolvedValue(OUTCOME)
    mocks.rejectGate.mockReset().mockResolvedValue({ ...OUTCOME, decision: "denied" })
  })

  afterEach(() => {
    rtlCleanup()
  })

  it("确认裁决 IPC 失败 → 错误态可见，且不触发 onResolved", async () => {
    mocks.confirmGate.mockRejectedValueOnce(new Error("gate ipc down"))
    const onResolved = vi.fn()
    render(<ConfirmGateDialog pending={pendingGate()} onResolved={onResolved} />)

    await act(async () => {
      screen.getByTestId("confirm-gate-accept").click()
    })

    // 全量并发下 act 后的微任务可能晚一拍落地：异步等待错误态，避免同步断言抖动。
    expect((await screen.findByTestId("confirm-gate-error", {}, { timeout: 10_000 })).textContent).toContain("gate ipc down")
    expect(onResolved).not.toHaveBeenCalled()
  }, 30_000)

  it("重试按钮重发最后一次裁决：成功后回调并清空错误态", async () => {
    mocks.confirmGate.mockRejectedValueOnce(new Error("gate ipc down"))
    const onResolved = vi.fn()
    render(<ConfirmGateDialog pending={pendingGate()} onResolved={onResolved} />)

    await act(async () => {
      screen.getByTestId("confirm-gate-accept").click()
    })
    expect(await screen.findByTestId("confirm-gate-error", {}, { timeout: 10_000 })).toBeTruthy()

    await act(async () => {
      screen.getByTestId("confirm-gate-retry").click()
    })

    expect(mocks.confirmGate).toHaveBeenCalledTimes(2)
    expect(mocks.confirmGate).toHaveBeenLastCalledWith("req-1")
    expect(onResolved).toHaveBeenCalledWith(OUTCOME)
    await vi.waitFor(() => expect(screen.queryByTestId("confirm-gate-error")).toBeNull(), { timeout: 10_000 })
  }, 30_000)

  it("拒绝裁决失败同样进入错误态", async () => {
    mocks.rejectGate.mockRejectedValueOnce(new Error("gate ipc down"))
    render(<ConfirmGateDialog pending={pendingGate()} />)

    await act(async () => {
      screen.getByTestId("confirm-gate-reject").click()
    })

    expect((await screen.findByTestId("confirm-gate-error", {}, { timeout: 10_000 })).textContent).toContain("gate ipc down")
    expect(mocks.rejectGate).toHaveBeenCalledWith("req-1", expect.any(String))
  }, 30_000)

  it("超时自动裁决失败只尝试一次；时间推进不自动重发，重试仍走拒绝", async () => {
    vi.useFakeTimers()
    try {
      const now = 1_000_000
      mocks.rejectGate.mockRejectedValueOnce(new Error("gate ipc down"))
      render(
        <ConfirmGateDialog
          pending={pendingGate({ created_at_ms: now - 200_000, deadline_ms: now - 1_000 })}
          nowMs={() => now}
        />,
      )

      await act(async () => {
        await Promise.resolve()
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("confirm-gate-error")).toBeTruthy()

      // 自动裁决失败后，继续走时钟也不得自动重发（防重试风暴）。
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(1)

      // 用户点重试 → 重发最后一次尝试（拒绝）。
      mocks.rejectGate.mockResolvedValueOnce({ ...OUTCOME, decision: "denied" })
      await act(async () => {
        screen.getByTestId("confirm-gate-retry").click()
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("宿主轮询导致 pending 对象身份变化：不自动重发，已展示错误态不被清空", async () => {
    vi.useFakeTimers()
    try {
      const now = 1_000_000
      mocks.rejectGate.mockRejectedValueOnce(new Error("gate ipc down"))
      const { rerender } = render(
        <ConfirmGateDialog
          pending={pendingGate({ created_at_ms: now - 200_000, deadline_ms: now - 1_000 })}
          nowMs={() => now}
        />,
      )
      await act(async () => {
        await Promise.resolve()
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("confirm-gate-error")).toBeTruthy()

      // 同一 request_id 的新对象（轮询刷新）：不得自动重发，错误态保留。
      await act(async () => {
        rerender(
          <ConfirmGateDialog
            pending={pendingGate({ created_at_ms: now - 200_000, deadline_ms: now - 1_000 })}
            nowMs={() => now}
          />,
        )
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("confirm-gate-error")).toBeTruthy()

      // 新 request_id（真正的新请求）：错误态重置，自动裁决再次生效。
      mocks.rejectGate.mockRejectedValueOnce(new Error("still down"))
      await act(async () => {
        rerender(
          <ConfirmGateDialog
            pending={pendingGate({
              request_id: "req-2",
              created_at_ms: now - 200_000,
              deadline_ms: now - 1_000,
            })}
            nowMs={() => now}
          />,
        )
      })
      expect(mocks.rejectGate).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("不传 nowMs 时默认时钟引用稳定：Date.now 每次前进也不会触发渲染死循环", async () => {
    // 回归：默认时钟曾每次渲染新建函数，作为倒计时 effect 依赖导致 effect 每次重跑并
    // setRemaining(新值) → Maximum update depth exceeded。高负载下 Date.now 在两次渲染间前进，
    // 这里用递增的 Date.now 确定性地复现该条件。
    let t = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (t += 7))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      render(<ConfirmGateDialog pending={pendingGate({ created_at_ms: t, deadline_ms: t + 120_000 })} />)
      await act(async () => {
        await Promise.resolve()
      })
      const loopErrors = errSpy.mock.calls.filter((args) => String(args[0]).includes("Maximum update depth"))
      expect(loopErrors).toHaveLength(0)
      expect(screen.getByTestId("confirm-gate-accept")).toBeTruthy()
    } finally {
      nowSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
