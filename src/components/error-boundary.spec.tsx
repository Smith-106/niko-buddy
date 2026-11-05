// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/error-boundary.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ErrorBoundary } from "./error-boundary"

/** Throws on render while `shouldThrow` is true. */
let shouldThrow = true
function Flaky() {
  if (shouldThrow) throw new Error("kapow")
  return <div>recovered</div>
}

function Bomb(): never {
  throw new Error("kapow")
}

function renderWithErrorSpy(ui: React.ReactElement) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {})
  render(ui)
  return spy
}

afterEach(() => {
  cleanup()
  shouldThrow = true
  vi.restoreAllMocks()
})

describe("ErrorBoundary", () => {
  it("renders children when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <div>all good</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText("all good")).toBeInTheDocument()
    expect(screen.queryByText("出错了")).not.toBeInTheDocument()
  })

  it("catches a render error and shows the default fallback UI", () => {
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText("出错了")).toBeInTheDocument()
    expect(screen.getByText("kapow")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
    expect(screen.queryByText("all good")).not.toBeInTheDocument()
  })

  it("logs the error and component stack through componentDidCatch", () => {
    const spy = renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    const logged = spy.mock.calls.find((args) => args[0] === "ErrorBoundary caught:")
    expect(logged).toBeDefined()
    expect(logged?.[1]).toBeInstanceOf(Error)
  })

  it("renders the custom fallback prop instead of the default UI", () => {
    renderWithErrorSpy(
      <ErrorBoundary fallback={<div>custom-fallback</div>}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText("custom-fallback")).toBeInTheDocument()
    expect(screen.queryByText("出错了")).not.toBeInTheDocument()
  })

  it("Retry resets the error state and re-renders children", () => {
    renderWithErrorSpy(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByText("出错了")).toBeInTheDocument()

    shouldThrow = false
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(screen.getByText("recovered")).toBeInTheDocument()
    expect(screen.queryByText("出错了")).not.toBeInTheDocument()
  })

  it("shows copy-details and reload buttons alongside retry", () => {
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument()
  })

  it("copy-details copies the error message and stack", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    await screen.findByRole("button", { name: "已复制" })
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = String(writeText.mock.calls[0]?.[0] ?? "")
    expect(copied).toContain("kapow")
  })

  it("F15: clipboard unavailable does not falsely report copied", async () => {
    Object.assign(navigator, { clipboard: undefined })
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    // F15（user 边界手感）：clipboard API 不可用时不得假报“已复制”，按钮保持原态
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument()
  })
})
// ── statements 补测：clipboard 同步/失败三态 + 刷新页面按钮 ──────────────
describe("ErrorBoundary — copyDetails 结果分派与刷新按钮", () => {
  function stubClipboard(writeText: unknown) {
    Object.assign(navigator, { clipboard: { writeText } })
  }

  function stubLocationReload(reload: () => void) {
    const original = Object.getOwnPropertyDescriptor(window, "location")
    Object.defineProperty(window, "location", { configurable: true, value: { reload } })
    return () => {
      if (original) Object.defineProperty(window, "location", original)
    }
  }

  it("clipboard 同步返回非 Promise → 直接标记已复制", () => {
    stubClipboard(vi.fn())
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    // 同步返回值（无 .then）→ done() 立即置态，不假等待
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument()
  })

  it("clipboard 返回 rejected Promise → 保持未复制（不假报成功）", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    stubClipboard(writeText)
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeInTheDocument()
  })

  it("clipboard.writeText 同步抛错 → 吞掉异常并保持未复制", () => {
    const writeText = vi.fn(() => {
      throw new Error("sync boom")
    })
    stubClipboard(writeText)
    renderWithErrorSpy(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "复制错误详情" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument()
  })

  it("错误对象无 stack 时不把 undefined 写进复制内容", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    function Stackless(): never {
      const err = new Error("kapow")
      delete (err as { stack?: string }).stack
      throw err
    }
    renderWithErrorSpy(
      <ErrorBoundary>
        <Stackless />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole("button", { name: "复制错误详情" }))
    await screen.findByRole("button", { name: "已复制" })
    const copied = String(writeText.mock.calls[0]?.[0] ?? "")
    expect(copied).toBe(["Error: kapow", ""].join(String.fromCharCode(10)))
    expect(copied).not.toContain("undefined")
  })

  it("刷新页面按钮调用 window.location.reload", () => {
    const reload = vi.fn()
    const restore = stubLocationReload(reload)
    try {
      renderWithErrorSpy(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole("button", { name: "刷新页面" }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})
