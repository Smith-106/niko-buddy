// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/ui/tooltip.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"

vi.mock("@base-ui/react/tooltip", () => ({
  Tooltip: {
    Provider: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="base-provider" {...props}>
        {children}
      </div>
    ),
    Root: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="base-root" {...props}>
        {children}
      </div>
    ),
    Trigger: ({ children, ...props }: Record<string, unknown>) => (
      <button type="button" data-testid="base-trigger" {...props}>
        {children}
      </button>
    ),
    Portal: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="base-portal" {...props}>
        {children}
      </div>
    ),
    Positioner: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="base-positioner" {...props}>
        {children}
      </div>
    ),
    Popup: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="base-popup" {...props}>
        {children}
      </div>
    ),
    Arrow: ({ ...props }: Record<string, unknown>) => (
      <div data-testid="base-arrow" {...props} />
    ),
  },
}))

afterEach(() => {
  cleanup()
})

describe("TooltipProvider", () => {
  it("defaults delay to 0", () => {
    render(<TooltipProvider>c</TooltipProvider>)
    const provider = screen.getByTestId("base-provider")
    expect(provider).toHaveAttribute("data-slot", "tooltip-provider")
    expect(provider).toHaveAttribute("delay", "0")
  })

  it("passes custom delay", () => {
    render(<TooltipProvider delay={500}>c</TooltipProvider>)
    expect(screen.getByTestId("base-provider")).toHaveAttribute("delay", "500")
  })
})

describe("Tooltip + TooltipTrigger", () => {
  it("renders root and trigger with data-slots", () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover</TooltipTrigger>
      </Tooltip>,
    )
    expect(screen.getByTestId("base-root")).toHaveAttribute("data-slot", "tooltip")
    const trigger = screen.getByTestId("base-trigger")
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger")
    expect(trigger).toHaveTextContent("Hover")
  })
})

describe("TooltipContent", () => {
  it("uses default side/sideOffset/align/alignOffset", () => {
    render(<TooltipContent>tip</TooltipContent>)
    expect(screen.getByTestId("base-portal")).toBeInTheDocument()
    const positioner = screen.getByTestId("base-positioner")
    expect(positioner).toHaveAttribute("side", "top")
    expect(positioner).toHaveAttribute("sideOffset", "4")
    expect(positioner).toHaveAttribute("align", "center")
    expect(positioner).toHaveAttribute("alignOffset", "0")
    expect(positioner.className).toContain("isolate z-50")
  })

  it("forwards custom positioning props and renders children + arrow", () => {
    render(
      <TooltipContent side="bottom" sideOffset={8} align="end" alignOffset={2} className="extra">
        the-tip
      </TooltipContent>,
    )
    const positioner = screen.getByTestId("base-positioner")
    expect(positioner).toHaveAttribute("side", "bottom")
    expect(positioner).toHaveAttribute("sideOffset", "8")
    expect(positioner).toHaveAttribute("align", "end")
    expect(positioner).toHaveAttribute("alignOffset", "2")

    const popup = screen.getByTestId("base-popup")
    expect(popup).toHaveAttribute("data-slot", "tooltip-content")
    expect(popup.className).toContain("extra")
    expect(popup).toHaveTextContent("the-tip")
    expect(screen.getByTestId("base-arrow")).toBeInTheDocument()
  })
})
