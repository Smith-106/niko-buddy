// @vitest-environment jsdom
/**
 * external-control-section.tsx 覆盖 spec。
 *
 * 三条必须钉死的行为：
 * 1. 开关关闭必须真的调 `mcp_server_stop`（不是只改前端状态）
 * 2. token 默认掩码，点「显示」才展开；停服后不再展示旧 token
 * 3. 无会话时给空态文案，不是空白
 * 4. 写权限默认关闭，打开时必须带 `scope: "settings"` 重启（不能只改界面）
 * 5. `full` 不能在启动时授予；逐会话授权/吊销必须真的调后端命令（P3）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, render, screen, fireEvent, waitFor } from "@/test-helpers/component-test-utils"
import { ExternalControlSection } from "./external-control-section"
import { useWikiStore } from "@/stores/wiki-store"
import zhLocale from "@/i18n/zh.json"
import enLocale from "@/i18n/en.json"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

const RUNNING_STATUS = {
  running: true,
  port: 45871,
  tool_count: 5,
  tools: ["app.ping", "app.status", "settings.schema", "settings.list", "settings.get"],
  sessions: [],
  endpoint: "http://127.0.0.1:45871/mcp",
  scope: "read",
}

const STOPPED_STATUS = {
  ...RUNNING_STATUS,
  running: false,
  port: null,
  endpoint: "http://127.0.0.1:45871/mcp",
}

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("ExternalControlSection", () => {
  it("展示连接地址与工具数量", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent(
        "http://127.0.0.1:45871/mcp",
      )
    })
    expect(screen.getByTestId("external-control-tool-count")).toHaveTextContent("5")
  })

  it("写权限开关默认关闭，且启动时带 read scope", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_start") return Promise.resolve(45871)
      return Promise.resolve(STOPPED_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-toggle")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-toggle"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "read" })
    })
  })

  it("选择 settings 权限域时带 scope 重启", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_start") return Promise.resolve(45871)
      return Promise.resolve(RUNNING_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-settings")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-scope-settings"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "settings" })
    })
  })

  it("选择 project 权限域时带 scope 重启", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_start") return Promise.resolve(45871)
      return Promise.resolve(RUNNING_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-project")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-scope-project"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
    })
  })

  it("服务端已授予 project 时对应项显示为选中，且不重复重启", async () => {
    invokeMock.mockResolvedValue({ ...RUNNING_STATUS, scope: "project" })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-project")).toHaveAttribute(
        "aria-pressed",
        "true",
      )
    })
    // 点已选中项不应再发启动请求
    fireEvent.click(screen.getByTestId("external-control-scope-project"))
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
  })

  it("无会话时展示空态", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-sessions-empty")).toBeInTheDocument()
    })
  })

  it("关闭开关必须调用 mcp_server_stop", async () => {
    invokeMock.mockResolvedValueOnce(RUNNING_STATUS) // 初始 status
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent("45871")
    })
    invokeMock.mockResolvedValueOnce(undefined) // mcp_server_stop
    invokeMock.mockResolvedValueOnce(STOPPED_STATUS) // 重新读状态

    fireEvent.click(screen.getByTestId("external-control-toggle"))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_stop")
    })
  })

  it("token 默认掩码，点显示后展开", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-token")).toHaveTextContent("••••")
    })

    invokeMock.mockResolvedValueOnce("a".repeat(64))
    fireEvent.click(screen.getByTestId("external-control-reveal"))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_token")
      expect(screen.getByTestId("external-control-token")).toHaveTextContent("a".repeat(64))
    })
  })

  it("重新生成 token 调用 rotate 并展示新值", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent("45871")
    })

    invokeMock.mockResolvedValueOnce("b".repeat(64)) // rotate
    invokeMock.mockResolvedValueOnce(RUNNING_STATUS) // refresh
    fireEvent.click(screen.getByTestId("external-control-rotate"))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_rotate_token")
      expect(screen.getByTestId("external-control-token")).toHaveTextContent("b".repeat(64))
    })
  })

  it("status 读取失败时把错误显示出来，而不是静默空白", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("boom")
    })
  })

  it("启动档位里没有 full，并明确说明 full 要逐会话授权", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-full-note")).toBeInTheDocument()
    })
    // 三档按钮仍只有 read / settings / project —— full 不是可选的启动档。
    expect(screen.getByTestId("external-control-scope-read")).toBeInTheDocument()
    expect(screen.getByTestId("external-control-scope-settings")).toBeInTheDocument()
    expect(screen.getByTestId("external-control-scope-project")).toBeInTheDocument()
    expect(screen.queryByTestId("external-control-scope-full")).toBeNull()
  })

  it("逐会话授予完整写入：调 grant 命令并刷新，不重启服务", async () => {
    const withSession = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "11112222-3333-4444-5555-666677778888",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 3,
          full_granted: false,
          auto_granted: false,
        },
      ],
    }
    invokeMock.mockResolvedValueOnce(withSession) // 首次 status
    invokeMock.mockResolvedValueOnce(undefined) // grant
    invokeMock.mockResolvedValueOnce(withSession) // refresh
    render(<ExternalControlSection />)

    const toggle = await screen.findByTestId("external-control-session-full-toggle")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_session_grant_full", {
        sessionId: "11112222-3333-4444-5555-666677778888",
      })
    })
    // 授权是会话级动作，不得因此重启监听（重启会踢掉正在工作的客户端）。
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_start", expect.anything())
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_stop")
  })

  it("已授权的会话显示徽标，按钮改为吊销并调 revoke 命令", async () => {
    const granted = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 1,
          full_granted: true,
          auto_granted: false,
        },
      ],
    }
    invokeMock.mockResolvedValueOnce(granted)
    invokeMock.mockResolvedValueOnce(undefined)
    invokeMock.mockResolvedValueOnce(granted)
    render(<ExternalControlSection />)

    await screen.findByTestId("external-control-session-full-badge")
    const toggle = screen.getByTestId("external-control-session-full-toggle")
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_session_revoke_full", {
        sessionId: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
      })
    })
  })

  it("授权失败时把错误显示出来，不静默", async () => {
    const withSession = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "dead0000-0000-0000-0000-000000000000",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 0,
          full_granted: false,
          auto_granted: false,
        },
      ],
    }
    invokeMock.mockResolvedValueOnce(withSession)
    invokeMock.mockRejectedValueOnce(new Error("没有这个会话"))
    render(<ExternalControlSection />)

    fireEvent.click(await screen.findByTestId("external-control-session-full-toggle"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("没有这个会话")
    })
  })
})

describe("ExternalControlSection 错误与边界路径（覆盖战役补齐）", () => {
  const STOPPED = { ...STOPPED_STATUS }

  beforeEach(() => {
    invokeMock.mockReset()
  })

  afterEach(() => {
    cleanup()
    // 恢复可能被测试覆盖的 navigator.clipboard 自有属性。
    try {
      delete (navigator as unknown as Record<string, unknown>).clipboard
    } catch {
      /* 忽略：环境本就没有该属性 */
    }
  })

  function stubClipboard(reject?: Error) {
    const writeText = reject ? vi.fn().mockRejectedValue(reject) : vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    return writeText
  }

  it("运行中但 scope 缺失：回退 read（?? 防御分支），不崩", async () => {
    const { scope: _omit, ...noScope } = RUNNING_STATUS
    invokeMock.mockResolvedValue(noScope)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent("45871")
    })
    expect(screen.getByTestId("external-control-scope-read")).toHaveAttribute("aria-pressed", "true")
  })

  it("启动失败：保留启动报错并重读真实状态（开关不卡在用户意图上）", async () => {
    let statusCalls = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") {
        statusCalls += 1
        return Promise.resolve(STOPPED)
      }
      if (cmd === "mcp_server_start") return Promise.reject(new Error("port busy"))
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-toggle")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-toggle"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "read" })
    })
    await waitFor(() => {
      expect(statusCalls).toBeGreaterThanOrEqual(2)
    })
    // 开关回到真实关态（aria 未选中），且 refresh({ preserveError: true }) 保留本次报错。
    expect(screen.getByTestId("external-control-toggle")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("external-control-error")).toHaveTextContent("port busy")
  })

  it("启动失败且状态重读也失败：显示重读错误", async () => {
    let statusCalls = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") {
        statusCalls += 1
        return statusCalls === 1 ? Promise.resolve(STOPPED) : Promise.reject(new Error("status down"))
      }
      if (cmd === "mcp_server_start") return Promise.reject(new Error("port busy"))
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-toggle")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-toggle"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("status down")
    })
  })

  it("停止态切换权限域：只记意图不重启；再启动时带新 scope", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") return Promise.resolve(STOPPED)
      if (cmd === "mcp_server_start") return Promise.resolve(45871)
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-settings")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-scope-settings"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-settings")).toHaveAttribute("aria-pressed", "true")
    })
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_start", expect.anything())
    // 再打开开关：带上刚记住的 settings 意图。
    fireEvent.click(screen.getByTestId("external-control-toggle"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "settings" })
    })
  })

  it("运行中切换权限域失败且重读失败：显示重读错误", async () => {
    let statusCalls = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") {
        statusCalls += 1
        return statusCalls === 1 ? Promise.resolve(RUNNING_STATUS) : Promise.reject(new Error("status down"))
      }
      if (cmd === "mcp_server_start") return Promise.reject(new Error("restart failed"))
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-project")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-scope-project"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
    })
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("status down")
    })
  })

  it("已取到 token 后再点显示：只切换掩码，不再调后端", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-reveal")).toBeInTheDocument()
    })
    invokeMock.mockResolvedValueOnce("t".repeat(64))
    fireEvent.click(screen.getByTestId("external-control-reveal"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-token")).toHaveTextContent("t".repeat(64))
    })
    expect(invokeMock).toHaveBeenCalledWith("mcp_server_token")
    const callsBefore = invokeMock.mock.calls.filter((c) => c[0] === "mcp_server_token").length
    // 再点：隐藏（token 还在，只是不展示）。
    fireEvent.click(screen.getByTestId("external-control-reveal"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-token")).not.toHaveTextContent("t".repeat(64))
    })
    // 第三次：重新展示，仍不调后端（token 缓存）。
    fireEvent.click(screen.getByTestId("external-control-reveal"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-token")).toHaveTextContent("t".repeat(64))
    })
    expect(invokeMock.mock.calls.filter((c) => c[0] === "mcp_server_token").length).toBe(callsBefore)
  })

  it("取 token 失败：显示错误", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_token") return Promise.reject(new Error("vault locked"))
      return Promise.resolve(RUNNING_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-reveal")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-reveal"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("vault locked")
    })
  })

  it("轮换 token 失败：显示错误（finally 照常解 busy）", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_rotate_token") return Promise.reject(new Error("rotate down"))
      return Promise.resolve(RUNNING_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-rotate")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-rotate"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("rotate down")
    })
    // busy 已解：按钮恢复可用。
    expect((screen.getByTestId("external-control-rotate") as HTMLButtonElement).disabled).toBe(false)
    const statusReads = invokeMock.mock.calls.filter(([cmd]) => cmd === "mcp_server_status")
    expect(statusReads.length).toBeGreaterThanOrEqual(2)
  })

  it("复制连接地址成功：已复制提示 1.5s 后回到复制", async () => {
    const writeText = stubClipboard()
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-copy")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-copy"))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:45871/mcp")
    })
    // 本文件不 mock i18n，走真实中文文案。
    await waitFor(() => {
      expect(screen.getByTestId("external-control-copy")).toHaveTextContent("已复制")
    })
    await waitFor(
      () => {
        expect(screen.getByTestId("external-control-copy")).toHaveTextContent("复制")
        expect(screen.getByTestId("external-control-copy")).not.toHaveTextContent("已复制")
      },
      { timeout: 4000 },
    )
  })

  it("复制失败（剪贴板拒绝）：显示错误", async () => {
    stubClipboard(new Error("clipboard denied"))
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-copy")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-copy"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-error")).toHaveTextContent("clipboard denied")
    })
  })

  it("status 恒为 null 时复制按钮禁用：守卫分支不触发写剪贴板", async () => {
    // refresh 永不 resolve → status 恒 null → 复制按钮 disabled。
    invokeMock.mockReturnValue(new Promise(() => {}))
    const writeText = stubClipboard()
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-copy")).toBeInTheDocument()
    })
    expect((screen.getByTestId("external-control-copy") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("external-control-copy"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByTestId("external-control-error")).toBeNull()
  })

  it("逐会话授予自动编排：调 grant_auto 并刷新，不重启监听", async () => {
    const withSession = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "99990000-1111-2222-3333-444455556666",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 5,
          full_granted: false,
          auto_granted: false,
        },
      ],
    }
    invokeMock.mockResolvedValueOnce(withSession) // 首次 status
    invokeMock.mockResolvedValueOnce(undefined) // grant_auto
    invokeMock.mockResolvedValueOnce(withSession) // refresh
    render(<ExternalControlSection />)

    const toggle = await screen.findByTestId("external-control-session-auto-toggle")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_session_grant_auto", {
        sessionId: "99990000-1111-2222-3333-444455556666",
      })
    })
    // auto 与 full 一样是会话级授权：不得因此重启监听。
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_start", expect.anything())
    expect(invokeMock).not.toHaveBeenCalledWith("mcp_server_stop")
  })

  it("已授权的自动编排显示徽标，按钮改为吊销并调 revoke_auto", async () => {
    const granted = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "77778888-9999-aaaa-bbbb-ccccddddeeee",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 1,
          full_granted: false,
          auto_granted: true,
        },
      ],
    }
    invokeMock.mockResolvedValueOnce(granted)
    invokeMock.mockResolvedValueOnce(undefined)
    invokeMock.mockResolvedValueOnce(granted)
    render(<ExternalControlSection />)

    await screen.findByTestId("external-control-session-auto-badge")
    const toggle = screen.getByTestId("external-control-session-auto-toggle")
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_session_revoke_auto", {
        sessionId: "77778888-9999-aaaa-bbbb-ccccddddeeee",
      })
    })
  })

  it("U4-08：运行中切换权限域失败但重读状态成功时，保留重启报错并还原真实 scope", async () => {
    let statusCalls = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") {
        statusCalls += 1
        return Promise.resolve(RUNNING_STATUS)
      }
      if (cmd === "mcp_server_start") return Promise.reject(new Error("restart failed"))
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-scope-project")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-scope-project"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "project" })
    })
    await waitFor(() => {
      expect(statusCalls).toBeGreaterThanOrEqual(2)
    })
    expect(screen.getByTestId("external-control-error")).toHaveTextContent("restart failed")
    expect(screen.getByTestId("external-control-scope-read")).toHaveAttribute("aria-pressed", "true")
  })

  it("U4-08：初始 status 挂起期间卸载组件，迟到 resolve/reject 不报错", async () => {
    let resolveStatus!: (value: typeof RUNNING_STATUS) => void
    let rejectStatus!: (error: Error) => void
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    invokeMock.mockReturnValueOnce(new Promise<typeof RUNNING_STATUS>((res) => { resolveStatus = res }))
    const first = render(<ExternalControlSection />)
    first.unmount()
    resolveStatus(RUNNING_STATUS)
    await new Promise((r) => setTimeout(r, 20))

    invokeMock.mockReturnValueOnce(new Promise<typeof RUNNING_STATUS>((_res, rej) => { rejectStatus = rej }))
    const second = render(<ExternalControlSection />)
    second.unmount()
    rejectStatus(new Error("late failure"))
    await new Promise((r) => setTimeout(r, 20))

    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("U4-08：复制后连续点击重置计时器，且卸载时清理未触发的 copied timer", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout")
    const writeText = stubClipboard()
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    const view = render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-copy")).not.toBeDisabled()
    })
    fireEvent.click(screen.getByTestId("external-control-copy"))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("external-control-copy")).toHaveTextContent("已复制")
    })
    const clearCallsAfterFirst = clearSpy.mock.calls.length
    // 再次点击应清理前一次 timer
    fireEvent.click(screen.getByTestId("external-control-copy"))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(clearSpy.mock.calls.length).toBeGreaterThan(clearCallsAfterFirst)
    })
    const clearCallsBeforeUnmount = clearSpy.mock.calls.length
    view.unmount()
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeUnmount)
    clearSpy.mockRestore()
  })

  it("U-3v2：工具数展示「可用工具」且描述准确反映权限域与会话授权（不含过时只读措辞）", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent("45871")
    })
    const toolCount = screen.getByTestId("external-control-tool-count")
    expect(toolCount).toHaveTextContent("5 个可用工具")
    expect(toolCount.textContent).toContain("可用工具")
    expect(toolCount.textContent).not.toContain("只读工具")

    const description = screen.getByRole("heading", { level: 2 }).nextElementSibling
    expect(description).not.toBeNull()
    expect(description?.textContent).toContain("默认只读，可按下方权限域与会话授权放开写操作")
    expect(description?.textContent).not.toContain("当前阶段为只读")
  })

  it("U-3v2：toggle 失败时保留带 role=\"alert\" 的错误横幅不被 refresh() 清空", async () => {
    let statusCalls = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_status") {
        statusCalls += 1
        return Promise.resolve(STOPPED)
      }
      if (cmd === "mcp_server_start") return Promise.reject(new Error("bind failed"))
      return Promise.resolve(undefined)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-toggle")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-toggle"))
    await waitFor(() => {
      expect(statusCalls).toBeGreaterThanOrEqual(2)
      expect(screen.getByTestId("external-control-toggle")).not.toBeDisabled()
    })
    const alert = screen.getByRole("alert")
    expect(alert).toBe(screen.getByTestId("external-control-error"))
    expect(alert).toHaveTextContent("bind failed")
    expect(screen.getByTestId("external-control-toggle")).toHaveAttribute("aria-checked", "false")
  })

  it("Antigravity 官方 MCP 卡片展示标准 Streamable HTTP mcp_config.json 且支持一键复制", async () => {
    const writeText = stubClipboard()
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    render(<ExternalControlSection />)

    const card = await screen.findByTestId("external-control-antigravity-card")
    expect(card).toBeInTheDocument()
    const snippetEl = screen.getByTestId("external-control-antigravity-snippet")
    const parsed = JSON.parse(snippetEl.textContent ?? "{}") as {
      mcpServers?: {
        "niko-buddy"?: {
          serverUrl?: string
          headers?: { Authorization?: string }
          timeoutSeconds?: number
        }
      }
    }
    expect(parsed.mcpServers?.["niko-buddy"]?.serverUrl).toBe("http://127.0.0.1:45871/mcp")
    expect(parsed.mcpServers?.["niko-buddy"]?.headers?.Authorization).toBe("Bearer <YOUR_BEARER_TOKEN>")
    expect(parsed.mcpServers?.["niko-buddy"]?.timeoutSeconds).toBe(600)

    // 显露 token 后，片段应自动带入真实 Bearer token
    invokeMock.mockResolvedValueOnce("tok-antigravity-1234")
    fireEvent.click(screen.getByTestId("external-control-reveal"))
    await waitFor(() => {
      expect(screen.getByTestId("external-control-antigravity-snippet")).toHaveTextContent(
        "Bearer tok-antigravity-1234",
      )
    })

    fireEvent.click(screen.getByTestId("external-control-copy-antigravity-mcp"))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"serverUrl": "http://127.0.0.1:45871/mcp"'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Bearer tok-antigravity-1234"))
    })
    expect(screen.queryByTestId("external-control-antigravity-copy-warning")).toBeNull()
  })

  it("会话行展示 client_name/client_version 徽标，且支持手动刷新按钮重读状态", async () => {
    const withClient = {
      ...RUNNING_STATUS,
      sessions: [
        {
          id: "abc12345-0000-1111-2222-333344445555",
          scope: "project",
          connected_at: 1,
          last_call_at: 2,
          calls: 4,
          full_granted: false,
          auto_granted: false,
          client_name: "antigravity-ide",
          client_version: "1.6.0",
        },
      ],
    }
    invokeMock.mockResolvedValue(withClient)
    render(<ExternalControlSection />)

    const badge = await screen.findByTestId("external-control-session-client")
    expect(badge).toHaveTextContent("antigravity-ide v1.6.0")

    const beforeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "mcp_server_status").length
    fireEvent.click(screen.getByTestId("external-control-refresh"))
    await waitFor(() => {
      const afterCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "mcp_server_status").length
      expect(afterCalls).toBeGreaterThan(beforeCalls)
    })
  })

  it("停服或隐藏 token 时复制 mcp_config.json 仍执行复制，并用 role=\"status\" 给出警告（不污染 role=\"alert\"）", async () => {
    const writeText = stubClipboard()
    invokeMock.mockResolvedValue(STOPPED)
    render(<ExternalControlSection />)

    const stoppedHint = await screen.findByTestId("external-control-antigravity-stopped-hint")
    expect(stoppedHint).toHaveAttribute("role", "status")
    expect(screen.queryByRole("alert")).toBeNull()

    fireEvent.click(screen.getByTestId("external-control-copy-antigravity-mcp"))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("<YOUR_BEARER_TOKEN>"))
    })
    const copyWarn = await screen.findByTestId("external-control-antigravity-copy-warning")
    expect(copyWarn).toHaveAttribute("role", "status")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("zh/en 词条中 scopeProjectHint 不得误提 memory.write（与后端 project 权限域一致）", () => {
    expect(zhLocale.settings.sections.externalControl.scopeProjectHint).not.toContain("memory.write")
    expect(enLocale.settings.sections.externalControl.scopeProjectHint).not.toContain("memory.write")
  })

  it("未打开小说项目时禁用「打开 Antigravity ACP 面板」并给出提示，打开项目后可跳转", async () => {
    invokeMock.mockResolvedValue(RUNNING_STATUS)
    useWikiStore.setState({ project: null, activeView: "settings" })
    try {
      const { rerender } = render(<ExternalControlSection />)
      await waitFor(() => {
        expect(screen.getByTestId("external-control-endpoint")).toHaveTextContent("45871")
      })
      const openBtn = screen.getByTestId("external-control-open-acp")
      expect(openBtn).toBeDisabled()
      expect(screen.getByTestId("external-control-open-acp-project-hint")).toBeInTheDocument()
      fireEvent.click(openBtn)
      expect(useWikiStore.getState().activeView).toBe("settings")

      act(() => {
        useWikiStore.setState({
          project: { id: "p-acp", name: "ACP Novel", path: "C:\\books\\acp-novel" },
        })
      })
      rerender(<ExternalControlSection />)
      expect(screen.getByTestId("external-control-open-acp")).not.toBeDisabled()
      expect(screen.queryByTestId("external-control-open-acp-project-hint")).toBeNull()
      fireEvent.click(screen.getByTestId("external-control-open-acp"))
      expect(useWikiStore.getState().activeView).toBe("antigravityAcp")
    } finally {
      act(() => {
        useWikiStore.setState({ project: null, activeView: "wiki" })
      })
    }
  })
})
