// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/settings/sections/mcp-section.tsx — focuses on the
// transport-type selector added by audit ①-6 (stdio default, SSE reserved).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { McpSection } from "./mcp-section"
import type { McpConfig } from "@/lib/mcp/config"

const mocks = vi.hoisted(() => {
  const setMcpConfig = vi.fn()
  return {
    t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
    setMcpConfig,
    saveMcpConfig: vi.fn(async () => {}),
    testConnection: vi.fn(),
    closeAll: vi.fn(async () => {}),
    state: {
      mcpConfig: null as McpConfig | null,
      setMcpConfig,
    },
  }
})

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    
  }
})

vi.mock("@/lib/project-store", () => ({
  saveMcpConfig: mocks.saveMcpConfig,
}))

vi.mock("@/lib/mcp/real-connector", () => ({
  RealMcpConnector: class {
    testConnection = mocks.testConnection
    closeAll = mocks.closeAll
  },
}))

const SERVER = {
  id: "graph",
  name: "Graph",
  enabled: true,
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  tools: [
    {
      serverId: "graph",
      serverName: "Graph",
      name: "query_graph",
      description: "Query the graph",
      operation: "read" as const,
      inputSchema: { type: "object" as const },
    },
  ],
}

beforeEach(() => {
  mocks.t.mockClear()
  mocks.setMcpConfig.mockClear()
  mocks.saveMcpConfig.mockClear()
  mocks.testConnection.mockClear()
  mocks.closeAll.mockClear()
  mocks.state.mcpConfig = { servers: [{ ...SERVER }] }
})

afterEach(() => {
  cleanup()
})

describe("McpSection — transport type selector (audit ①-6)", () => {
  it("renders a transport select defaulting to stdio with SSE reserved (disabled)", () => {
    render(<McpSection />)
    // 服务卡内的传输选择器在 DOM 中先于远程传输面板（后者挂在区块末尾）；
    // 用 getAllByRole 取第一个，避免与远程面板的 select 多匹配。
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    expect(select).toBeInTheDocument()
    expect(select.value).toBe("stdio")
    const sseOption = Array.from(select.options).find((o) => o.value === "sse")
    expect(sseOption).toBeDefined()
    expect(sseOption!.disabled).toBe(true)
  })

  it("transport hint is shown below the selector", () => {
    render(<McpSection />)
    expect(screen.getByText("settings.sections.mcp.transportHint")).toBeInTheDocument()
  })

  it("persists the config when the transport is changed to stdio", async () => {
    render(<McpSection />)
    // 服务卡内的传输选择器 = 页面上第一个 combobox；远程面板的 select 在其后。
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(select, { target: { value: "stdio" } })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    expect(mocks.saveMcpConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: expect.arrayContaining([expect.objectContaining({ transport: "stdio" })]),
      }),
    )
  })
})

describe("远程传输接线（F-005）", () => {
  it("MCP 设置区块内挂载远程传输面板", () => {
    render(<McpSection />)
    expect(screen.getByTestId("mcp-remote-transport-section")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-transport-settings")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-transport-mode")).toBeInTheDocument()
  })

  it("四个动作按钮各有真实文案（回归：曾全部复用 mcp.transport.mode 占位）", () => {
    render(<McpSection />)
    const labels = ["save", "connect", "request", "close"].map((name) =>
      screen.getByTestId(`mcp-transport-${name}`).textContent?.trim() ?? "",
    )
    // 每次调用都必须命中自己的键（t 被 mock 成恒等函数，故断言键名本身）
    expect(labels).toEqual([
      "mcp.transport.save",
      "mcp.transport.connect",
      "mcp.transport.request",
      "mcp.transport.close",
    ])
    expect(new Set(labels).size).toBe(4)
    expect(labels).not.toContain("mcp.transport.mode")
  })
})
