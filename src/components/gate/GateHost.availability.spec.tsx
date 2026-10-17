// @vitest-environment jsdom
/**
 * C3 GateHost 连续失败角标 spec：查询连续失败达到阈值时挂「门服务不可用」角标，
 * 恢复即自动消失；未达阈值不展示（保持写作不被查询失败阻断）。
 */
import { cleanup as rtlCleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { act, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  listPendingGates: vi.fn(),
  fetchLoopState: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listPendingGates: mocks.listPendingGates,
    fetchLoopState: mocks.fetchLoopState,
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

import { GATE_HOST_FAILURE_THRESHOLD, GateHost } from "./GateHost"

const RUNNING = {
  halted: false,
  fingerprint: null,
  halt_request_id: null,
  count: 0,
  window_ms: 60_000,
  threshold: 3,
  since_ms: null,
  reason: null,
}

describe("GateHost — C3 连续失败角标", () => {
  beforeEach(() => {
    setupDomGlobals()
    vi.useFakeTimers()
    mocks.listPendingGates.mockReset().mockResolvedValue([])
    mocks.fetchLoopState.mockReset().mockResolvedValue({ ...RUNNING })
  })

  afterEach(() => {
    rtlCleanup()
    vi.useRealTimers()
  })

  it("连续失败达阈值才挂角标；恢复成功后自动消失", async () => {
    expect(GATE_HOST_FAILURE_THRESHOLD).toBe(3)

    mocks.listPendingGates.mockRejectedValue(new Error("[gate] unavailable"))
    mocks.fetchLoopState.mockRejectedValue(new Error("[gate] unavailable"))

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})
    expect(screen.queryByTestId("gate-service-unavailable")).toBeNull() // 第 1 次失败

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByTestId("gate-service-unavailable")).toBeNull() // 第 2 次失败

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    const badge = screen.getByTestId("gate-service-unavailable") // 第 3 次失败 → 角标
    expect(badge.textContent).toContain("门服务不可用")

    // 恢复：一次成功查询即清零计数 → 角标消失。
    mocks.listPendingGates.mockResolvedValue([])
    mocks.fetchLoopState.mockResolvedValue({ ...RUNNING })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByTestId("gate-service-unavailable")).toBeNull()
  })

  it("失败未达阈值不展示角标，且不阻断确认弹窗渲染", async () => {
    mocks.listPendingGates.mockRejectedValueOnce(new Error("[gate] unavailable"))
    mocks.fetchLoopState.mockRejectedValueOnce(new Error("[gate] unavailable"))
    mocks.listPendingGates.mockResolvedValue([
      {
        request_id: "req-1",
        op: "batchReplace",
        target: "QM/memory/facts.md",
        class: "irreversible",
        hit_criteria: ["protected_prefix"],
        actor: "external",
        created_at_ms: Date.now(),
        deadline_ms: Date.now() + 120_000,
        diff_summary: "-旧 +新",
      },
    ])

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})
    expect(screen.queryByTestId("gate-service-unavailable")).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByTestId("gate-service-unavailable")).toBeNull()
    expect(screen.getByTestId("confirm-gate-dialog")).toBeTruthy()
  })
})
