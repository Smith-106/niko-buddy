// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/ui/separator.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { Separator } from "./separator"

vi.mock("@base-ui/react/separator", () => ({
  Separator: ({ children, ...props }: Record<string, unknown>) => (
    <div data-testid="base-separator" {...props}>
      {children}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
})

describe("Separator", () => {
  it("defaults to horizontal orientation", () => {
    render(<Separator />)
    const sep = screen.getByTestId("base-separator")
    expect(sep).toHaveAttribute("data-slot", "separator")
    expect(sep).toHaveAttribute("orientation", "horizontal")
    expect(sep.className).toContain("data-horizontal:h-px")
  })

  it("passes vertical orientation and merges className", () => {
    render(<Separator orientation="vertical" className="extra" />)
    const sep = screen.getByTestId("base-separator")
    expect(sep).toHaveAttribute("orientation", "vertical")
    expect(sep.className).toContain("data-vertical:w-px")
    expect(sep.className).toContain("extra")
  })
})
