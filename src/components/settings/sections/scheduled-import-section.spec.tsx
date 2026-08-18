// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/scheduled-import-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup, waitFor } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
} from "@/test-helpers/component-test-utils"
import { ScheduledImportSection } from "./scheduled-import-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface ProjectLike {
  id: string
  path: string
  name: string
}

const mocks = vi.hoisted(() => {
  const state: {
    project: ProjectLike | null
    scheduledImportConfig: { lastScan: string | null; intervalMinutes: number }
  } = {
    project: null,
    scheduledImportConfig: { lastScan: null, intervalMinutes: 15 },
  }
  return {
    state,
    t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
    scanAndImport: vi.fn(async () => {}),
    pickDirectory: vi.fn<() => Promise<string | null>>(async () => null),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/scheduled-import", () => ({
  scanAndImport: mocks.scanAndImport,
}))

vi.mock("@/lib/platform", () => ({
  pickDirectory: mocks.pickDirectory,
}))

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    scheduledImportEnabled: false,
    scheduledImportPath: "",
    scheduledImportInterval: 15,
    ...overrides,
  } as SettingsDraft
}

function ControlledSection({ initial }: { initial?: SettingsDraft }) {
  const [draft, setDraft] = useState(initial ?? makeDraft())
  const setter: DraftSetter = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }
  return <ScheduledImportSection draft={draft} setDraft={setter} />
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.scanAndImport.mockClear()
  mocks.scanAndImport.mockResolvedValue(undefined)
  mocks.pickDirectory.mockClear()
  mocks.pickDirectory.mockResolvedValue(null)
  mocks.state.project = null
  mocks.state.scheduledImportConfig = { lastScan: null, intervalMinutes: 15 }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ScheduledImportSection", () => {
  it("renders header, disabled controls, and 从未扫描 last-scan label", () => {
    render(<ScheduledImportSection draft={makeDraft()} setDraft={() => {}} />)
    expect(screen.getByText("settings.sections.scheduledImport.title")).toBeInTheDocument()
    const pathInput = screen.getByPlaceholderText("raw/sources") as HTMLInputElement
    expect(pathInput.disabled).toBe(true)
    expect(screen.getByText("settings.sections.scheduledImport.scanNow")).toBeInTheDocument()
    const lastScanCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.scheduledImport.lastScan",
    )
    expect(lastScanCall?.[1]?.time).toBe("settings.sections.scheduledImport.never")
  })

  it("enable toggle shows privacy notice and enables controls", () => {
    render(<ControlledSection initial={makeDraft({ scheduledImportEnabled: true })} />)
    expect(screen.getByText("settings.sections.scheduledImport.privacyNotice")).toBeInTheDocument()
    expect((screen.getByPlaceholderText("raw/sources") as HTMLInputElement).disabled).toBe(false)
  })

  it("enable checkbox onChange toggles draft.scheduledImportEnabled", () => {
    const setDraftSpy = vi.fn()
    const setter: DraftSetter = (key, value) => {
      setDraftSpy(key, value)
    }
    render(
      <ScheduledImportSection
        draft={makeDraft()}
        setDraft={setter}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.scheduledImport.enable"))
    expect(setDraftSpy).toHaveBeenCalledWith("scheduledImportEnabled", true)
  })

  it("directory pick: setDraft called with the picked path", async () => {
    mocks.pickDirectory.mockResolvedValue("D:/watch")
    const setDraft = vi.fn()
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true })}
        setDraft={setDraft as DraftSetter}
      />,
    )
    fireEvent.click(screen.getByTitle("settings.sections.scheduledImport.browse"))
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith("scheduledImportPath", "D:/watch"))
  })

  it("directory pick cancelled (null): no setDraft call", async () => {
    const setDraft = vi.fn()
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true })}
        setDraft={setDraft as DraftSetter}
      />,
    )
    fireEvent.click(screen.getByTitle("settings.sections.scheduledImport.browse"))
    await waitFor(() => expect(mocks.pickDirectory).toHaveBeenCalled())
    expect(setDraft).not.toHaveBeenCalled()
  })

  it("directory input change propagates via setDraft", () => {
    render(<ControlledSection initial={makeDraft({ scheduledImportEnabled: true })} />)
    fireEvent.change(screen.getByPlaceholderText("raw/sources"), { target: { value: "/tmp/x" } })
    expect(screen.getByPlaceholderText("raw/sources")).toHaveValue("/tmp/x")
  })

  it("interval input: valid value propagates, NaN is ignored", () => {
    render(<ControlledSection initial={makeDraft({ scheduledImportEnabled: true })} />)
    const interval = screen.getByLabelText("settings.sections.scheduledImport.interval") as HTMLInputElement
    fireEvent.change(interval, { target: { value: "30" } })
    expect(interval.value).toBe("30")
    fireEvent.change(interval, { target: { value: "abc" } })
    // parseInt NaN → 不更新
    expect(interval.value).toBe("30")
  })

  it("manual scan runs when project present and enabled with a path", async () => {
    mocks.state.project = { id: "p1", path: "/book", name: "Book" }
    const setDraft = vi.fn()
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true, scheduledImportPath: "raw/sources" })}
        setDraft={setDraft as DraftSetter}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.scheduledImport.scanNow"))
    await waitFor(() => {
      expect(mocks.scanAndImport).toHaveBeenCalledWith(mocks.state.project, "raw/sources")
    })
    expect(screen.getByText("settings.sections.scheduledImport.scanNow")).toBeInTheDocument()
  })

  it("manual scan shows 扫描中... while pending", async () => {
    mocks.state.project = { id: "p1", path: "/book", name: "Book" }
    let resolveScan: (() => void) | undefined
    mocks.scanAndImport.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveScan = resolve
        }),
    )
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true, scheduledImportPath: "raw/sources" })}
        setDraft={() => {}}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.scheduledImport.scanNow"))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByText("settings.sections.scheduledImport.scanning")).toBeInTheDocument()
    resolveScan?.()
    await waitFor(() => {
      expect(screen.getByText("settings.sections.scheduledImport.scanNow")).toBeInTheDocument()
    })
  })

  it("manual scan failure logs to console.error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.state.project = { id: "p1", path: "/book", name: "Book" }
    mocks.scanAndImport.mockRejectedValue(new Error("scan failed"))
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true, scheduledImportPath: "raw/sources" })}
        setDraft={() => {}}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.scheduledImport.scanNow"))
    await waitFor(() => {
      expect(mocks.scanAndImport).toHaveBeenCalled()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(consoleSpy).toHaveBeenCalled()
  })

  it("manual scan is a no-op without a project", async () => {
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true, scheduledImportPath: "raw/sources" })}
        setDraft={() => {}}
      />,
    )
    fireEvent.click(screen.getByText("settings.sections.scheduledImport.scanNow"))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.scanAndImport).not.toHaveBeenCalled()
  })

  it("scan button disabled while scanning (early return guard)", async () => {
    mocks.state.project = { id: "p1", path: "/book", name: "Book" }
    let resolveScan: (() => void) | undefined
    mocks.scanAndImport.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveScan = resolve
        }),
    )
    render(
      <ScheduledImportSection
        draft={makeDraft({ scheduledImportEnabled: true, scheduledImportPath: "raw/sources" })}
        setDraft={() => {}}
      />,
    )
    const scanBtn = screen.getByText("settings.sections.scheduledImport.scanNow").closest("button")
    expect(scanBtn).not.toBeDisabled()
    fireEvent.click(scanBtn!)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const scanningBtn = screen.getByText("settings.sections.scheduledImport.scanning").closest("button")
    expect(scanningBtn).toBeDisabled()
    // isScanning=true 时再次点击 → handleManualScan 提前返回（不重复调用）
    fireEvent.click(scanningBtn!)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.scanAndImport).toHaveBeenCalledTimes(1)
    resolveScan?.()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  it("last scan renders a localized timestamp when lastScan is set", () => {
    mocks.state.scheduledImportConfig = { lastScan: "2026-08-10T10:30:00.000Z", intervalMinutes: 15 }
    render(<ScheduledImportSection draft={makeDraft()} setDraft={() => {}} />)
    const lastScanCall = mocks.t.mock.calls.find(
      (c) => c[0] === "settings.sections.scheduledImport.lastScan",
    )
    expect(typeof lastScanCall?.[1]?.time).toBe("string")
    expect(lastScanCall?.[1]?.time).not.toBe("settings.sections.scheduledImport.never")
  })

  it("controlled wrapper: enabled + interval edits flow through setDraft", () => {
    render(<ControlledSection initial={makeDraft({ scheduledImportEnabled: true })} />)
    const interval = screen.getByLabelText("settings.sections.scheduledImport.interval") as HTMLInputElement
    fireEvent.change(interval, { target: { value: "60" } })
    expect(interval.value).toBe("60")
  })
})
