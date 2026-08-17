// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/output-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { OutputSection } from "./output-section"
import { OUTPUT_LANGUAGE_OPTIONS } from "@/lib/output-language-options"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    outputLanguage: "auto",
    maxHistoryMessages: 6,
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
  return <OutputSection draft={draft} setDraft={setter} />
}

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("OutputSection", () => {
  it("renders every language option from the shared constant", () => {
    render(<ControlledSection />)
    const select = screen.getByRole("combobox") as HTMLSelectElement
    expect(select.options.length).toBe(OUTPUT_LANGUAGE_OPTIONS.length)
    expect(select.value).toBe("auto")
    expect(screen.getByText(OUTPUT_LANGUAGE_OPTIONS[1].label)).toBeInTheDocument()
  })

  it("changing the output language updates the draft", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    const select = screen.getByRole("combobox") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "Chinese" } })
    expect(setDraftSpy).toHaveBeenCalledWith("outputLanguage", "Chinese")
  })

  it("renders all history length presets with the active one styled", () => {
    render(<ControlledSection initial={makeDraft({ maxHistoryMessages: 4 })} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.map((b) => b.textContent)).toEqual(["2", "4", "6", "8", "10", "20"])
    const active = buttons.find((b) => b.className.includes("border-primary"))
    expect(active?.textContent).toBe("4")
  })

  it("clicking a history preset updates maxHistoryMessages", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.click(screen.getByRole("button", { name: "10" }))
    expect(setDraftSpy).toHaveBeenCalledWith("maxHistoryMessages", 10)
  })

  it("renders the history current text with turns computed from the draft", () => {
    render(<ControlledSection initial={makeDraft({ maxHistoryMessages: 8 })} />)
    const call = mocks.t.mock.calls.find((c) => c[0] === "settings.sections.output.historyCurrent")
    expect(call?.[1]).toEqual({ count: 8, turns: 4 })
  })
})
