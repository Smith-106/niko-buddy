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
import { render, screen, fireEvent, waitFor } from "@/test-helpers/component-test-utils"
import { ExternalControlSection } from "./external-control-section"

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
