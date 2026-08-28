// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/changelog-section.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  act,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { ChangelogSection } from "./changelog-section"
import type { ChangelogEntry } from "@/lib/changelog"

// ── hoisted mocks ────────────────────────────────────────────────────────────

/**
 * 结构子集：镜像真实 @tauri-apps/plugin-updater 的 Update 类中
 * changelog-section 实际消费的成员（version/body/download/install）。
 * 真实 Update 还要求 currentVersion/rawJson/downloadAndInstall/close 等，
 * 测试数据无需构造这些成员。
 */
interface MockUpdate {
  version: string
  body?: string
  download?: (onEvent?: (e: { event: string; data: Record<string, unknown> }) => void) => Promise<void>
  install?: () => Promise<void>
}

const mocks = vi.hoisted(() => {
  const langState = { language: "zh" }
  return {
    langState,
    t: vi.fn((key: string) => key),
    allChangelog: vi.fn<() => ChangelogEntry[]>(() => []),
    isTauri: vi.fn(() => false),
    formatUpdateErrorMessage: vi.fn((_err: unknown) => "formatted-update-error"),
    checkUpdate: vi.fn<() => Promise<MockUpdate | null>>(async () => null),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: mocks.langState }),
}))

vi.mock("@/lib/changelog", () => ({
  allChangelog: mocks.allChangelog,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@/lib/update-error-message", () => ({
  formatUpdateErrorMessage: mocks.formatUpdateErrorMessage,
}))

// Intercepts the dynamic import("@tauri-apps/plugin-updater") too.
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.checkUpdate,
}))

function longHighlights(prefix: string): string[] {
  return Array.from({ length: 7 }, (_, i) => `${prefix} line ${i + 1}`)
}

const ENTRIES = [
  {
    version: "2.7.3", // == __APP_VERSION__ (package.json)
    date: "2026-08-18",
    highlights: { zh: longHighlights("zh"), en: longHighlights("en") },
  },
  {
    version: "2.4.0",
    date: "2026-07-01",
    highlights: { zh: ["zh short"], en: ["en short"] },
  },
  {
    version: "2.3.0",
    date: "2026-06-01",
    highlights: { zh: [], en: [] },
  },
]

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.langState.language = "zh"
  mocks.allChangelog.mockClear()
  mocks.allChangelog.mockReturnValue(ENTRIES)
  mocks.isTauri.mockClear()
  mocks.isTauri.mockReturnValue(false)
  mocks.formatUpdateErrorMessage.mockClear()
  mocks.checkUpdate.mockClear()
  mocks.checkUpdate.mockResolvedValue(null)
})

