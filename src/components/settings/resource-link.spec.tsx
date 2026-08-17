// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/resource-link.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => {}),
}))

vi.mock("@/lib/open-external-url", () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

import { ResourceLink } from "./resource-link"

beforeEach(() => {
  mocks.openExternalUrl.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("ResourceLink", () => {
  it("renders children inside a styled anchor with external-link icon", () => {
    render(
      <ResourceLink href="https://docs.example.com" title="Docs">
        Open docs
      </ResourceLink>,
    )
    const link = screen.getByRole("link", { name: /Open docs/ })
    expect(link).toHaveAttribute("href", "https://docs.example.com")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noreferrer")
    expect(link).toHaveAttribute("title", "Docs")
  })

  it("renders without a title attribute when title is omitted", () => {
    render(<ResourceLink href="https://x.example">Link</ResourceLink>)
    const link = screen.getByRole("link", { name: "Link" })
    expect(link).not.toHaveAttribute("title")
  })

  it("clicking prevents default navigation and opens the external URL", () => {
    render(<ResourceLink href="https://docs.example.com">Docs</ResourceLink>)
    const link = screen.getByRole("link", { name: "Docs" })
    fireEvent.click(link)
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://docs.example.com")
    expect(link).toHaveAttribute("href", "https://docs.example.com")
  })
})
