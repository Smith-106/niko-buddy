// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/contact-support-section.tsx
// (complements contact-support-section.spec.ts — the static source-analysis spec)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import { ContactSupportSection } from "./contact-support-section"

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

describe("ContactSupportSection", () => {
  it("renders the header and WeChat contact card with the contact image", () => {
    render(<ContactSupportSection />)
    expect(screen.getByText("settings.sections.contactSupport.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.contactSupport.contact.title")).toBeInTheDocument()
    const contactImg = screen.getByAltText("settings.sections.contactSupport.contact.alt")
    expect(contactImg).toHaveAttribute("src", expect.stringContaining("wechat-contact"))
  })

  it("renders both donation channels with their QR images", () => {
    render(<ContactSupportSection />)
    expect(screen.getByText("settings.sections.contactSupport.donation.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.contactSupport.donation.wechatPay.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.contactSupport.donation.alipayPay.title")).toBeInTheDocument()
    expect(screen.getByAltText("settings.sections.contactSupport.donation.wechatPay.alt")).toHaveAttribute(
      "src",
      expect.stringContaining("wechat-pay"),
    )
    expect(screen.getByAltText("settings.sections.contactSupport.donation.alipayPay.alt")).toHaveAttribute(
      "src",
      expect.stringContaining("alipay-pay"),
    )
  })
})
