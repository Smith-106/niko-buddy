// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/layout/panel-header-with-help.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { PanelHeaderWithHelp } from "./panel-header-with-help"

const mocks = vi.hoisted(() => ({
  getHelpLinkUrl: vi.fn(),
  openExternalUrl: vi.fn(),
}))

vi.mock("@/config/help-links", () => ({
  getHelpLinkUrl: mocks.getHelpLinkUrl,
}))

vi.mock("@/lib/open-external-url", () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe("PanelHeaderWithHelp", () => {
  it("renders the bare title when no helpKey is given", () => {
    const { container } = render(<PanelHeaderWithHelp title="面板标题" />)
    expect(screen.getByText("面板标题")).toBeInTheDocument()
    expect(container.querySelector("svg")).toBeNull()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders the bare title when the help key resolves to null", () => {
    mocks.getHelpLinkUrl.mockReturnValue(null)
    const { container } = render(<PanelHeaderWithHelp title="面板标题" helpKey="graph" />)
    expect(screen.getByText("面板标题")).toBeInTheDocument()
    expect(container.querySelector("svg")).toBeNull()
  })

  it("renders a button with the default help title and opens the URL on click", () => {
    mocks.getHelpLinkUrl.mockReturnValue("https://docs.example.com/graph")
    const stop = vi.fn()
    render(<PanelHeaderWithHelp title="图谱" helpKey="graph" />)
    const button = screen.getByRole("button", { name: "图谱" })
    expect(button).toHaveAttribute("title", "图谱使用说明")
    fireEvent.click(button, { stopPropagation: stop })
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://docs.example.com/graph")
  })

  it("uses the explicit helpTitle when provided", () => {
    mocks.getHelpLinkUrl.mockReturnValue("https://docs.example.com/outline")
    render(<PanelHeaderWithHelp title="大纲" helpKey="outline" helpTitle="大纲帮助文档" />)
    expect(screen.getByRole("button", { name: "大纲" })).toHaveAttribute(
      "title",
      "大纲帮助文档",
    )
  })

  it("opens the URL on Enter and space keydown, and ignores other keys", () => {
    mocks.getHelpLinkUrl.mockReturnValue("https://docs.example.com/memory")
    render(<PanelHeaderWithHelp title="记忆" helpKey="memory" />)
    const button = screen.getByRole("button", { name: "记忆" })

    fireEvent.keyDown(button, { key: "Enter" })
    expect(mocks.openExternalUrl).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(button, { key: " " })
    expect(mocks.openExternalUrl).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(button, { key: "Tab" })
    expect(mocks.openExternalUrl).toHaveBeenCalledTimes(2)
  })

  it("stops propagation on click and keydown", () => {
    mocks.getHelpLinkUrl.mockReturnValue("https://docs.example.com/soul")
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    render(
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <PanelHeaderWithHelp title="灵魂" helpKey="soul" />
      </div>,
    )
    const button = screen.getByRole("button", { name: "灵魂" })
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: "Enter" })
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it("applies the custom className and shows the help icon", () => {
    mocks.getHelpLinkUrl.mockReturnValue("https://docs.example.com/review")
    const { container } = render(
      <PanelHeaderWithHelp title="评审" helpKey="review" className="custom-cls" />,
    )
    expect(screen.getByRole("button", { name: "评审" }).className).toContain("custom-cls")
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
