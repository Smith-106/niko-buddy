// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const settingsViewSource = readFileSync(resolve(__dirname, "settings-view.tsx"), "utf8")
const sectionSourcePath = resolve(__dirname, "sections", "contact-support-section.tsx")

describe("settings contact support section", () => {
  it("adds a contact and support category to the settings sidebar", () => {
    expect(settingsViewSource).toContain('"contact-support"')
    expect(settingsViewSource).toContain("settings.categories.contactSupport")
    expect(settingsViewSource).toContain("<ContactSupportSection")
  })

  it("shows WeChat contact, WeChat pay, and Alipay pay QR placeholders", () => {
    const sectionSource = readFileSync(sectionSourcePath, "utf8")

    expect(sectionSource).toContain("QrPlaceholder")
    expect(sectionSource).toContain("wechatPay")
    expect(sectionSource).toContain("alipayPay")
    expect(sectionSource).toContain("settings.sections.contactSupport.contact.title")
    expect(sectionSource).toContain("settings.sections.contactSupport.donation.title")
  })
})
