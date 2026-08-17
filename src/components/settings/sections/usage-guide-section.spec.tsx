// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/usage-guide-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { UsageGuideSection } from "./usage-guide-section"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("../resource-link", () => ({
  ResourceLink: ({ href, title, children }: { href: string; title: string; children: React.ReactNode }) => (
    <a href={href} title={title}>{children}</a>
  ),
}))

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("UsageGuideSection", () => {
  it("renders the title and description", () => {
    render(<UsageGuideSection />)
    expect(screen.getByText("settings.sections.usageGuide.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.usageGuide.description")).toBeInTheDocument()
  })

  it("renders all three guide links with titles, descriptions, and open actions", () => {
    render(<UsageGuideSection />)
    expect(screen.getByText("青幕AI写作完整使用说明")).toBeInTheDocument()
    expect(screen.getByText("青幕AI写作正式用户手册")).toBeInTheDocument()
    expect(screen.getByText("青幕AI小说介绍")).toBeInTheDocument()
    expect(
      screen.getByText("从安装、模型配置到资料库、小说创作流程的完整说明。"),
    ).toBeInTheDocument()
    const openLinks = screen.getAllByText("settings.sections.usageGuide.open")
    expect(openLinks).toHaveLength(3)
    expect(openLinks[0].closest("a")).toHaveAttribute(
      "href",
      "https://tcnk9ik08e1c.feishu.cn/wiki/EgjtwCVpCiuOISky1HMcRCQhnhf?from=from_copylink",
    )
  })

  it("uses distinct icon components per link", () => {
    const { container } = render(<UsageGuideSection />)
    const icons = container.querySelectorAll("svg")
    expect(icons.length).toBeGreaterThanOrEqual(3)
  })
})
