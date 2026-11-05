import { beforeEach, describe, expect, it, vi } from "vitest"
import { RealMcpConnector } from "./real-connector"
import type { McpConfig } from "./config"

const transportMocks = vi.hoisted(() => ({
  TauriStdioTransport: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  call: vi.fn(),
  notify: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  JsonRpcClient: vi.fn(),
}))

vi.mock("./transport/stdio", () => transportMocks)
vi.mock("./transport/json-rpc", () => clientMocks)

const config: McpConfig = {
  servers: [
    {
      id: "graph",
      name: "图谱 MCP",
      enabled: true,
      command: "node",
      args: ["server.js"],
      transport: "stdio",
      tools: [
        {
          serverId: "graph",
          serverName: "图谱 MCP",
          name: "query_graph",
          description: "查询图谱",
          operation: "read",
          inputSchema: { type: "object" },
        },
      ],
    },
  ],
}

describe("RealMcpConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transportMocks.TauriStdioTransport.mockImplementation(function (this: { options: unknown }, options) {
      this.options = options
    })
    clientMocks.JsonRpcClient.mockImplementation(function (this: { call: unknown; notify: unknown; close: unknown }) {
      this.call = clientMocks.call
      this.notify = clientMocks.notify
      this.close = clientMocks.close
    })
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      return {}
    })
  })

  it("ensureConnected 首次调用时握手：initialize + notifications/initialized + tools/list", async () => {
    const connector = new RealMcpConnector(config)

    await connector.ensureConnected("graph")

    expect(transportMocks.TauriStdioTransport).toHaveBeenCalledWith({
      command: "node",
      args: ["server.js"],
      cwd: undefined,
      env: undefined,
    })
    expect(clientMocks.call).toHaveBeenCalledWith("initialize", expect.any(Object))
    expect(clientMocks.notify).toHaveBeenCalledWith("notifications/initialized")
    expect(clientMocks.call).toHaveBeenCalledWith("tools/list", {})
  })

  it("ensureConnected 已连接时复用 client，不重复握手", async () => {
    const connector = new RealMcpConnector(config)

    await connector.ensureConnected("graph")
    await connector.ensureConnected("graph")

    expect(clientMocks.JsonRpcClient).toHaveBeenCalledTimes(1)
    // 握手期两枚 call（initialize + tools/list），notify 一枚；复用时不再增加
    expect(clientMocks.call).toHaveBeenCalledTimes(2)
    expect(clientMocks.notify).toHaveBeenCalledTimes(1)
  })

  it("call 成功时返回 ok 结果", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      return { content: [{ type: "text", text: "图谱结果" }] }
    })
    const connector = new RealMcpConnector(config)

    const result = await connector.call({
      serverId: "graph",
      serverName: "图谱 MCP",
      toolName: "query_graph",
      nikoBuddyToolName: "mcp_graph_query_graph",
    }, { query: "主角" })

    expect(clientMocks.call).toHaveBeenCalledWith("tools/call", {
      name: "query_graph",
      arguments: { query: "主角" },
    })
    expect(result).toEqual({ status: "ok", content: "图谱结果", summary: "图谱结果" })
  })

  it("call 失败时返回中文降级信息", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      throw new Error("连接断开")
    })
    const connector = new RealMcpConnector(config)

    const result = await connector.call({
      serverId: "graph",
      serverName: "图谱 MCP",
      toolName: "query_graph",
      nikoBuddyToolName: "mcp_graph_query_graph",
    }, {})

    expect(result.status).toBe("error")
    expect(result.message).toContain("MCP 服务“图谱 MCP”调用失败：连接断开")
    expect(result.message).toContain("普通 AI 会话可以继续")
  })

  it("closeAll 关闭所有 client", async () => {
    const connector = new RealMcpConnector(config)
    await connector.ensureConnected("graph")

    await connector.closeAll()

    expect(clientMocks.close).toHaveBeenCalled()
  })

  it("listRemoteTools 返回握手拉取的远端工具列表", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") {
        return {
          tools: [
            { name: "query_graph", description: "查询图谱", inputSchema: { type: "object" } },
            { name: "analyze", description: "分析关系", inputSchema: { type: "object" } },
          ],
        }
      }
      return {}
    })
    const connector = new RealMcpConnector(config)

    const tools = await connector.listRemoteTools("graph")

    expect(tools).toHaveLength(2)
    expect(tools[0]).toEqual(expect.objectContaining({ name: "query_graph" }))
  })

  it("testConnection 成功时返回中文成功信息与工具数", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") {
        return { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] }
      }
      return {}
    })
    const connector = new RealMcpConnector(config)

    const result = await connector.testConnection("graph")

    expect(result.status).toBe("ok")
    expect(result.toolCount).toBe(3)
    expect(result.message).toContain("连接成功")
    expect(result.message).toContain("3")
  })

  it("testConnection 启动命令缺失时返回中文错误信息", async () => {
    const noCommandConfig: McpConfig = {
      servers: [{ ...config.servers[0], command: undefined }],
    }
    const connector = new RealMcpConnector(noCommandConfig)

    const result = await connector.testConnection("graph")

    expect(result.status).toBe("error")
    expect(result.message).toContain("未配置启动命令")
  })

  it("mergeRemoteTools 用远端 description 覆盖本地同名工具，保留本地 operation 权限", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") {
        return {
          tools: [{
            name: "query_graph",
            description: "Remote updated description",
            inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          }],
        }
      }
      return {}
    })
    const connector = new RealMcpConnector(config)
    await connector.ensureConnected("graph")

    const merged = connector.mergeRemoteTools("graph", config.servers[0].tools)

    expect(merged[0].description).toBe("Remote updated description")
    expect(merged[0].operation).toBe("read")
    expect(merged[0].inputSchema.required).toEqual(["q"])
  })
})

