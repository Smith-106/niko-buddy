// @vitest-environment jsdom
import { act, render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CliProbeStrip } from "./cli-probe-strip"

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))
vi.mock("@/lib/platform", () => ({ isTauri: mocks.isTauri }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTauri.mockReturnValue(true)
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "codex_cli_detect") throw new Error("no codex")
    return { installed: cmd !== "cursor_cli_detect", version: "1.0", error: cmd === "cursor_cli_detect" ? "missing" : null }
  })
  setupDomGlobals()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("CliProbeStrip", () => {
  it("并行四探针 ok/err 渲染", async () => {
    render(<CliProbeStrip />)
    expect(await screen.findByTestId("cli-probe-claude")).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith("claude_cli_detect")
    expect(mocks.invoke).toHaveBeenCalledWith("codex_cli_detect")
    expect(mocks.invoke).toHaveBeenCalledWith("cursor_cli_detect")
    expect(mocks.invoke).toHaveBeenCalledWith("antigravity_cli_detect")
    await act(async () => {})
  })
  it("非桌面端四格 err", async () => {
    mocks.isTauri.mockReturnValue(false)
    render(<CliProbeStrip />)
    expect(await screen.findByTestId("cli-probe-strip")).toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
    // 内部错误码 desktopOnly 不再直接展示，而是走 i18n 键
    expect(screen.getAllByText("settings.sections.llm.cliStatus.desktopOnly")).toHaveLength(4)
    expect(screen.queryByText("desktopOnly")).not.toBeInTheDocument()
    await act(async () => {})
  })
  it("重检按钮可点", async () => {
    render(<CliProbeStrip />)
    const btn = await screen.findByRole("button")
    await act(async () => { fireEvent.click(btn) })
    expect(mocks.invoke.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
