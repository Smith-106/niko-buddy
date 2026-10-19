// @vitest-environment jsdom
/**
 * mcp-manager-view.spec.tsx — MCP 服务管理视图契约。
 *
 * 覆盖：
 *   1. 空 projectPath → 空态，不碰全局 store；
 *   2. store 有服务 → 列表渲染（名称/开关态/工具数）；
 *   3. store 缺失（null）→ 诚实「暂无 MCP 服务」；
 *   4. store 读取抛错 → 诚实失败文案；
 *   5. 显式注入配置 → 跳过 store 装载；用户显式启停 → 调真实 `saveMcpConfig`。
 *
 * 真实边界是 `@/lib/project-store`（Tauri store），此处 mock 该模块；
 * `@/commands/fs` 按统一要求同步 mock（本视图不走 fs）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

vi.mock("@/lib/project-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-store")>()
  return { ...actual, loadMcpConfig: vi.fn(), saveMcpConfig: vi.fn() }
})

import { loadMcpConfig, saveMcpConfig } from "@/lib/project-store"
import { McpManagerView, loadMcpManagerSnapshot, toggleMcpServerEnabled } from "./mcp-manager-view"
import { DEFAULT_MCP_CONFIG, type McpConfig } from "@/lib/mcp/config"

const loadMcpConfigMock = vi.mocked(loadMcpConfig)
const saveMcpConfigMock = vi.mocked(saveMcpConfig)

const DEMO_CONFIG: McpConfig = {
  servers: [
    { id: "s1", name: "演示服务", enabled: true, transport: "stdio", command: "node", args: [], tools: [] },
    { id: "s2", name: "已停用服务", enabled: false, transport: "stdio", tools: [] },
  ],
}

afterEach(cleanup)

beforeEach(() => {
  loadMcpConfigMock.mockReset()
  saveMcpConfigMock.mockReset()
})

describe("McpManagerView", () => {
  it("空 projectPath → 空态，不碰全局 store", () => {
    render(<McpManagerView projectPath="" />)
    expect(screen.getByTestId("mcp-manager-view")).toBeTruthy()
    expect(screen.getByTestId("mcp-empty").textContent).toContain("未指定项目路径")
    expect(loadMcpConfigMock).not.toHaveBeenCalled()
  })

  it("store 有服务 → 列表渲染开关态与工具数", async () => {
    loadMcpConfigMock.mockResolvedValue(DEMO_CONFIG)
    render(<McpManagerView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("mcp-server-s1")).toBeTruthy())
    expect(screen.getByTestId("mcp-server-s2")).toBeTruthy()
    expect(screen.getByTestId("mcp-server-status-s1").textContent).toContain("已启用")
    expect(screen.getByTestId("mcp-server-status-s2").textContent).toContain("已停用")
    expect(screen.getByTestId("mcp-server-s1").textContent).toContain("工具：0 个")
    expect(screen.queryByTestId("mcp-empty")).toBeNull()
  })

  it("store 缺失 → 诚实「暂无 MCP 服务」", async () => {
    loadMcpConfigMock.mockResolvedValue(null)
    render(<McpManagerView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("mcp-empty")).toBeTruthy())
    expect(screen.getByTestId("mcp-empty").textContent).toContain("暂无 MCP 服务")
  })

  it("store 读取抛错 → 诚实失败文案", async () => {
    loadMcpConfigMock.mockRejectedValue(new Error("store locked"))
    render(<McpManagerView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("mcp-error")).toBeTruthy())
    expect(screen.getByTestId("mcp-error").textContent).toContain("读取失败")
  })

  it("显式注入配置 → 跳过 store 装载；启停调真实 saveMcpConfig", async () => {
    saveMcpConfigMock.mockResolvedValue(undefined)
    render(<McpManagerView projectPath="C:/proj" config={DEMO_CONFIG} />)
    expect(screen.getByTestId("mcp-server-s2")).toBeTruthy()
    expect(loadMcpConfigMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText("启用 MCP 服务「已停用服务」"))
    await waitFor(() => expect(saveMcpConfigMock).toHaveBeenCalledTimes(1))
    const persisted = saveMcpConfigMock.mock.calls[0]?.[0]
    expect(persisted?.servers.find((server) => server.id === "s2")?.enabled).toBe(true)
    // 落盘成功后内存态跟进，开关态翻转。
    await waitFor(() => expect(screen.getByTestId("mcp-server-status-s2").textContent).toContain("已启用"))
  })

  it("纯函数：toggle/load 快照语义", async () => {
    const next = toggleMcpServerEnabled(DEMO_CONFIG, "s1", false)
    expect(next.servers.find((server) => server.id === "s1")?.enabled).toBe(false)
    expect(next.servers.find((server) => server.id === "s2")?.enabled).toBe(false)
    // 原配置不受影响（不可变更新）。
    expect(DEMO_CONFIG.servers[0]?.enabled).toBe(true)
    loadMcpConfigMock.mockResolvedValue(null)
    await expect(loadMcpManagerSnapshot()).resolves.toEqual({ config: DEFAULT_MCP_CONFIG, fromStore: false })
  })
})
