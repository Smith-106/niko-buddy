// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CommitNumberInput } from "./settings-widgets"

afterEach(() => cleanup())

describe("CommitNumberInput 标红时机", () => {
  it("低于下限不标红，超过上限标红，失焦夹值后不再标红", () => {
    const onCommit = vi.fn()
    render(<CommitNumberInput aria-label="n" value={12} min={3} max={30} onCommit={onCommit} />)
    const input = screen.getByLabelText("n") as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "1" } })
    expect(input.getAttribute("aria-invalid")).toBeNull()
    fireEvent.change(input, { target: { value: "18" } })
    expect(input.getAttribute("aria-invalid")).toBeNull()
    fireEvent.change(input, { target: { value: "50" } })
    expect(input.getAttribute("aria-invalid")).toBe("true")
    fireEvent.blur(input)
    expect(input.value).toBe("30")
    expect(input.getAttribute("aria-invalid")).toBeNull()
    expect(onCommit).toHaveBeenLastCalledWith(30)
  })

  it("低于下限离开时夹到下限", () => {
    const onCommit = vi.fn()
    render(<CommitNumberInput aria-label="n" value={12} min={3} max={30} onCommit={onCommit} />)
    const input = screen.getByLabelText("n") as HTMLInputElement
    fireEvent.change(input, { target: { value: "1" } })
    fireEvent.blur(input)
    expect(input.value).toBe("3")
    expect(onCommit).toHaveBeenLastCalledWith(3)
  })
})
