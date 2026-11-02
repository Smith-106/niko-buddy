// @vitest-environment jsdom
/**
 * external-control-section.tsx 覆盖 spec。
 *
 * 三条必须钉死的行为：
 * 1. 开关关闭必须真的调 `mcp_server_stop`（不是只改前端状态）
 * 2. token 默认掩码，点「显示」才展开；停服后不再展示旧 token
 * 3. 无会话时给空态文案，不是空白
 * 4. 写权限默认关闭，打开时必须带 `scope: "settings"` 重启（不能只改界面）
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

  it("打开写权限时带 settings scope 重启", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "mcp_server_start") return Promise.resolve(45871)
      return Promise.resolve(RUNNING_STATUS)
    })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-write-scope")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("external-control-write-scope"))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("mcp_server_start", { scope: "settings" })
    })
  })

  it("服务端已授予 settings 时开关显示为开", async () => {
    invokeMock.mockResolvedValue({ ...RUNNING_STATUS, scope: "settings" })
    render(<ExternalControlSection />)
    await waitFor(() => {
      expect(screen.getByTestId("external-control-write-scope")).toHaveAttribute(
        "aria-checked",
        "true",
      )
    })
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
})
