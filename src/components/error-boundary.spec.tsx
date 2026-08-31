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
})
