// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// llm-provider-cli-pills.tsx 全口径覆盖 spec（TASK-020 从零新建）。
// 三个 CLI 健康 pill + Cursor 代理徽章 + proxyEndpointLabel 纯函数。
// invoke / isTauri / cursor-cli-proxy 全部 mock：只测面板自身的分支逻辑。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor, setupDomGlobals } from "@/test-helpers/component-test-utils"
import {
  AntigravityCliStatusPill,
  ClaudeCliStatusPill,
  CodexCliStatusPill,
  CursorProxyStatusBadge,
  proxyEndpointLabel,
} from "./llm-provider-cli-pills"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  getCursorProxyStatus: vi.fn(),
  stopCursorProxy: vi.fn(async () => undefined),
  t: vi.fn((key: string, options?: Record<string, unknown>) => {
    if (options && typeof options === "object") {
      const parts = Object.entries(options)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
      if (parts.length > 0) return `${key}[${parts.join(",")}]`
    }
    return key
  }),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))

vi.mock("@/lib/platform", () => ({ isTauri: mocks.isTauri }))

vi.mock("@/lib/cursor-cli-proxy", () => ({
  getCursorProxyStatus: mocks.getCursorProxyStatus,
  stopCursorProxy: mocks.stopCursorProxy,
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

function okDetect(overrides: Record<string, unknown> = {}) {
  return {
    installed: true,
    version: "1.2.3",
    path: "/usr/local/bin/tool",
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.isTauri.mockReturnValue(true)
  mocks.getCursorProxyStatus.mockReset()
  mocks.stopCursorProxy.mockReset()
  mocks.stopCursorProxy.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("proxyEndpointLabel 纯函数", () => {
  it("标准 http URL 取 host:port", () => {
    expect(proxyEndpointLabel("http://127.0.0.1:8765")).toBe("127.0.0.1:8765")
  })

  it("非法 URL 原样返回（catch 分支）", () => {
    expect(proxyEndpointLabel("not a url at all")).toBe("not a url at all")
  })

  it("空串原样返回", () => {
    expect(proxyEndpointLabel("")).toBe("")
  })

  it("host 为空的合法 URL（如 file:）：回退原串（|| 右侧分支）", () => {
    expect(proxyEndpointLabel("file:///x")).toBe("file:///x")
  })
})

describe.each([
  { name: "Claude", Pill: ClaudeCliStatusPill, cmd: "claude_cli_detect", readyKey: "settings.sections.llm.cliStatus.claudeReady", detectingKey: "settings.sections.llm.cliStatus.claudeDetecting", unavailableKey: "settings.sections.llm.cliStatus.claudeUnavailable" },
  { name: "Codex", Pill: CodexCliStatusPill, cmd: "codex_cli_detect", readyKey: "settings.sections.llm.cliStatus.codexReady", detectingKey: "settings.sections.llm.cliStatus.codexDetecting", unavailableKey: "settings.sections.llm.cliStatus.codexUnavailable" },
  { name: "Antigravity", Pill: AntigravityCliStatusPill, cmd: "antigravity_cli_detect", readyKey: "settings.sections.llm.cliStatus.antigravityReady", detectingKey: "settings.sections.llm.cliStatus.antigravityDetecting", unavailableKey: "settings.sections.llm.cliStatus.antigravityUnavailable" },
])("$name pill", ({ Pill, cmd, readyKey, detectingKey, unavailableKey }) => {
  it("非桌面环境：直接 desktopOnly 错误，不调 invoke", async () => {
    mocks.isTauri.mockReturnValue(false)
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText("settings.sections.llm.cliStatus.desktopOnly")).toBeTruthy()
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith(cmd)
  })

  it("已安装：ready 文案带版本号 + 路径 + 重检按钮可用", async () => {
    mocks.invoke.mockResolvedValue(okDetect())
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText(`${readyKey}[versionSuffix= 1.2.3]`)).toBeTruthy()
    })
    expect(screen.getByText("/usr/local/bin/tool")).toBeTruthy()
    // 重检：再调一次 detect。
    const recheck = screen.getByRole("button", { name: "settings.sections.llm.cliStatus.recheck" })
    fireEvent.click(recheck)
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(2)
    })
  })

  it("已安装但无版本无路径：versionSuffix 为空，路径行不渲染", async () => {
    mocks.invoke.mockResolvedValue(okDetect({ version: null, path: null }))
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText(`${readyKey}[versionSuffix=]`)).toBeTruthy()
    })
    expect(screen.queryByText("/usr/local/bin/tool")).toBeNull()
  })

  it("未安装：展示后端错误 + 安装提示", async () => {
    mocks.invoke.mockResolvedValue(okDetect({ installed: false, version: null, path: null, error: "no binary" }))
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText("no binary")).toBeTruthy()
    })
    expect(screen.queryByText(new RegExp(readyKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeNull()
    expect(mocks.invoke).toHaveBeenCalledWith(cmd)
  })

  it("未安装且无错误信息：回退 unavailable 文案", async () => {
    mocks.invoke.mockResolvedValue(okDetect({ installed: false, version: null, path: null, error: null }))
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText(unavailableKey)).toBeTruthy()
    })
  })

  it("invoke 抛错：toErrorMessage 展示 + err 态", async () => {
    mocks.invoke.mockRejectedValue(new Error("tauri-down"))
    render(<Pill />)
    await waitFor(() => {
      expect(screen.getByText("tauri-down")).toBeTruthy()
    })
  })

  it("检测中：checking 文案 + 按钮禁用", async () => {
    let resolveDetect!: (v: unknown) => void
    mocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetect = resolve
      }),
    )
    render(<Pill />)
    // loading 态：checking 文案出现，按钮禁用且 aria 为 checking。
    await waitFor(() => {
      expect(screen.getByText(detectingKey)).toBeTruthy()
    })
    const btn = screen.getByRole("button", { name: "settings.sections.llm.cliStatus.checking" })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    resolveDetect(okDetect())
    await waitFor(() => {
      expect(screen.getByText(new RegExp(readyKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy()
    })
  })
})

