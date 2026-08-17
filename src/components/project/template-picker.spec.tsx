// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/project/template-picker.tsx.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { TemplatePicker } from "./template-picker"

const mocks = vi.hoisted(() => ({
  templates: [
    { id: "basic", name: "Basic Wiki", description: "A plain wiki", icon: "📁", schema: "x", purpose: "p", extraDirs: [] },
    { id: "novel", name: "Novel Studio", description: "For fiction", icon: "✍️", schema: "y", purpose: "p", extraDirs: [] },
  ],
  t: vi.fn((key: string, opts?: { defaultValue?: string }) => `T(${opts?.defaultValue ?? key})`),
}))

vi.mock("@/lib/templates", () => ({ templates: mocks.templates }))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

afterEach(() => {
  cleanup()
  mocks.t.mockClear()
})

describe("TemplatePicker", () => {
  it("renders every template with translated name/description", () => {
    render(<TemplatePicker selected="basic" onSelect={vi.fn()} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(2)

    // translation called with defaultValue fallback per template
    expect(mocks.t).toHaveBeenCalledWith("templates.basic.name", { defaultValue: "Basic Wiki" })
    expect(mocks.t).toHaveBeenCalledWith("templates.novel.description", { defaultValue: "For fiction" })

    expect(screen.getByText("T(Basic Wiki)")).toBeInTheDocument()
    expect(screen.getByText("T(A plain wiki)")).toBeInTheDocument()
    expect(screen.getByText("📁")).toBeInTheDocument()
    expect(screen.getByText("✍️")).toBeInTheDocument()
  })

  it("marks the selected template with the selected styles", () => {
    render(<TemplatePicker selected="novel" onSelect={vi.fn()} />)
    const novelBtn = screen.getByText("T(Novel Studio)").closest("button") as HTMLElement
    const basicBtn = screen.getByText("T(Basic Wiki)").closest("button") as HTMLElement
    expect(novelBtn.className).toContain("border-primary")
    expect(novelBtn.className).toContain("ring-1")
    expect(basicBtn.className).not.toContain("border-primary")
  })

  it("invokes onSelect with the template id on click", () => {
    const onSelect = vi.fn()
    render(<TemplatePicker selected="" onSelect={onSelect} />)
    fireEvent.click(screen.getByText("T(Basic Wiki)"))
    expect(onSelect).toHaveBeenCalledWith("basic")
    fireEvent.click(screen.getByText("T(Novel Studio)"))
    expect(onSelect).toHaveBeenCalledWith("novel")
  })
})
