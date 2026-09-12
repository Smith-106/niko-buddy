// @vitest-environment jsdom
/**
 * GateHost 接线测试（B-F-001）。
 *
 * 覆盖宿主职责：轮询取「待裁决 + 熔断」两态、按 state 渲染弹窗/横幅、把人工裁决交回
 * 既有 `confirm_gate_resolve`。判定语义本身由 `agent_gate.rs` 与 gate-classify 覆盖，
 * 这里不重复。
 */
import { cleanup as rtlCleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { act, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  listPendingGates: vi.fn(),
  fetchLoopState: vi.fn(),
  resumeAfterHalt: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    listPendingGates: mocks.listPendingGates,
    fetchLoopState: mocks.fetchLoopState,
    resumeAfterHalt: mocks.resumeAfterHalt,
  }
})

import { GateHost } from "./GateHost"

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

function pendingGate(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "req-1",
    op: "batchReplace",
    target: "QM/memory/facts.md",
    class: "irreversible",
    hit_criteria: ["protected_prefix"],
    actor: "external",
    created_at_ms: Date.now(),
    deadline_ms: Date.now() + 120_000,
    diff_summary: "-旧 +新",
    ...overrides,
  }
}

describe("GateHost / 壳层接线", () => {
  beforeEach(() => {
    setupDomGlobals()
    vi.useFakeTimers()
    mocks.listPendingGates.mockReset().mockResolvedValue([])
    mocks.fetchLoopState.mockReset().mockResolvedValue({ ...RUNNING })
    mocks.resumeAfterHalt.mockReset().mockResolvedValue({ decision: "resume_after_halt" })
    mocks.invoke.mockReset().mockResolvedValue({ decision: "denied" })
  })

  afterEach(() => {
    rtlCleanup()
    vi.useRealTimers()
  })

  it("待裁决请求出现时渲染确认弹窗，拒绝走既有 resolve（decision=denied）", async () => {
    mocks.listPendingGates.mockResolvedValue([pendingGate()])

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})

    const dialog = screen.getByTestId("confirm-gate-dialog")
    expect(dialog).toBeTruthy()
    expect(screen.getByTestId("confirm-gate-target").textContent).toContain("QM/memory/facts.md")

    await act(async () => {
      screen.getByTestId("confirm-gate-reject").click()
    })

    expect(mocks.invoke).toHaveBeenCalledWith("confirm_gate_resolve", {
      requestId: "req-1",
      decision: "denied",
      note: "rejected in dialog",
    })
  })

  it("熔断时渲染横幅，恢复只使用 halt_request_id", async () => {
    mocks.fetchLoopState.mockResolvedValue({
      ...RUNNING,
      halted: true,
      halt_request_id: "halt-9",
      count: 3,
    })

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})

    expect(screen.getByTestId("gate-halt-banner")).toBeTruthy()

    await act(async () => {
      screen.getByTestId("gate-halt-resume").click()
    })

    expect(mocks.resumeAfterHalt).toHaveBeenCalledWith("halt-9", expect.any(String))
  })

  it("熔断但缺 halt_request_id 时不给恢复按钮（不伪造恢复入口）", async () => {
    mocks.fetchLoopState.mockResolvedValue({ ...RUNNING, halted: true, halt_request_id: null })

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})

    expect(screen.getByTestId("gate-halt-banner")).toBeTruthy()
    expect(screen.queryByTestId("gate-halt-resume")).toBeNull()
  })

  it("按 pollMs 轮询：后续出现的请求会被拾起", async () => {
    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {})
    expect(screen.queryByTestId("confirm-gate-dialog")).toBeNull()

    mocks.listPendingGates.mockResolvedValue([pendingGate({ request_id: "req-2" })])
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.getByTestId("confirm-gate-dialog")).toBeTruthy()
    expect(mocks.listPendingGates.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("enabled=false（浏览器预览）不轮询、不渲染", async () => {
    mocks.listPendingGates.mockResolvedValue([pendingGate()])

    render(<GateHost enabled={false} pollMs={1000} />)
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(mocks.listPendingGates).not.toHaveBeenCalled()
    expect(screen.queryByTestId("confirm-gate-dialog")).toBeNull()
  })

  it("门查询失败时静默（不抛出、不渲染）", async () => {
    mocks.listPendingGates.mockRejectedValue(new Error("[gate] unavailable"))
    mocks.fetchLoopState.mockRejectedValue(new Error("[gate] unavailable"))

    render(<GateHost enabled pollMs={1000} />)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(screen.queryByTestId("confirm-gate-dialog")).toBeNull()
    expect(screen.queryByTestId("gate-halt-banner")).toBeNull()
  })
})
