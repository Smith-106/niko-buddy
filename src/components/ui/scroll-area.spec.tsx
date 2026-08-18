// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/ui/scroll-area.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import type { ReactNode } from "react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { ScrollArea, ScrollBar } from "./scroll-area"

vi.mock("@base-ui/react/scroll-area", () => ({
  ScrollArea: {
    Root: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
      <div data-testid="base-root" {...props}>
        {children}
      </div>
    ),
    Viewport: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
      <div data-testid="base-viewport" {...props}>
        {children}
      </div>
    ),
    Scrollbar: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
      <div data-testid="base-scrollbar" {...props}>
        {children}
      </div>
    ),
    Thumb: ({ ...props }: Record<string, unknown>) => (
      <div data-testid="base-thumb" {...props} />
    ),
    Corner: ({ ...props }: Record<string, unknown>) => (
      <div data-testid="base-corner" {...props} />
    ),
  },
}))

afterEach(() => {
  cleanup()
})

describe("ScrollArea", () => {
  it("composes root + viewport + scrollbar + corner and renders children", () => {
    render(
      <ScrollArea className="sa">
        <p>content</p>
      </ScrollArea>,
    )
    const root = screen.getByTestId("base-root")
    expect(root).toHaveAttribute("data-slot", "scroll-area")
    expect(root.className).toContain("sa")
    const viewport = screen.getByTestId("base-viewport")
    expect(viewport).toHaveAttribute("data-slot", "scroll-area-viewport")
    expect(viewport).toHaveTextContent("content")
    expect(screen.getByTestId("base-scrollbar")).toBeInTheDocument()
    expect(screen.getByTestId("base-corner")).toBeInTheDocument()
  })
})

describe("ScrollBar", () => {
  it("defaults to vertical orientation", () => {
    render(<ScrollBar />)
    const bar = screen.getByTestId("base-scrollbar")
    expect(bar).toHaveAttribute("data-slot", "scroll-area-scrollbar")
    expect(bar).toHaveAttribute("orientation", "vertical")
    expect(bar.className).toContain("h-full w-2.5")
    expect(screen.getByTestId("base-thumb")).toBeInTheDocument()
  })

  it("renders horizontal orientation and merges className", () => {
    render(<ScrollBar orientation="horizontal" className="extra" />)
    const bar = screen.getByTestId("base-scrollbar")
    expect(bar).toHaveAttribute("orientation", "horizontal")
    expect(bar.className).toContain("h-2.5 flex-col")
    expect(bar.className).toContain("extra")
  })
})
