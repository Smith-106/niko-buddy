// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/about-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { AboutSection } from "./about-section"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("AboutSection", () => {
  it("renders the title, description, and a version row with the app version", () => {
    render(<AboutSection />)
    expect(screen.getByText("settings.sections.about.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.about.description")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.about.version")).toBeInTheDocument()
    const versionValue = screen.getByText(`v${__APP_VERSION__}`)
    expect(versionValue.className).toContain("font-mono")
  })
})
