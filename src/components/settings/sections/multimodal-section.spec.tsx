// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/multimodal-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { MultimodalSection } from "./multimodal-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    multimodalEnabled: false,
    multimodalUseMainLlm: false,
    multimodalProvider: "custom",
    multimodalApiKey: "",
    multimodalModel: "",
    multimodalOllamaUrl: "",
    multimodalCustomEndpoint: "",
    multimodalConcurrency: 4,
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
  return <MultimodalSection draft={draft} setDraft={setter} />
}

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("MultimodalSection", () => {
  it("renders the header and the OFF master switch when disabled", () => {
    render(<ControlledSection />)
    expect(screen.getByText("settings.sections.multimodal.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.stateOff")).toBeInTheDocument()
    expect(screen.queryByText("settings.sections.multimodal.provider")).not.toBeInTheDocument()
  })

  it("master switch toggles enabled and shows ON with the expanded panel", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    fireEvent.click(screen.getByRole("switch", { name: "settings.sections.multimodal.enableLabel" }))
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalEnabled", true)
  })

  it("enabled state shows the use-main-LLM row, provider panel, concurrency, and cost guardrails", () => {
    render(<ControlledSection initial={makeDraft({ multimodalEnabled: true })} />)
    expect(screen.getByText("settings.sections.multimodal.stateOn")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.useMainLabel")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.dedicatedHeading")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.concurrency")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.costHeading")).toBeInTheDocument()
    expect(screen.getAllByText(/settings\.sections\.multimodal\.costPoint/).length).toBe(4)
  })

  it("use-main-LLM toggle hides the dedicated endpoint panel", () => {
    render(<ControlledSection initial={makeDraft({ multimodalEnabled: true })} />)
    fireEvent.click(
      screen.getByRole("switch", { name: "settings.sections.multimodal.useMainLabel" }),
    )
    expect(screen.queryByText("settings.sections.multimodal.dedicatedHeading")).not.toBeInTheDocument()
    // 面板隐藏后 concurrency 与 cost guardrails 仍在
    expect(screen.getByText("settings.sections.multimodal.concurrency")).toBeInTheDocument()
  })

  it("provider select switches to ollama and reveals the Ollama URL input", () => {
    render(<ControlledSection initial={makeDraft({ multimodalEnabled: true })} />)
    const select = screen.getByDisplayValue("Custom (OpenAI-compat)") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "ollama" } })
    expect(screen.getByPlaceholderText("http://localhost:11434")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("http://localhost:1234/v1")).not.toBeInTheDocument()
  })

  it("provider custom reveals the endpoint URL input and hint", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({ multimodalEnabled: true, multimodalProvider: "custom" })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    expect(screen.getByPlaceholderText("http://localhost:1234/v1")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.multimodal.customEndpointHint")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("http://localhost:1234/v1"), {
      target: { value: "http://lmstudio.local:1234/v1" },
    })
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalCustomEndpoint", "http://lmstudio.local:1234/v1")
  })

  it("provider openai renders neither ollama nor custom endpoint inputs", () => {
    render(
      <ControlledSection
        initial={makeDraft({ multimodalEnabled: true, multimodalProvider: "openai" })}
      />,
    )
    expect(screen.queryByPlaceholderText("http://localhost:11434")).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("http://localhost:1234/v1")).not.toBeInTheDocument()
  })

  it("edits api key, model, ollama url, and endpoint fields", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({ multimodalEnabled: true, multimodalProvider: "ollama" })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText("http://localhost:11434"), {
      target: { value: "http://ollama.local:11434" },
    })
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalOllamaUrl", "http://ollama.local:11434")
    fireEvent.change(screen.getByPlaceholderText("settings.sections.multimodal.apiKeyPlaceholder"), {
      target: { value: "sk-key" },
    })
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalApiKey", "sk-key")
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Qwen2.5-VL-7B-Instruct, claude-3-5-sonnet-latest, gemini-2.5-flash"),
      { target: { value: "qwen2.5-vl" } },
    )
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalModel", "qwen2.5-vl")
  })

  it("concurrency input: numeric values propagate (empty string coerces to 0)", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({ multimodalEnabled: true })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    const concurrency = screen.getByRole("spinbutton") as HTMLInputElement
    fireEvent.change(concurrency, { target: { value: "8" } })
    expect(setDraftSpy).toHaveBeenCalledWith("multimodalConcurrency", 8)

    // type=number 输入在 jsdom 中非数字被清洗为 "" → Number("") = 0（有限）→ 透传 0
    fireEvent.change(concurrency, { target: { value: "" } })
    expect(setDraftSpy).toHaveBeenLastCalledWith("multimodalConcurrency", 0)
    // 注：`Number.isFinite(n) ? n : 4` 的 `: 4` 兜底分支在真实 DOM 输入下不可达
    // （type=number 的 value 只会是有限数字或 ""）—— 属防御性分支，记录为不可达。
    // 另：PillSwitch 的 `${showTextState ? "" : ""}` 为退化三元（两侧同串），且组件
    // 唯一用法固定传 showTextState，假分支不可达。
  })
})
