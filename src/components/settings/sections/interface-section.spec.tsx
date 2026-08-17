// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/interface-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { InterfaceSection } from "./interface-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    uiLanguage: "zh",
    uiFontSizeScale: 1,
    ...overrides,
  } as SettingsDraft
}

function ControlledSection({
  initial,
  setDraftSpy,
}: {
  initial?: SettingsDraft
  setDraftSpy?: DraftSetter
}) {
  const [draft, setDraft] = useState(initial ?? makeDraft())
  const setter: DraftSetter = (key, value) => {
    setDraftSpy?.(key, value)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  return <InterfaceSection draft={draft} setDraft={setter} />
}

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("InterfaceSection", () => {
  it("renders the header and language/font controls", () => {
    render(<ControlledSection />)
    expect(screen.getByText("settings.sections.interface.title")).toBeInTheDocument()
    expect(screen.getByText("English")).toBeInTheDocument()
    expect(screen.getByText("中文")).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.getByText("默认")).toBeInTheDocument()
  })

  it("switching language updates uiLanguage", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.click(screen.getByText("English"))
    expect(setDraftSpy).toHaveBeenCalledWith("uiLanguage", "en")
  })

  it("active language button gets the primary styling", () => {
    render(<ControlledSection />)
    const zhBtn = screen.getByText("中文").closest("button")!
    expect(zhBtn.className).toContain("border-primary")
    const enBtn = screen.getByText("English").closest("button")!
    expect(enBtn.className).not.toContain("border-primary")
  })

  it("moving the font-size slider updates uiFontSizeScale as a fraction", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    const slider = screen.getByRole("slider", { name: "界面字号" }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: "115" } })
    expect(setDraftSpy).toHaveBeenCalledWith("uiFontSizeScale", 1.15)
  })

  it("preset buttons set the exact font size", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.click(screen.getByText("小"))
    expect(setDraftSpy).toHaveBeenCalledWith("uiFontSizeScale", 0.9)
    fireEvent.click(screen.getByText("特大"))
    expect(setDraftSpy).toHaveBeenCalledWith("uiFontSizeScale", 1.3)
  })

  it("active font preset gets primary styling", () => {
    render(<ControlledSection initial={makeDraft({ uiFontSizeScale: 0.9 })} />)
    const small = screen.getByText("小").closest("button")!
    expect(small.className).toContain("border-primary")
    const large = screen.getByText("大").closest("button")!
    expect(large.className).not.toContain("border-primary")
  })

  it("renders the percentage scale from a custom uiFontSizeScale", () => {
    render(<ControlledSection initial={makeDraft({ uiFontSizeScale: 1.3 })} />)
    expect(screen.getByText("130%")).toBeInTheDocument()
  })
})
