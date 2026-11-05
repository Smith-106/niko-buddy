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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

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

/**
 * 取出组件绑定的处理器并直接调用。
 *
 * 仅用于「UI 上不可达的防御性早退」：开关进入保存中/无配置时会被 disabled，
 * 浏览器与 React 都不会派发事件，但重入守卫本身是生产行为（防并发写盘），
 * 必须被验证——所以直接调用处理器，而不是绕过按钮状态改 DOM。
 */
function invokeBoundHandler(
  node: HTMLElement,
  handler: "onClick" | "onChange",
  event?: unknown,
): void {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"))
  if (!key) throw new Error("react props handle missing")
  const props = (node as unknown as Record<string, Record<string, ((arg?: unknown) => void) | undefined>>)[key]
  const fn = props?.[handler]
  if (typeof fn !== "function") throw new Error(`handler ${handler} missing`)
  act(() => {
    fn(event)
  })
}

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

describe("McpManagerView 分支补齐：失败文案/空列表/重入守卫/过期装载", () => {
  const STALE_CONFIG: McpConfig = {
    servers: [
      { id: "stale", name: "旧项目的服务", enabled: true, transport: "stdio", tools: [] },
    ],
  }

  it("store 返回空服务列表（fromStore=true）→ 空态不再提示回退默认", async () => {
    loadMcpConfigMock.mockResolvedValue({ servers: [] })
    render(<McpManagerView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("mcp-empty")).toBeTruthy())
    const text = screen.getByTestId("mcp-empty").textContent ?? ""
    expect(text).toContain("暂无 MCP 服务")
    // fromStore=true：不得谎称「全局配置缺失」
    expect(text).not.toContain("已回退默认空配置")
  })

  it("store 抛出非 Error（字符串）→ 通用失败文案（不显示 undefined）", async () => {
    loadMcpConfigMock.mockRejectedValue("plain failure")
    render(<McpManagerView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("mcp-error")).toBeTruthy())
    const text = screen.getByTestId("mcp-error").textContent ?? ""
    expect(text).toContain("读取失败")
    expect(text).toContain("MCP 配置加载失败")
    expect(text).not.toContain("undefined")
  })

  it("落盘失败不回滚内存开关；Error 带消息用消息、非 Error 用通用文案", async () => {
    const view = (): string => screen.getByTestId("mcp-manager-view").textContent ?? ""
    saveMcpConfigMock.mockRejectedValueOnce(new Error("disk full"))
    render(<McpManagerView projectPath="C:/proj" config={DEMO_CONFIG} />)
    fireEvent.click(screen.getByLabelText("启用 MCP 服务「已停用服务」"))
    await waitFor(() => expect(screen.getByTestId("mcp-save-error").textContent).toContain("disk full"))
    // 落盘失败 → 内存态保持原值（开关仍显示「已停用」）
    expect(screen.getByTestId("mcp-server-status-s2").textContent).toContain("已停用")
    expect(screen.getByLabelText("启用 MCP 服务「已停用服务」")).toBeTruthy()

    // 非 Error 抛出（string / undefined message）→ 通用文案，不渲染 undefined
    saveMcpConfigMock.mockRejectedValueOnce("plain failure")
    fireEvent.click(screen.getByLabelText("启用 MCP 服务「已停用服务」"))
    await waitFor(() => expect(screen.getByTestId("mcp-save-error").textContent).toContain("MCP 配置保存失败"))
    expect(view()).not.toContain("undefined")
    expect(screen.getByTestId("mcp-server-status-s2").textContent).toContain("已停用")
  })

  it("保存中再触发另一个开关：重入守卫拦下，只落盘一次", async () => {
    let release: (() => void) | undefined
    saveMcpConfigMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = () => resolve()
      }),
    )
    render(<McpManagerView projectPath="C:/proj" config={DEMO_CONFIG} />)
    fireEvent.click(screen.getByLabelText("启用 MCP 服务「已停用服务」"))
    await waitFor(() => expect(screen.getByText("保存中…")).toBeTruthy())
    // 保存中：所有开关 disabled，浏览器不会派发事件；直接调用处理器验证守卫。
    const otherSwitch = screen.getByLabelText("停用 MCP 服务「演示服务」") as HTMLElement
    expect(otherSwitch.hasAttribute("disabled")).toBe(true)
    invokeBoundHandler(otherSwitch, "onChange", { target: { checked: false } })
    await Promise.resolve()
    expect(saveMcpConfigMock).toHaveBeenCalledTimes(1)
    release?.()
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull())
    expect(saveMcpConfigMock).toHaveBeenCalledTimes(1)
  })

  it("切项目后旧项目的装载结果迟到 → 丢弃，不覆盖新项目", async () => {
    let releaseStale: ((value: McpConfig) => void) | undefined
    loadMcpConfigMock
      .mockImplementationOnce(
        () => new Promise<McpConfig | null>((resolve) => {
          releaseStale = (value) => resolve(value)
        }),
      )
      .mockResolvedValueOnce(DEMO_CONFIG)
    const { rerender } = render(<McpManagerView projectPath="C:/a" />)
    rerender(<McpManagerView projectPath="C:/b" />)
    await waitFor(() => expect(screen.getByTestId("mcp-server-s1")).toBeTruthy())
    await act(async () => {
      releaseStale?.(STALE_CONFIG)
    })
    expect(screen.queryByTestId("mcp-server-stale")).toBeNull()
    expect(screen.getByTestId("mcp-server-s1")).toBeTruthy()
  })

  it("切项目后旧项目的装载失败迟到 → 不冒充新项目的错误", async () => {
    let rejectStale: ((reason: unknown) => void) | undefined
    loadMcpConfigMock
      .mockImplementationOnce(
        () => new Promise<McpConfig | null>((_resolve, reject) => {
          rejectStale = (reason) => reject(reason)
        }),
      )
      .mockResolvedValueOnce(DEMO_CONFIG)
    const { rerender } = render(<McpManagerView projectPath="C:/a" />)
    rerender(<McpManagerView projectPath="C:/b" />)
    await waitFor(() => expect(screen.getByTestId("mcp-server-s1")).toBeTruthy())
    await act(async () => {
      rejectStale?.(new Error("stale load failed"))
    })
    expect(screen.queryByTestId("mcp-error")).toBeNull()
    expect(screen.getByTestId("mcp-server-s1")).toBeTruthy()
    expect(screen.getByTestId("mcp-manager-view").textContent).not.toContain("stale load failed")
  })
})
