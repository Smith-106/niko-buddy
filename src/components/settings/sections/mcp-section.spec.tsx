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
    runtimeWarnings: null as string[] | null,
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

vi.mock("@/lib/mcp/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/runtime")>()
  return {
    ...actual,
    buildMcpRuntime: (...args: Parameters<typeof actual.buildMcpRuntime>) => {
      const real = actual.buildMcpRuntime(...args)
      return mocks.runtimeWarnings ? { ...real, warnings: mocks.runtimeWarnings } : real
    },
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
  mocks.runtimeWarnings = null
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

describe("McpSection a11y", () => {
  it("运行时警告框 role=note、前景色可读（不再 text-warning 叠 bg-warning）", () => {
    mocks.runtimeWarnings = ["warn-1"]
    render(<McpSection />)
    const box = screen.getByRole("note")
    expect(box).toHaveAttribute("data-testid", "mcp-runtime-warnings")
    expect(box.className).toContain("text-foreground")
    expect(box.className).not.toMatch(/(^|\s)text-warning(\s|$)/)
    expect(box).toHaveTextContent("warn-1")
  })

  it("服务启用开关是 role=switch，名称固定、状态走 aria-checked", async () => {
    render(<McpSection />)
    const sw = screen.getByRole("switch", { name: "settings.sections.mcp.enableServer" })
    expect(sw).toHaveAttribute("aria-checked", "true")
    expect(mocks.t).toHaveBeenCalledWith("settings.sections.mcp.enableServer", { name: "Graph" })
    fireEvent.click(sw)
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalledWith(
        expect.objectContaining({ servers: [expect.objectContaining({ enabled: false })] }),
      )
    })
  })

  it("服务字段 label 通过 htmlFor 关联", () => {
    render(<McpSection />)
    expect(screen.getByLabelText("settings.sections.mcp.startup")).toBeInTheDocument()
    expect(screen.getByLabelText("settings.sections.mcp.serverId")).toBeInTheDocument()
  })
})

