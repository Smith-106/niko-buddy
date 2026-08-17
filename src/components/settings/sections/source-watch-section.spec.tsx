// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/source-watch-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup } from "@testing-library/react"
import {
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { SourceWatchSection } from "./source-watch-section"
import {
  DEFAULT_SOURCE_WATCH_CONFIG,
  normalizeSourceWatchConfig,
} from "@/lib/source-watch-config"
import type { SettingsDraft, DraftSetter } from "../settings-types"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG,
    ...overrides,
  } as SettingsDraft
}

function ControlledSection({
  initial,
  projectReady,
  setDraftSpy,
}: {
  initial?: SettingsDraft
  projectReady?: boolean
  setDraftSpy?: DraftSetter
}) {
  const [draft, setDraft] = useState(initial ?? makeDraft())
  const setter: DraftSetter = (key, value) => {
    setDraftSpy?.(key, value)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  return <SourceWatchSection draft={draft} setDraft={setter} projectReady={projectReady ?? true} />
}

/** 找到 .md 扩展名复选框对应的 label 文本节点。 */
function extCheckbox(ext: string): HTMLInputElement {
  return screen.getByText(`.${ext}`).closest("label")!.querySelector("input") as HTMLInputElement
}

/** label 内嵌套了 hint <p>，getByLabelText 全等匹配会失败 → 从 span 反查 label。 */
function fieldByLabel(labelKey: string): HTMLTextAreaElement {
  return screen
    .getByText(labelKey)
    .closest("label")!
    .querySelector("textarea") as HTMLTextAreaElement
}

beforeEach(() => {
  mocks.t.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("SourceWatchSection", () => {
  it("renders header, groups from SOURCE_WATCH_FILE_TYPE_GROUPS, defaults checked", () => {
    render(<ControlledSection />)
    expect(screen.getByText("settings.sections.sourceWatch.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.sourceWatch.groups.documents")).toBeInTheDocument()
    expect(screen.getByText(".md")).toBeInTheDocument()
    expect(extCheckbox("md").checked).toBe(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions.includes("md"))
    // 默认启用的文档/演示类型
    expect(extCheckbox("mdx").checked).toBe(true)
    expect(extCheckbox("pptx").checked).toBe(true)
    // 默认关闭的扩展（不在 includeExtensions 中）
    expect(extCheckbox("json").checked).toBe(false)
  })

  it("enabled toggle updates the watch config via setDraft (normalized)", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: { ...DEFAULT_SOURCE_WATCH_CONFIG, enabled: false },
        })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.sourceWatch.enable"))
    const arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.enabled).toBe(true)
    expect(arg.includeExtensions).toEqual(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions)
  })

  it("auto-ingest toggle updates config", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: { ...DEFAULT_SOURCE_WATCH_CONFIG, enabled: true },
        })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.sourceWatch.autoIngest"))
    const arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.autoIngest).toBe(!DEFAULT_SOURCE_WATCH_CONFIG.autoIngest)
  })

  it("extension toggle adds and removes extensions (sorted)", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: {
            ...DEFAULT_SOURCE_WATCH_CONFIG,
            includeExtensions: DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions.filter((x) => x !== "pptx"),
          },
        })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    // 勾选一个默认关闭的扩展（pptx）
    fireEvent.click(extCheckbox("pptx"))
    let arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.includeExtensions).toContain("pptx")
    expect(arg.includeExtensions).toEqual([...arg.includeExtensions].sort())

    // 取消一个默认开启的扩展（mdx）
    fireEvent.click(extCheckbox("mdx"))
    arg = setDraftSpy.mock.calls[1]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.includeExtensions).not.toContain("mdx")
  })

  it("extension checkbox reflects controlled state after toggle", () => {
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: {
            ...DEFAULT_SOURCE_WATCH_CONFIG,
            includeExtensions: DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions.filter((x) => x !== "pptx"),
          },
        })}
      />,
    )
    fireEvent.click(extCheckbox("pptx"))
    expect(extCheckbox("pptx").checked).toBe(true)
  })

  it("maxFileSizeMb: numeric change propagates; empty input falls back to 1", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    const sizeInput = screen.getByLabelText("settings.sections.sourceWatch.maxSize") as HTMLInputElement
    fireEvent.change(sizeInput, { target: { value: "50" } })
    let arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.maxFileSizeMb).toBe(50)

    fireEvent.change(sizeInput, { target: { value: "" } })
    arg = setDraftSpy.mock.calls[1]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.maxFileSizeMb).toBe(1)
  })

  it("excludeDirs textarea: joinList renders values; comma/newline split updates", () => {
    const setDraftSpy = vi.fn()
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: { ...DEFAULT_SOURCE_WATCH_CONFIG, excludeDirs: [".git", "drafts"] },
        })}
        setDraftSpy={setDraftSpy as DraftSetter}
      />,
    )
    const textarea = fieldByLabel("settings.sections.sourceWatch.excludeDirs")
    expect(textarea.value).toBe(".git, drafts")

    fireEvent.change(textarea, { target: { value: "node_modules,\ntmp" } })
    const arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.excludeDirs).toEqual(["node_modules", "tmp"])
  })

  it("excludeExtensions textarea splits input and trims empty items", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    const textarea = fieldByLabel("settings.sections.sourceWatch.excludeExtensions")
    fireEvent.change(textarea, { target: { value: "  tmp ,bak,, exe " } })
    const arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.excludeExtensions).toEqual(["tmp", "bak", "exe"])
  })

  it("excludeGlobs textarea splits comma/newline separated patterns", () => {
    const setDraftSpy = vi.fn()
    render(<ControlledSection setDraftSpy={setDraftSpy as DraftSetter} />)
    const textarea = fieldByLabel("settings.sections.sourceWatch.excludeGlobs")
    fireEvent.change(textarea, { target: { value: "*.draft.*\n~$*" } })
    const arg = setDraftSpy.mock.calls[0]?.[1] as unknown as typeof DEFAULT_SOURCE_WATCH_CONFIG
    expect(arg.excludeGlobs).toEqual(["*.draft.*", "~$*"])
  })

  it("projectReady=false disables all controls and shows the no-project hint", () => {
    render(<ControlledSection projectReady={false} />)
    expect(screen.getByText("settings.sections.sourceWatch.noProject")).toBeInTheDocument()
    expect(extCheckbox("md").disabled).toBe(true)
    expect((screen.getByLabelText("settings.sections.sourceWatch.maxSize") as HTMLInputElement).disabled).toBe(true)
  })

  it("extension checkboxes disabled when watch is disabled", () => {
    render(
      <ControlledSection
        initial={makeDraft({
          sourceWatchConfig: { ...DEFAULT_SOURCE_WATCH_CONFIG, enabled: false },
        })}
      />,
    )
    expect(extCheckbox("md").disabled).toBe(true)
  })

  it("normalizeSourceWatchConfig handles undefined draft config (defaults)", () => {
    render(<ControlledSection initial={makeDraft({ sourceWatchConfig: undefined as never })} />)
    // 组件内部 normalize(undefined) → 默认配置 → enabled 复选框未勾选
    expect(screen.getByText(".md")).toBeInTheDocument()
    const normalized = normalizeSourceWatchConfig(undefined)
    expect(normalized.includeExtensions).toEqual(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions)
  })
})
