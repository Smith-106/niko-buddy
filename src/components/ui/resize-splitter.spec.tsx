// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ResizeSplitter } from "./resize-splitter"

afterEach(() => {
  cleanup()
  document.body.style.cursor = ""
  document.body.style.userSelect = ""
  delete document.body.dataset.panelResizing
})

describe("ResizeSplitter", () => {
  it("exposes WAI-ARIA separator attributes and keyboard navigation (vertical)", () => {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(
      <ResizeSplitter
        orientation="vertical"
        value={220}
        min={150}
        max={400}
        ariaLabel="调整侧边栏宽度"
        onChange={onChange}
        onCommit={onCommit}
        testId="sidebar-splitter"
      />,
    )

    const sep = screen.getByRole("separator", { name: "调整侧边栏宽度" })
    expect(sep).toHaveAttribute("aria-orientation", "vertical")
    expect(sep).toHaveAttribute("aria-valuenow", "220")
    expect(sep).toHaveAttribute("aria-valuemin", "150")
    expect(sep).toHaveAttribute("aria-valuemax", "400")
    expect(sep).toHaveAttribute("tabindex", "0")

    fireEvent.keyDown(sep, { key: "ArrowRight" })
    expect(onChange).toHaveBeenLastCalledWith(236)
    expect(onCommit).toHaveBeenLastCalledWith(236)

    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(172)

    fireEvent.keyDown(sep, { key: "Home" })
    expect(onChange).toHaveBeenLastCalledWith(150)

    fireEvent.keyDown(sep, { key: "End" })
    expect(onChange).toHaveBeenLastCalledWith(400)

    // Non-matching axis keys do not trigger
    const callsBefore = onChange.mock.calls.length
    fireEvent.keyDown(sep, { key: "ArrowUp" })
    expect(onChange).toHaveBeenCalledTimes(callsBefore)
  })

  it("inverts direction for right/bottom docked panels on keyboard and mouse drag", () => {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(
      <ResizeSplitter
        orientation="horizontal"
        value={260}
        min={180}
        max={520}
        invertDrag
        ariaLabel="调整对话区高度"
        onChange={onChange}
        onCommit={onCommit}
      />,
    )

    const sep = screen.getByRole("separator", { name: "调整对话区高度" })
    // ArrowUp increases bottom panel height when invertDrag=true
    fireEvent.keyDown(sep, { key: "ArrowUp" })
    expect(onChange).toHaveBeenLastCalledWith(276)

    fireEvent.keyDown(sep, { key: "ArrowDown" })
    expect(onChange).toHaveBeenLastCalledWith(244)

    // Mouse drag upward (clientY decreases) increases height
    fireEvent.mouseDown(sep, { clientY: 400, button: 0 })
    expect(document.body.style.cursor).toBe("row-resize")
    expect(document.body.style.userSelect).toBe("none")
    expect(document.body.dataset.panelResizing).toBe("true")

    fireEvent.mouseMove(document, { clientY: 300 })
    expect(onChange).toHaveBeenLastCalledWith(360)

    fireEvent.mouseUp(document)
    expect(onCommit).toHaveBeenLastCalledWith(360)
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")
    expect(document.body.dataset.panelResizing).toBeUndefined()
  })

  it("cleans up listeners and body styles on window blur, pointercancel, visibilitychange, and unmount", () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <ResizeSplitter
        orientation="vertical"
        value={220}
        min={150}
        max={400}
        ariaLabel="调整栏宽"
        onChange={onChange}
      />,
    )
    const sep = screen.getByRole("separator")

    // 1) window blur
    fireEvent.mouseDown(sep, { clientX: 200, button: 0 })
    expect(document.body.dataset.panelResizing).toBe("true")
    fireEvent(window, new Event("blur"))
    expect(document.body.dataset.panelResizing).toBeUndefined()
    expect(document.body.style.cursor).toBe("")

    // 2) pointerup commits & cleans up
    fireEvent.mouseDown(sep, { clientX: 200, button: 0 })
    expect(document.body.dataset.panelResizing).toBe("true")
    fireEvent(window, new Event("pointerup"))
    expect(document.body.dataset.panelResizing).toBeUndefined()
    expect(document.body.style.cursor).toBe("")

    // 3) pointercancel
    fireEvent.mouseDown(sep, { clientX: 200, button: 0 })
    expect(document.body.dataset.panelResizing).toBe("true")
    fireEvent(document, new Event("pointercancel"))
    expect(document.body.dataset.panelResizing).toBeUndefined()

    // 3) visibilitychange (hidden)
    fireEvent.mouseDown(sep, { clientX: 200, button: 0 })
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
    fireEvent(document, new Event("visibilitychange"))
    expect(document.body.dataset.panelResizing).toBeUndefined()
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false })

    // 4) unmount during drag
    fireEvent.mouseDown(sep, { clientX: 200, button: 0 })
    expect(document.body.dataset.panelResizing).toBe("true")
    unmount()
    expect(document.body.dataset.panelResizing).toBeUndefined()
    expect(document.body.style.cursor).toBe("")
    expect(document.body.style.userSelect).toBe("")

    const countAfterUnmount = onChange.mock.calls.length
    fireEvent.mouseMove(document, { clientX: 350 })
    expect(onChange).toHaveBeenCalledTimes(countAfterUnmount)
  })
})