describe("ChangelogSection", () => {
  it("zh 语言：当前版本徽标 + 收起/展开长条目", () => {
    render(<ChangelogSection />)
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "v2.7.3")).toBeInTheDocument()
    expect(screen.getByText("\\u2190 当前版本")).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "v2.4.0")).toBeInTheDocument()
    // 长条目：默认只显示前 5 条 + 查看更多按钮
    expect(screen.getByText("zh line 1")).toBeInTheDocument()
    expect(screen.queryByText("zh line 6")).not.toBeInTheDocument()
    expect(screen.getByText("查看更多 2 条")).toBeInTheDocument()

    fireEvent.click(screen.getByText("查看更多 2 条"))
    expect(screen.getByText("zh line 6")).toBeInTheDocument()
    expect(screen.getByText("zh line 7")).toBeInTheDocument()
    expect(screen.getByText("收起")).toBeInTheDocument()

    fireEvent.click(screen.getByText("收起"))
    expect(screen.queryByText("zh line 6")).not.toBeInTheDocument()
    expect(screen.getByText("查看更多 2 条")).toBeInTheDocument()
  })

  it("en 语言渲染英文条目", () => {
    mocks.langState.language = "en"
    render(<ChangelogSection />)
    expect(screen.getByText("en line 1")).toBeInTheDocument()
    expect(screen.getByText("en short")).toBeInTheDocument()
    expect(screen.getByText("当前版本：v2.7.3")).toBeInTheDocument()
  })

  it("短条目与空 highlights 无展开按钮", () => {
    render(<ChangelogSection />)
    const buttons = screen
      .queryAllByText(/查看更多|收起/)
      .filter((el) => el.tagName === "BUTTON")
    expect(buttons).toHaveLength(1) // 只有 2.5.0 的长条目有
    expect(screen.getByText("zh short")).toBeInTheDocument()
  })

  it("非 Tauri 环境检查更新 → 桌面版错误提示", async () => {
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("仅桌面版支持自动更新检测")).toBeInTheDocument()
    })
    expect(mocks.checkUpdate).not.toHaveBeenCalled()
  })

  it("Tauri 检查更新：无可用更新 → up-to-date", async () => {
    mocks.isTauri.mockReturnValue(true)
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("当前已是最新版本")).toBeInTheDocument()
    })
    expect(mocks.checkUpdate).toHaveBeenCalled()
  })

  it("Tauri 检查更新：有可用更新（body 有内容）→ 横幅 + 下载按钮", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.checkUpdate.mockResolvedValue({ version: "3.0.0", body: "  Release notes here  " })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("发现新版本：v3.0.0")).toBeInTheDocument()
    })
    expect(screen.getByText("Release notes here")).toBeInTheDocument()
    expect(screen.getByText("下载更新")).toBeInTheDocument()
  })

  it("Tauri 检查更新：body 为 undefined → 不显示 notes", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.checkUpdate.mockResolvedValue({ version: "3.1.0" })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("发现新版本：v3.1.0")).toBeInTheDocument()
    })
    expect(screen.queryByText("Release notes here")).not.toBeInTheDocument()
  })

  it("Tauri 检查更新：check 抛错 → 格式化错误提示", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.checkUpdate.mockRejectedValue(new Error("net-down"))
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("formatted-update-error")).toBeInTheDocument()
    })
    expect(mocks.formatUpdateErrorMessage).toHaveBeenCalled()
  })

  it("检查中状态：按钮禁用 + 正在检查... 文案", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.checkUpdate.mockReturnValue(new Promise(() => {}))
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    const checkingBtn = screen.getByText("正在检查...").closest("button") as HTMLButtonElement
    expect(checkingBtn.disabled).toBe(true)
  })

  it("下载更新：Started/Progress/Finished 事件推进进度 → ready 状态", async () => {
    mocks.isTauri.mockReturnValue(true)
    let progressCb: ((e: { event: string; data: Record<string, unknown> }) => void) | undefined
    let resolveDownload: (() => void) | undefined
    mocks.checkUpdate.mockResolvedValue({
      version: "3.2.0",
      body: "b",
      download: vi.fn(async (cb?: (e: { event: string; data: Record<string, unknown> }) => void) => {
        progressCb = cb
        await new Promise<void>((resolve) => {
          resolveDownload = resolve
        })
      }),
      install: vi.fn(async () => {}),
    })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("下载更新")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("下载更新"))
    await waitFor(() => {
      expect(screen.getByText("正在下载更新...")).toBeInTheDocument()
    })
    expect(screen.getByText("0%")).toBeInTheDocument()

    progressCb?.({ event: "Started", data: { contentLength: 100 } })
    act(() => progressCb?.({ event: "Progress", data: { chunkLength: 50 } }))
    expect(screen.getByText("50%")).toBeInTheDocument()
    act(() => progressCb?.({ event: "Progress", data: { chunkLength: 50 } }))
    // round(100/100*100)=100 → min(100,99)=99
    expect(screen.getByText("99%")).toBeInTheDocument()
    act(() => progressCb?.({ event: "Finished", data: {} }))
    expect(screen.getByText("100%")).toBeInTheDocument()

    resolveDownload?.()
    await waitFor(() => {
      expect(screen.getByText("✅ 更新已下载完成！安装时会关闭当前软件，请确保已保存编辑内容。")).toBeInTheDocument()
    })
    expect(screen.getByText("立即安装")).toBeInTheDocument()
  })

  it("下载更新：无 contentLength 时进度 +1 回退", async () => {
    mocks.isTauri.mockReturnValue(true)
    let progressCb: ((e: { event: string; data: Record<string, unknown> }) => void) | undefined
    let resolveDownload: (() => void) | undefined
    mocks.checkUpdate.mockResolvedValue({
      version: "3.3.0",
      body: "b",
      download: vi.fn(async (cb?: (e: { event: string; data: Record<string, unknown> }) => void) => {
        progressCb = cb
        await new Promise<void>((resolve) => {
          resolveDownload = resolve
        })
      }),
      install: vi.fn(async () => {}),
    })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("下载更新")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("下载更新"))
    await waitFor(() => {
      expect(screen.getByText("正在下载更新...")).toBeInTheDocument()
    })
    act(() => progressCb?.({ event: "Started", data: {} })) // 无 contentLength
    act(() => progressCb?.({ event: "Progress", data: { chunkLength: 10 } }))
    // totalSize=0 → prev+1 = 1
    expect(screen.getByText("1%")).toBeInTheDocument()
    act(() => progressCb?.({ event: "Finished", data: {} }))
    expect(screen.getByText("100%")).toBeInTheDocument()

    resolveDownload?.()
    await waitFor(() => {
      expect(screen.getByText("立即安装")).toBeInTheDocument()
    })
  })

  it("下载更新：download 抛错 → 格式化错误", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.checkUpdate.mockResolvedValue({
      version: "3.4.0",
      body: "b",
      download: vi.fn(async () => {
        throw new Error("dl-fail")
      }),
      install: vi.fn(async () => {}),
    })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("下载更新")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("下载更新"))
    await waitFor(() => {
      expect(screen.getByText("formatted-update-error")).toBeInTheDocument()
    })
    expect(mocks.formatUpdateErrorMessage).toHaveBeenCalled()
  })

  it("立即安装：install 成功", async () => {
    mocks.isTauri.mockReturnValue(true)
    const install = vi.fn(async () => {})
    mocks.checkUpdate.mockResolvedValue({
      version: "3.5.0",
      body: "b",
      download: vi.fn(async () => {}),
      install,
    })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("下载更新")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("下载更新"))
    await waitFor(() => {
      expect(screen.getByText("立即安装")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("立即安装"))
    await waitFor(() => {
      expect(install).toHaveBeenCalled()
    })
  })

  it("立即安装：install 抛错被吞掉", async () => {
    mocks.isTauri.mockReturnValue(true)
    const install = vi.fn(async () => {
      throw new Error("restart-expected")
    })
    mocks.checkUpdate.mockResolvedValue({
      version: "3.6.0",
      body: "b",
      download: vi.fn(async () => {}),
      install,
    })
    render(<ChangelogSection />)
    fireEvent.click(screen.getByText("检查更新"))
    await waitFor(() => {
      expect(screen.getByText("下载更新")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("下载更新"))
    await waitFor(() => {
      expect(screen.getByText("立即安装")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText("立即安装"))
    await waitFor(() => {
      expect(install).toHaveBeenCalled()
    })
    // 错误被吞：不出现错误提示
    expect(screen.queryByText("formatted-update-error")).not.toBeInTheDocument()
  })
})