describe("RealMcpConnector 未覆盖分支补足", () => {
  beforeEach(() => {
    clientMocks.call.mockReset()
    clientMocks.notify.mockReset()
    clientMocks.close.mockReset()
    clientMocks.JsonRpcClient.mockReset()
    transportMocks.TauriStdioTransport.mockReset()
    transportMocks.TauriStdioTransport.mockImplementation(function (this: { options: unknown }, options) {
      this.options = options
    })
    clientMocks.JsonRpcClient.mockImplementation(function (this: { call: unknown; notify: unknown; close: unknown }) {
      this.call = clientMocks.call
      this.notify = clientMocks.notify
      this.close = clientMocks.close
    })
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      return {}
    })
  })

  it("caller getter 返回绑定后的 call", async () => {
    const connector = new RealMcpConnector(config)
    const result = await connector.caller(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(result.status).toBe("ok")
  })

  it("ensureConnected 未知服务 fail-loud", async () => {
    const connector = new RealMcpConnector(config)
    await expect(connector.ensureConnected("nope")).rejects.toThrow("未找到 MCP 服务：nope")
  })

  it("listRemoteTools 已缓存时直接返回，不再握手", async () => {
    const connector = new RealMcpConnector(config)
    const first = await connector.listRemoteTools("graph")
    expect(first).toEqual([])
    const callsAfterFirst = clientMocks.JsonRpcClient.mock.calls.length
    const second = await connector.listRemoteTools("graph")
    expect(second).toBe(first)
    expect(clientMocks.JsonRpcClient.mock.calls.length).toBe(callsAfterFirst)
  })

  it("testConnection 未知服务返回中文错误（不抛）", async () => {
    const connector = new RealMcpConnector(config)
    const result = await connector.testConnection("nope")
    expect(result.status).toBe("error")
    expect(result.toolCount).toBe(0)
    expect(result.message).toContain("未找到 MCP 服务")
  })

  it("mergeRemoteTools 无远端时原样返回本地；远端缺名时保留本地项", async () => {
    const connector = new RealMcpConnector(config)
    expect(connector.mergeRemoteTools("graph", config.servers[0].tools)).toBe(
      config.servers[0].tools,
    )
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [{ name: "other", description: "其它" }] }
      return {}
    })
    await connector.ensureConnected("graph")
    const merged = connector.mergeRemoteTools("graph", config.servers[0].tools)
    expect(merged[0].description).toBe("查询图谱")
  })

  it("closeAll 容忍单个关闭失败（allSettled 语义）", async () => {
    clientMocks.close.mockRejectedValueOnce(new Error("boom"))
    const connector = new RealMcpConnector(config)
    await connector.ensureConnected("graph")
    await expect(connector.closeAll()).resolves.toBeUndefined()
  })

  it("tools/list 失败不阻断握手（远端工具为空回退本地）", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") throw new Error("denied")
      return {}
    })
    const connector = new RealMcpConnector(config)
    await expect(connector.ensureConnected("graph")).resolves.toBeDefined()
    expect(connector.mergeRemoteTools("graph", config.servers[0].tools)).toBe(
      config.servers[0].tools,
    )
  })

  it("extractMcpText 各形态：非 record/数组混合/纯文本字段/回退序列化", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      return { content: [{ type: "text", text: "甲" }, { type: "image", text: "x" }, "raw", { type: "text", text: 1 }] }
    })
    const connector = new RealMcpConnector(config)
    const mixed = await connector.call(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(mixed.content).toBe("甲")

    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      if (method === "tools/call") return "plain-string"
      return {}
    })
    const connector2 = new RealMcpConnector(config)
    const plain = await connector2.call(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(plain.content).toBe("plain-string")

    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      if (method === "tools/call") return { text: "快捷文本" }
      return {}
    })
    const connector3 = new RealMcpConnector(config)
    const shortcut = await connector3.call(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(shortcut.content).toBe("快捷文本")
  })

  it("extractMcpText 空数组回退序列化；循环引用回退 String()", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      if (method === "tools/call") return { content: [] }
      return {}
    })
    const connector = new RealMcpConnector(config)
    const empty = await connector.call(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(empty.content).toBe("{\"content\":[]}")

    const circular: Record<string, unknown> = {}
    circular.self = circular
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") return { tools: [] }
      if (method === "tools/call") return circular
      return {}
    })
    const connector2 = new RealMcpConnector(config)
    const circ = await connector2.call(
      { serverId: "graph", serverName: "图谱 MCP", toolName: "query_graph", nikoBuddyToolName: "mcp_graph_query_graph" },
      {},
    )
    expect(circ.content).toBe("[object Object]")
  })

  it("normalizeRemoteSchema 合规 properties/required 透传（含非字符串过滤）", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") {
        return {
          tools: [{
            name: "query_graph",
            description: "远端描述",
            inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q", 1] },
          }],
        }
      }
      return {}
    })
    const connector = new RealMcpConnector(config)
    await connector.ensureConnected("graph")
    const merged = connector.mergeRemoteTools("graph", config.servers[0].tools)
    expect(merged[0].inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    })
  })

  it("normalizeRemoteSchema 非法 inputSchema 回退本地", async () => {
    clientMocks.call.mockImplementation(async (method: string) => {
      if (method === "initialize") return {}
      if (method === "tools/list") {
        return {
          tools: [{ name: "query_graph", description: "   ", inputSchema: { title: "x" } }],
        }
      }
      return {}
    })
    const connector = new RealMcpConnector(config)
    await connector.ensureConnected("graph")
    const merged = connector.mergeRemoteTools("graph", config.servers[0].tools)
    // 空白远端描述回落本地；非法 schema（缺 type:object）回落本地
    expect(merged[0].description).toBe("查询图谱")
    expect(merged[0].inputSchema).toEqual({ type: "object" })
  })
})
