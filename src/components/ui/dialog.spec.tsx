// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/ui/dialog.tsx (base-ui wrapper).

import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog"

// Pass-through mock of the base-ui dialog primitives so the wrapper's
// own composition/branching is exercised deterministically in jsdom.
vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    Root: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div data-testid="base-root" {...props}>
        {children}
      </div>
    ),
    Trigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <button type="button" data-testid="base-trigger" {...props}>
        {children}
      </button>
    ),
    Portal: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div data-testid="base-portal" {...props}>
        {children}
      </div>
    ),
    Close: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <span data-testid="base-close" {...props}>
        {children}
      </span>
    ),
    Backdrop: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div data-testid="base-backdrop" {...props}>
        {children}
      </div>
    ),
    Popup: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div data-testid="base-popup" {...props}>
        {children}
      </div>
    ),
    Title: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <h2 data-testid="base-title" {...props}>
        {children}
      </h2>
    ),
    Description: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <p data-testid="base-description" {...props}>
        {children}
      </p>
    ),
  },
}))

// The real ui Button would nest a <button> inside the mocked base-ui
// Close (a hydration hazard in jsdom). Mock it to a plain button.
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

describe("Dialog primitives", () => {
  it("Dialog forwards props and sets data-slot", () => {
    render(
      <Dialog open data-slot-probe="x">
        <span>inside</span>
      </Dialog>,
    )
    const root = screen.getByTestId("base-root")
    expect(root).toHaveAttribute("data-slot", "dialog")
    expect(root).toHaveTextContent("inside")
  })

  it("DialogTrigger forwards props and sets data-slot", () => {
    render(<DialogTrigger data-probe="1">Open</DialogTrigger>)
    const trigger = screen.getByTestId("base-trigger")
    expect(trigger).toHaveAttribute("data-slot", "dialog-trigger")
    expect(trigger).toHaveAttribute("data-probe", "1")
  })

  it("DialogPortal forwards props and sets data-slot", () => {
    render(<DialogPortal>portal-child</DialogPortal>)
    const portal = screen.getByTestId("base-portal")
    expect(portal).toHaveAttribute("data-slot", "dialog-portal")
    expect(portal).toHaveTextContent("portal-child")
  })

  it("DialogClose forwards props and sets data-slot", () => {
    render(<DialogClose>close</DialogClose>)
    const close = screen.getByTestId("base-close")
    expect(close).toHaveAttribute("data-slot", "dialog-close")
  })

  it("DialogOverlay merges className and sets data-slot", () => {
    render(<DialogOverlay className="my-overlay" />)
    const overlay = screen.getByTestId("base-backdrop")
    expect(overlay).toHaveAttribute("data-slot", "dialog-overlay")
    expect(overlay.className).toContain("my-overlay")
    expect(overlay.className).toContain("fixed inset-0 z-50")
  })

  it("DialogContent renders overlay + popup + close button by default", () => {
    render(
      <DialogContent className="extra">
        <span>content</span>
      </DialogContent>,
    )
    expect(screen.getByTestId("base-portal")).toHaveAttribute("data-slot", "dialog-portal")
    expect(screen.getByTestId("base-backdrop")).toHaveAttribute("data-slot", "dialog-overlay")
    const popup = screen.getByTestId("base-popup")
    expect(popup).toHaveAttribute("data-slot", "dialog-content")
    expect(popup.className).toContain("extra")
    expect(popup).toHaveTextContent("content")
    // default close button with X icon + sr-only label
    const closeButtons = screen.getAllByTestId("base-close")
    expect(closeButtons.length).toBeGreaterThan(0)
    expect(screen.getByText("Close")).toBeInTheDocument()
    expect(popup.querySelector("svg")).not.toBeNull()
  })

  it("DialogContent with showCloseButton=false omits the close button", () => {
    render(
      <DialogContent showCloseButton={false}>
        <span>content</span>
      </DialogContent>,
    )
    expect(screen.queryByTestId("base-close")).not.toBeInTheDocument()
    expect(screen.getByTestId("base-popup")).toHaveTextContent("content")
  })

  it("DialogHeader forwards className and children", () => {
    render(<DialogHeader className="hdr">header</DialogHeader>)
    const header = screen.getByText("header")
    expect(header).toHaveAttribute("data-slot", "dialog-header")
    expect(header.className).toContain("hdr")
  })

  it("DialogFooter default has no close button; showCloseButton renders Close Button", () => {
    const { rerender } = render(<DialogFooter>footer</DialogFooter>)
    const footer = screen.getByText("footer")
    expect(footer).toHaveAttribute("data-slot", "dialog-footer")
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()

    rerender(
      <DialogFooter showCloseButton className="ftr">
        footer
      </DialogFooter>,
    )
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
    expect(screen.getByText("footer").className).toContain("ftr")
  })

  it("DialogTitle and DialogDescription forward props", () => {
    render(
      <>
        <DialogTitle className="t">The Title</DialogTitle>
        <DialogDescription className="d">The Description</DialogDescription>
      </>,
    )
    const title = screen.getByText("The Title")
    expect(title).toHaveAttribute("data-slot", "dialog-title")
    expect(title.className).toContain("t")
    const desc = screen.getByText("The Description")
    expect(desc).toHaveAttribute("data-slot", "dialog-description")
    expect(desc.className).toContain("d")
  })
})

afterEach(() => {
  cleanup()
})

setupDomGlobals()
