// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/ui/resizable.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import type { ReactNode } from "react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable"

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <div data-testid="base-group" {...props}>
      {children}
    </div>
  ),
  Panel: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <div data-testid="base-panel" {...props}>
      {children}
    </div>
  ),
  Separator: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <div data-testid="base-separator" {...props}>
      {children}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
})

describe("ResizablePanelGroup", () => {
  it("defaults to horizontal orientation and merges className", () => {
    render(
      <ResizablePanelGroup className="g">
        <span>p</span>
      </ResizablePanelGroup>,
    )
    const group = screen.getByTestId("base-group")
    expect(group).toHaveAttribute("data-slot", "resizable-panel-group")
    expect(group).toHaveAttribute("orientation", "horizontal")
    expect(group.className).toContain("g")
    expect(group).toHaveTextContent("p")
  })

  it("passes vertical direction as orientation", () => {
    render(<ResizablePanelGroup direction="vertical" />)
    expect(screen.getByTestId("base-group")).toHaveAttribute("orientation", "vertical")
  })
})

describe("ResizablePanel", () => {
  it("forwards props and sets data-slot", () => {
    render(<ResizablePanel minSize={10} />)
    const panel = screen.getByTestId("base-panel")
    expect(panel).toHaveAttribute("data-slot", "resizable-panel")
    expect(panel).toHaveAttribute("minSize", "10")
  })
})

describe("ResizableHandle", () => {
  it("renders without handle knob by default", () => {
    render(<ResizableHandle className="h" />)
    const sep = screen.getByTestId("base-separator")
    expect(sep).toHaveAttribute("data-slot", "resizable-handle")
    expect(sep.className).toContain("h")
    expect(sep.querySelector(".z-10")).toBeNull()
  })

  it("renders the handle knob when withHandle is set", () => {
    render(<ResizableHandle withHandle />)
    const sep = screen.getByTestId("base-separator")
    expect(sep.querySelector(".z-10")).not.toBeNull()
  })
})
