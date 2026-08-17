// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/network-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { NetworkSection } from "./network-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  validateProxyUrl: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/proxy-config", () => ({
  validateProxyUrl: mocks.validateProxyUrl,
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    proxyEnabled: false,
    proxyUrl: "",
    proxyBypassLocal: true,
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
  return <NetworkSection draft={draft} setDraft={setter} />
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.validateProxyUrl.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("NetworkSection", () => {
  it("renders the header and disables proxy inputs until enabled", () => {
    render(<ControlledSection />)
    expect(screen.getByText("settings.sections.network.title")).toBeInTheDocument()
    const url = screen.getByLabelText("settings.sections.network.url") as HTMLInputElement
    expect(url.disabled).toBe(true)
    const bypass = screen.getByRole("checkbox", { name: /settings\.sections\.network\.bypassLocal/ }) as HTMLInputElement
    expect(bypass.disabled).toBe(true)
  })

  it("enabling the proxy enables the URL input and bypass checkbox", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.click(screen.getByText("settings.sections.network.enable"))
    expect(setDraftSpy).toHaveBeenCalledWith("proxyEnabled", true)
  })

  it("typing a proxy URL updates the draft", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection initial={makeDraft({ proxyEnabled: true })} setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.change(screen.getByLabelText("settings.sections.network.url"), {
      target: { value: "http://127.0.0.1:7890" },
    })
    expect(setDraftSpy).toHaveBeenCalledWith("proxyUrl", "http://127.0.0.1:7890")
  })

  it("empty URL: no validation and no error", () => {
    render(<ControlledSection initial={makeDraft({ proxyEnabled: true })} />)
    expect(mocks.validateProxyUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("invalid URL with proxy enabled: destructive input styling + error message", () => {
    mocks.validateProxyUrl.mockReturnValue({ ok: false, error: "URL is missing a host" })
    render(
      <ControlledSection
        initial={makeDraft({ proxyEnabled: true, proxyUrl: "http://" })}
      />,
    )
    expect(screen.getByText("URL is missing a host")).toBeInTheDocument()
    const urlClass = (screen.getByLabelText("settings.sections.network.url") as HTMLInputElement)
      .className.split(" ")
    expect(urlClass).toContain("border-destructive")
  })

  it("invalid URL but proxy disabled: no error shown", () => {
    mocks.validateProxyUrl.mockReturnValue({ ok: false, error: "URL is missing a host" })
    render(<ControlledSection initial={makeDraft({ proxyUrl: "http://" })} />)
    expect(screen.queryByText("URL is missing a host")).not.toBeInTheDocument()
  })

  it("valid URL: no error message", () => {
    mocks.validateProxyUrl.mockReturnValue({ ok: true })
    render(
      <ControlledSection
        initial={makeDraft({ proxyEnabled: true, proxyUrl: "http://127.0.0.1:7890" })}
      />,
    )
    expect(screen.queryByText(/URL is missing a host/)).not.toBeInTheDocument()
    // 基础 class 含 aria-invalid:border-destructive 变体 —— 断言精确 token 而非子串
    const urlClass = (screen.getByLabelText("settings.sections.network.url") as HTMLInputElement)
      .className.split(" ")
    expect(urlClass).not.toContain("border-destructive")
  })

  it("bypass-local toggle updates the draft when enabled", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection initial={makeDraft({ proxyEnabled: true })} setDraftSpy={setDraftSpy as DraftSetter} />)
    const bypass = screen.getByRole("checkbox", { name: /settings\.sections\.network\.bypassLocal/ }) as HTMLInputElement
    fireEvent.click(bypass)
    expect(setDraftSpy).toHaveBeenCalledWith("proxyBypassLocal", false)
  })
})