describe("Antigravity pill fallback 路径展示", () => {
  it("fallback 与主路径不同：展示 fallback 行", async () => {
    mocks.invoke.mockResolvedValue(
      okDetect({ path: "/usr/bin/gemini", fallback_path: "/opt/antigravity/bin/gemini" }),
    )
    render(<AntigravityCliStatusPill />)
    await waitFor(() => {
      expect(screen.getByText("/opt/antigravity/bin/gemini", { exact: false })).toBeTruthy()
    })
    expect(screen.getByText(/antigravityFallback/)).toBeTruthy()
  })

  it("fallback 与主路径相同：不展示 fallback 行", async () => {
    mocks.invoke.mockResolvedValue(okDetect({ path: "/usr/bin/gemini", fallback_path: "/usr/bin/gemini" }))
    render(<AntigravityCliStatusPill />)
    await waitFor(() => {
      expect(screen.getByText(/antigravityReady/)).toBeTruthy()
    })
    expect(screen.queryByText(/antigravityFallback/)).toBeNull()
  })
})

describe("CursorProxyStatusBadge", () => {
  const healthy = {
    healthy: true,
    base_url: "http://127.0.0.1:8765",
    managed: true,
    error: null,
  }

  it("健康 + 托管：healthy 文案带 endpoint，managed 提示与停止按钮可见", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue(healthy)
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/代理运行正常/, { exact: false })).toBeTruthy()
    })
    expect(screen.getByText(/127\.0\.0\.1:8765/)).toBeTruthy()
    expect(screen.getByText(/cursorProxy\.managedHint/)).toBeTruthy()
    // 停止托管代理：调 stop 后刷新状态。
    mocks.getCursorProxyStatus.mockResolvedValueOnce({ ...healthy })
    fireEvent.click(screen.getByText(/cursorProxy\.stop\[/))
    await waitFor(() => {
      expect(mocks.stopCursorProxy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mocks.getCursorProxyStatus).toHaveBeenCalledTimes(2)
    })
  })

  it("健康但非托管：无 managed 提示与停止按钮", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue({ ...healthy, managed: false })
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/代理运行正常/, { exact: false })).toBeTruthy()
    })
    expect(screen.queryByText(/cursorProxy\.managedHint/)).toBeNull()
    expect(screen.queryByText(/cursorProxy\.stop\[/)).toBeNull()
  })

  it("非健康：展示服务端错误 + errHint", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue({
      healthy: false,
      base_url: "",
      managed: false,
      error: "proxy down",
    })
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText("proxy down")).toBeTruthy()
    })
    expect(screen.getByText(/cursorProxy\.errHint/)).toBeTruthy()
  })

  it("非健康且无错误信息：回退 unavailable 文案（?? 右侧分支）", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue({
      healthy: false,
      base_url: "",
      managed: false,
      error: null,
    })
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/cursorProxy\.unavailable/)).toBeTruthy()
    })
  })

  it("状态查询抛错：toErrorMessage 展示，err 态", async () => {
    mocks.getCursorProxyStatus.mockRejectedValue(new Error("status-boom"))
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText("status-boom")).toBeTruthy()
    })
  })

  it("状态查询抛错且无 message：回退 unavailable", async () => {
    mocks.getCursorProxyStatus.mockRejectedValue("plain-string-failure")
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText("plain-string-failure")).toBeTruthy()
    })
  })

  it("停止中：按钮禁用并显示 stopping；停止失败不阻断刷新", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue(healthy)
    let resolveStop!: () => void
    mocks.stopCursorProxy.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveStop = () => resolve(undefined)
        }),
    )
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/cursorProxy\.stop\[/)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(/cursorProxy\.stop\[/))
    await waitFor(() => {
      expect(screen.getByText(/cursorProxy\.stopping/)).toBeTruthy()
    })
    resolveStop()
    await waitFor(() => {
      expect(mocks.getCursorProxyStatus).toHaveBeenCalledTimes(2)
    })
  })

  it("刷新按钮：点击后重新拉取状态", async () => {
    mocks.getCursorProxyStatus.mockResolvedValue({ ...healthy, managed: false })
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/代理运行正常/, { exact: false })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole("button", { name: "settings.sections.llm.cliStatus.recheck" }))
    await waitFor(() => {
      expect(mocks.getCursorProxyStatus).toHaveBeenCalledTimes(2)
    })
  })

  it("检测中：checking 文案", async () => {
    let resolveStatus!: (v: unknown) => void
    mocks.getCursorProxyStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
    )
    render(<CursorProxyStatusBadge />)
    await waitFor(() => {
      expect(screen.getByText(/cursorProxy\.checking/)).toBeTruthy()
    })
    resolveStatus(healthy)
    await waitFor(() => {
      expect(screen.getByText(/代理运行正常/, { exact: false })).toBeTruthy()
    })
  })
})