describe("McpSection persist/增删/测试/JSON（覆盖战役补齐）", () => {
  const VALID_TOOLS_JSON = JSON.stringify([
    {
      serverId: "graph",
      serverName: "Graph",
      name: "query_graph_v2",
      description: "v2",
      operation: "read",
      inputSchema: { type: "object" },
    },
  ])

  beforeEach(() => {
    // 顶层 beforeEach 只 mockClear（实现会泄漏），这里重置为确定默认。
    mocks.testConnection.mockReset()
    mocks.testConnection.mockResolvedValue({ status: "ok", toolCount: 1, message: "fine" })
    mocks.closeAll.mockReset()
    mocks.closeAll.mockResolvedValue(undefined)
    mocks.saveMcpConfig.mockReset()
    mocks.saveMcpConfig.mockResolvedValue(undefined)
  })

  function setConfig(servers: unknown[]) {
    mocks.state.mcpConfig = { servers } as McpConfig
  }

  function testButton() {
    return screen.getByRole("button", { name: "settings.sections.mcp.testConnection" })
  }

  it("新增示例服：id 冲突时自动顺延 graph_2，并落盘 2 个服务", async () => {
    render(<McpSection />)
    fireEvent.click(screen.getByText("settings.sections.mcp.addSample"))
    await waitFor(() => {
      expect(mocks.saveMcpConfig).toHaveBeenCalledTimes(1)
    })
    const saved = (mocks.saveMcpConfig.mock.calls as unknown as Array<[McpConfig]>)[0][0]
    expect(saved.servers).toHaveLength(2)
    expect(saved.servers[1].id).toBe("graph_2")
    expect(saved.servers[1].tools[0].serverId).toBe("graph_2")
  })

  it("空配置：显示空态，新增直接用 graph id（无冲突循环）", async () => {
    setConfig([])
    render(<McpSection />)
    expect(screen.getByText("settings.sections.mcp.empty")).toBeInTheDocument()
    fireEvent.click(screen.getByText("settings.sections.mcp.addSample"))
    await waitFor(() => {
      expect(mocks.saveMcpConfig).toHaveBeenCalledTimes(1)
    })
    const saved = (mocks.saveMcpConfig.mock.calls as unknown as Array<[McpConfig]>)[0][0]
    expect(saved.servers).toHaveLength(1)
    expect(saved.servers[0].id).toBe("graph")
  })

  it("mcpConfig 为 null 时回退 DEFAULT（空态）", () => {
    mocks.state.mcpConfig = null
    render(<McpSection />)
    expect(screen.getByText("settings.sections.mcp.empty")).toBeInTheDocument()
  })

  it("persist 成功：saved 提示出现，1.5s 后消失", async () => {
    render(<McpSection />)
    fireEvent.click(screen.getByText("settings.sections.mcp.addSample"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.mcp.saved")).toBeInTheDocument()
    })
    await waitFor(
      () => {
        expect(screen.queryByText("settings.sections.mcp.saved")).toBeNull()
      },
      { timeout: 4000 },
    )
  })

  it("persist 失败：落盘错误可见（role=alert），saved 不出现", async () => {
    mocks.saveMcpConfig.mockRejectedValueOnce(new Error("disk-down"))
    render(<McpSection />)
    fireEvent.click(screen.getByText("settings.sections.mcp.addSample"))
    await waitFor(() => {
      expect(screen.getByTestId("mcp-save-error")).toBeInTheDocument()
    })
    // t 被 mock 为恒等函数，只断言键名命中；message 透传不断言 DOM 而断言调用参数。
    const saveFailedCalls = mocks.t.mock.calls.filter((c) => c[0] === "settings.sections.mcp.saveFailed")
    expect(saveFailedCalls.length).toBeGreaterThan(0)
    expect(String((saveFailedCalls[0][1] as Record<string, unknown>).message)).toContain("disk-down")
    expect(screen.queryByText("settings.sections.mcp.saved")).toBeNull()
  })

  it("删除：confirm 取消则不落盘；确认则移除服务并清理草稿", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    try {
      render(<McpSection />)
      fireEvent.click(screen.getByTitle("settings.sections.mcp.delete"))
      expect(mocks.saveMcpConfig).not.toHaveBeenCalled()
    } finally {
      cleanup()
      confirmSpy.mockReturnValue(true)
    }
    render(<McpSection />)
    fireEvent.click(screen.getByTitle("settings.sections.mcp.delete"))
    await waitFor(() => {
      expect(mocks.saveMcpConfig).toHaveBeenCalledTimes(1)
    })
    const saved = (mocks.saveMcpConfig.mock.calls as unknown as Array<[McpConfig]>)[0][0]
    expect(saved.servers).toHaveLength(0)
    confirmSpy.mockRestore()
  })

  it("改 id：工具的 serverId 跟着重映射（patch.id 分支）", async () => {
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.serverId"), {
      target: { value: "graph_x" },
    })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    const last = (mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig
    expect(last.servers[0].id).toBe("graph_x")
    expect(last.servers[0].tools[0].serverId).toBe("graph_x")
  })

  it("改 name：工具的 serverName 跟着重映射（patch.name 分支）", async () => {
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.serverName"), {
      target: { value: "GraphX" },
    })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    const last = (mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig
    expect(last.servers[0].name).toBe("GraphX")
    expect(last.servers[0].tools[0].serverName).toBe("GraphX")
  })

  it("服务名为空时启用开关 label 回退到 id", () => {
    setConfig([{ ...SERVER, name: "" }])
    render(<McpSection />)
    const calls = mocks.t.mock.calls.filter((c) => c[0] === "settings.sections.mcp.enableServer")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0][1]).toEqual({ name: "graph" })
  })

  it("禁用服务点测试：直接报 testNotAllowed，不调连接器", async () => {
    setConfig([{ ...SERVER, enabled: false }])
    render(<McpSection />)
    fireEvent.click(testButton())
    await waitFor(() => {
      expect(screen.getByText(/settings\.sections\.mcp\.testNotAllowed/)).toBeTruthy()
    })
    expect(mocks.testConnection).not.toHaveBeenCalled()
  })

  it("无启动命令点测试：报 testNeedCommand，不调连接器", async () => {
    const { command: _omit, ...noCommand } = SERVER
    setConfig([{ ...noCommand }])
    render(<McpSection />)
    expect((screen.getByLabelText("settings.sections.mcp.startup") as HTMLInputElement).value).toBe("")
    fireEvent.click(testButton())
    await waitFor(() => {
      expect(screen.getByText(/settings\.sections\.mcp\.testNeedCommand/)).toBeTruthy()
    })
    expect(mocks.testConnection).not.toHaveBeenCalled()
  })

  it("测试中：loading 文案 + spinner + 按钮禁用；成功后显示 testOk 且 closeAll", async () => {
    let resolveTest!: (v: unknown) => void
    mocks.testConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTest = resolve
      }),
    )
    render(<McpSection />)
    const btn = testButton()
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByText("settings.sections.mcp.testing")).toBeTruthy()
    })
    expect(btn.hasAttribute("disabled")).toBe(true)
    resolveTest({ status: "ok", toolCount: 3, message: "fine" })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.mcp.testOk")).toBeTruthy()
    })
    await waitFor(() => {
      expect(mocks.closeAll).toHaveBeenCalled()
    })
  })

  it("测试返回 error：显示 testFail 前缀 + 服务端消息", async () => {
    mocks.testConnection.mockResolvedValueOnce({ status: "error", toolCount: 0, message: "nope" })
    render(<McpSection />)
    fireEvent.click(testButton())
    await waitFor(() => {
      expect(screen.getByText(/nope/)).toBeTruthy()
    })
    expect(screen.getByText(/settings\.sections\.mcp\.testFail/)).toBeTruthy()
  })

  it("连接器抛错：复位 loading 并显示 testFailed，closeAll 照常跑", async () => {
    mocks.testConnection.mockRejectedValueOnce(new Error("conn-down"))
    render(<McpSection />)
    const btn = testButton()
    fireEvent.click(btn)
    await waitFor(() => {
      // 错误行是 `testFail：testFailed` 拼接（同一 span 多文本节点），用正则子串匹配。
      expect(screen.getByText(/settings\.sections\.mcp\.testFailed/)).toBeTruthy()
    })
    await waitFor(() => {
      expect(mocks.closeAll).toHaveBeenCalled()
    })
    // loading 已复位：按钮恢复可用
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("启动参数：空格分隔写入数组；清空则回退 undefined", async () => {
    setConfig([{ ...SERVER, args: undefined }])
    render(<McpSection />)
    const argsInput = screen.getByPlaceholderText(
      "settings.sections.mcp.startupArgsHint",
    ) as HTMLInputElement
    expect(argsInput.value).toBe("")
    fireEvent.change(argsInput, { target: { value: "a b  c" } })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    expect(((mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig).servers[0].args).toEqual(["a", "b", "c"])
    fireEvent.change(argsInput, { target: { value: "   " } })
    await waitFor(() => {
      const last = (mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig
      expect(last.servers[0].args).toBeUndefined()
    })
  })

  it("清空启动命令：回退为 undefined（|| undefined 分支）", async () => {
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.startup"), {
      target: { value: "" },
    })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    expect(((mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig).servers[0].command).toBeUndefined()
  })

  it("工具 JSON 合法：错误清空并回写 tools", async () => {
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.toolsJson"), {
      target: { value: VALID_TOOLS_JSON },
    })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    const last = (mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig
    expect(last.servers[0].tools).toHaveLength(1)
    expect(last.servers[0].tools[0].name).toBe("query_graph_v2")
    expect(screen.queryByText("settings.sections.mcp.invalidJson")).toBeNull()
  })

  it("工具 JSON 非法：显示解析错误，不写盘", async () => {
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.toolsJson"), {
      target: { value: "{bad" },
    })
    // JSON.parse 抛 SyntaxError（Error 实例）：界面直接展示其 message（含 JSON 字样）。
    await waitFor(() => {
      expect(screen.getByText(/JSON/)).toBeTruthy()
    })
    expect(mocks.setMcpConfig).not.toHaveBeenCalled()
  })

  it("工具 JSON 合法但服务归一化失败（空 id）：显示 invalidTools", async () => {
    setConfig([{ ...SERVER, id: "", name: "" }])
    render(<McpSection />)
    fireEvent.change(screen.getByLabelText("settings.sections.mcp.toolsJson"), {
      target: { value: VALID_TOOLS_JSON },
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.mcp.invalidTools")).toBeTruthy()
    })
  })

  it("多服务更新其一：map 经过其它服务走原样返回分支", async () => {
    setConfig([
      { ...SERVER, command: "node-a" },
      { ...SERVER, id: "graph2", name: "Graph2", command: "node-b" },
    ])
    render(<McpSection />)
    const startupInputs = screen.getAllByLabelText("settings.sections.mcp.startup")
    fireEvent.change(startupInputs[0], { target: { value: "node-a2" } })
    await waitFor(() => {
      expect(mocks.setMcpConfig).toHaveBeenCalled()
    })
    const last = (mocks.setMcpConfig.mock.calls[mocks.setMcpConfig.mock.calls.length - 1][0] as unknown) as McpConfig
    expect(last.servers[0].command).toBe("node-a2")
    expect(last.servers[1].command).toBe("node-b")
  })

  it("归一化失败的服务更新：normalize 返回 null 时保留原服务（?? 右侧分支）", async () => {
    // id 为空的服务无法通过归一化：updateServer 保留原对象但仍走 persist。
    setConfig([{ ...SERVER, id: "", name: "" }])
    render(<McpSection />)
    fireEvent.change(screen.getAllByLabelText("settings.sections.mcp.startup")[0], {
      target: { value: "node-x" },
    })
    await waitFor(() => {
      expect(mocks.saveMcpConfig).toHaveBeenCalledTimes(1)
    })
    const saved = (mocks.saveMcpConfig.mock.calls as unknown as Array<[McpConfig]>)[0][0]
    // updateServer 内 `?? server` 保留原对象后 persist；顶层 normalizeMcpConfig
    // 再把空 id 服务滤掉，故最终落盘为空数组——不断言中间态，只钉住「尝试落盘且不崩」。
    expect(saved.servers).toHaveLength(0)
  })

  it("closeAll 抛错：catch 吞掉，不影响错误展示", async () => {
    mocks.testConnection.mockRejectedValueOnce(new Error("conn-down"))
    mocks.closeAll.mockRejectedValueOnce(new Error("close-down"))
    render(<McpSection />)
    fireEvent.click(testButton())
    await waitFor(() => {
      expect(screen.getByText(/settings\.sections\.mcp\.testFailed/)).toBeTruthy()
    })
    await waitFor(() => {
      expect(mocks.closeAll).toHaveBeenCalled()
    })
  })
})
