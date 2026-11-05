// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// TitleBar 收纳栏：主题循环/字号±/设置跳转/窗口控制（三操作静默失败）。

import { describe, expect, it, vi, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen } from "@/test-helpers/component-test-utils"
import { TitleBar } from "./title-bar"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  project: null as { id: string; name: string; path: string } | null,
  theme: "light",
  setTheme: vi.fn(),
  uiFontSizeScale: 1,
  setUiFontSizeScale: vi.fn(),
  setActiveView: vi.fn(),
  setActiveSettingsCategory: vi.fn(),
  saveTheme: vi.fn(),
  applyTheme: vi.fn(),
  isTauri: true,
  win: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() },
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        project: mocks.project,
        theme: mocks.theme,
        setTheme: mocks.setTheme,
        uiFontSizeScale: mocks.uiFontSizeScale,
        setUiFontSizeScale: mocks.setUiFontSizeScale,
        setActiveView: mocks.setActiveView,
        setActiveSettingsCategory: mocks.setActiveSettingsCategory,
      }),
  }
})

vi.mock("@/lib/project-store", () => ({ saveTheme: mocks.saveTheme }))
vi.mock("@/lib/theme-utils", () => ({ applyTheme: mocks.applyTheme }))
vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.win }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.project = null
  mocks.theme = "light"
  mocks.uiFontSizeScale = 1
  mocks.isTauri = true
})

describe("TitleBar", () => {
  it("渲染应用名与字号百分比", () => {
    render(<TitleBar />)
    expect(screen.getByTestId("title-bar")).toBeInTheDocument()
    expect(screen.getByText("Niko Buddy")).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("有项目时显示项目名", () => {
    mocks.project = { id: "p1", name: "长篇", path: "/p" }
    render(<TitleBar />)
    expect(screen.getByText(/长篇/)).toBeInTheDocument()
  })

  it("主题按钮循环到下一主题并持久化", () => {
    render(<TitleBar />)
    fireEvent.click(screen.getByLabelText("theme.switch"))
    expect(mocks.setTheme).toHaveBeenCalledWith("dark")
    expect(mocks.saveTheme).toHaveBeenCalledWith("dark")
    expect(mocks.applyTheme).toHaveBeenCalledWith("dark")
  })

  it("字号±按钮按0.05步进", () => {
    render(<TitleBar />)
    fireEvent.click(screen.getByLabelText("增大字号"))
    expect(mocks.setUiFontSizeScale).toHaveBeenCalledWith(1.05)
    fireEvent.click(screen.getByLabelText("减小字号"))
    expect(mocks.setUiFontSizeScale).toHaveBeenCalledWith(0.95)
  })

  it("字号到界时按钮禁用", () => {
    mocks.uiFontSizeScale = 1.3
    render(<TitleBar />)
    expect(screen.getByLabelText("增大字号")).toBeDisabled()
  })

  it("百分比按钮跳转界面设置", () => {
    render(<TitleBar />)
    fireEvent.click(screen.getByText("100%"))
    expect(mocks.setActiveSettingsCategory).toHaveBeenCalledWith("interface")
    expect(mocks.setActiveView).toHaveBeenCalledWith("settings")
  })

  it("窗口控制三操作调用对应API", async () => {
    render(<TitleBar />)
    fireEvent.click(screen.getByLabelText("最小化"))
    fireEvent.click(screen.getByLabelText("最大化/还原"))
    fireEvent.click(screen.getByLabelText("关闭"))
    await vi.waitFor(() => {
      expect(mocks.win.minimize).toHaveBeenCalled()
      expect(mocks.win.toggleMaximize).toHaveBeenCalled()
      expect(mocks.win.close).toHaveBeenCalled()
    })
  })

  it("非Tauri环境不渲染窗口控制", () => {
    mocks.isTauri = false
    render(<TitleBar />)
    expect(screen.queryByLabelText("最小化")).not.toBeInTheDocument()
  })

  // 无边框窗口（tauri.conf.json decorations:false）下，顶栏是唯一的窗口外框，
  // 所以它必须同时是拖拽区，否则窗口无法移动。这条钉住那个约定。
  it("顶栏根元素声明为 deep 拖拽区（无边框窗口下靠它移动窗口）", () => {
    render(<TitleBar />)
    expect(screen.getByTestId("title-bar")).toHaveAttribute("data-tauri-drag-region", "deep")
  })
})

// ── statements 补测：主题图标四态 + win() 的非 Tauri 早退守卫 ──────────
describe("TitleBar — 主题图标与非 Tauri 守卫", () => {
  const cases: Array<{ theme: string; icon: string }> = [
    { theme: "dark", icon: "lucide-moon" },
    { theme: "deep-blue", icon: "lucide-monitor" },
    { theme: "eye-care", icon: "lucide-eye" },
    { theme: "system", icon: "lucide-arrow-left-right" },
  ]

  for (const { theme, icon } of cases) {
    it(`theme=${theme} 时主题按钮展示对应图标（${icon}）`, () => {
      mocks.theme = theme
      const { container } = render(<TitleBar />)
      const button = screen.getByLabelText("theme.switch")
      expect(button.querySelector(`svg.${icon}`)).not.toBeNull()
      expect(container.querySelectorAll("header button svg").length).toBeGreaterThan(0)
    })
  }

  it("渲染后环境变为非 Tauri：点窗口控制不再调用原生 API", () => {
    render(<TitleBar />)
    const minimize = screen.getByLabelText("最小化")
    // 环境在渲染后降级（web 预览/测试环境）→ win() 的 isTauri 守卫必须早退
    mocks.isTauri = false
    fireEvent.click(minimize)
    expect(mocks.win.minimize).not.toHaveBeenCalled()
  })
})
