// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/context-size-selector.tsx

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { ContextSizeSelector } from "./context-size-selector"

afterEach(() => {
  cleanup()
})

describe("ContextSizeSelector", () => {
  it("formats sizes across all three formatSize branches (B / K / M)", () => {
    const onChange = vi.fn()
    const { rerender } = render(<ContextSizeSelector value={500} onChange={onChange} />)
    // 500 → "500 characters"；closest preset 4096 → slider index 0
    expect(screen.getByText("500 characters")).toBeInTheDocument()
    expect(screen.getByText("~0K chars for wiki content")).toBeInTheDocument()

    rerender(<ContextSizeSelector value={2000} onChange={onChange} />)
    // 2000 → "2K characters"；closest preset 4096 → index 0
    expect(screen.getByText("2K characters")).toBeInTheDocument()

    rerender(<ContextSizeSelector value={262144} onChange={onChange} />)
    // 262144 → "262K characters"；closest preset 262144 → index 7
    expect(screen.getByText("262K characters")).toBeInTheDocument()

    rerender(<ContextSizeSelector value={1000000} onChange={onChange} />)
    // 1000000 → "1.0M characters"；closest preset 1000000 → index 9
    expect(screen.getByText("1.0M characters")).toBeInTheDocument()
  })

  it("marks the closest preset button as active", () => {
    render(<ContextSizeSelector value={204800} onChange={vi.fn()} />)
    const active = screen
      .getAllByRole("button")
      .find((b) => b.className.includes("font-bold"))
    expect(active).toBeTruthy()
    expect(active?.textContent).toBe("200K")
  })

  it("moving the slider calls onChange with the mapped preset value", () => {
    const onChange = vi.fn()
    render(<ContextSizeSelector value={4096} onChange={onChange} />)
    const slider = screen.getByRole("slider") as HTMLInputElement
    fireEvent.change(slider, { target: { value: "9" } }) // index 9 → 1000000
    expect(onChange).toHaveBeenCalledWith(1000000)
  })

  it("clicking a preset button calls onChange with its exact value", () => {
    const onChange = vi.fn()
    render(<ContextSizeSelector value={65536} onChange={onChange} />)
    fireEvent.click(screen.getByText("32K"))
    expect(onChange).toHaveBeenCalledWith(32768)
    fireEvent.click(screen.getByText("1M"))
    expect(onChange).toHaveBeenCalledWith(1000000)
  })
})
