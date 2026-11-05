import { describe, expect, it } from "vitest"
import {
  createSampleGraphMcpServer,
  normalizeMcpConfig,
  normalizeMcpServerConfig,
} from "./config"

describe("MCP config normalization", () => {
  it("falls back to an empty config for invalid input", () => {
    expect(normalizeMcpConfig(null)).toEqual({ servers: [] })
    expect(normalizeMcpConfig({ servers: "bad" })).toEqual({ servers: [] })
  })

  it("normalizes server and tool descriptors while filling server identity", () => {
    const config = normalizeMcpConfig({
      servers: [{
        id: " Graph Server ",
        name: " Knowledge Graph ",
        enabled: true,
        tools: [{
          name: " query_graph ",
          description: " Query graph ",
          operation: "read",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Query" },
            },
            required: ["query"],
          },
        }],
      }],
    })

    expect(config.servers[0]).toEqual(expect.objectContaining({
      id: "Graph Server",
      name: "Knowledge Graph",
      enabled: true,
    }))
    expect(config.servers[0].tools[0]).toEqual(expect.objectContaining({
      serverId: "Graph Server",
      serverName: "Knowledge Graph",
      name: "query_graph",
      description: "Query graph",
      operation: "read",
    }))
  })

  it("drops malformed tools but keeps destructive descriptors for runtime warnings", () => {
    const server = normalizeMcpServerConfig({
      id: "graph",
      name: "Graph",
      enabled: true,
      tools: [
        { name: "", description: "bad", operation: "read", inputSchema: { type: "object" } },
        { name: "delete_node", description: "Delete node", operation: "delete", inputSchema: { type: "object" } },
      ],
    })

    expect(server).not.toBeNull()
    if (!server) return
    expect(server.tools).toHaveLength(1)
    expect(server.tools[0].operation).toBe("delete")
  })

  it("creates a stable sample GraphRAG server", () => {
    const server = createSampleGraphMcpServer()

    expect(server.id).toBe("graph")
    expect(server.name).toContain("Graph")
    expect(server.enabled).toBe(true)
    expect(server.tools.map((tool) => tool.name)).toEqual(["query_graph", "analyze_relation"])
    expect(server.tools.every((tool) => tool.serverId === "graph")).toBe(true)
  })
})

describe("MCP config 逐层降级（非记录 / 坏工具 / 坏 schema）", () => {
  it("非记录的 server 输入返回 null（而非抛错）", () => {
    expect(normalizeMcpServerConfig(null)).toBeNull()
    expect(normalizeMcpServerConfig("graph")).toBeNull()
    expect(normalizeMcpServerConfig(["graph"])).toBeNull()
  })

  it("tools 中的非记录项与 schema 非 object 的项均被丢弃，保留合法项", () => {
    const server = normalizeMcpServerConfig({
      id: "graph",
      name: "Graph",
      tools: [
        "not-a-record",
        null,
        { name: "schema_not_record", description: "d", operation: "read", inputSchema: "object" },
        { name: "schema_wrong_type", description: "d", operation: "read", inputSchema: { type: "array" } },
        { name: "unknown_op", description: "d", operation: "execute", inputSchema: { type: "object" } },
        { name: "ok", description: "d", operation: "read", inputSchema: { type: "object", properties: {}, required: ["q", 7] } },
      ],
    })

    expect(server).not.toBeNull()
    if (!server) return
    expect(server.tools.map((tool) => tool.name)).toEqual(["ok"])
    // required 只保留字符串项（脏数据过滤而非整体丢弃）
    expect(server.tools[0].inputSchema?.required).toEqual(["q"])
  })

  it("args/env 归一化：只保留字符串项，空壳一律 undefined", () => {
    const server = normalizeMcpServerConfig({
      id: "g",
      name: "G",
      transport: "sse",
      command: "  node  ",
      cwd: " /tmp ",
      args: ["a", 1, "b"],
      env: { TOKEN: "x", NUM: 1 },
      enabled: false,
    })

    expect(server).not.toBeNull()
    if (!server) return
    expect(server.transport).toBe("sse")
    expect(server.enabled).toBe(false)
    expect(server.command).toBe("node")
    expect(server.cwd).toBe("/tmp")
    expect(server.args).toEqual(["a", "b"])
    expect(server.env).toEqual({ TOKEN: "x" })
    // 未给 tools 时归一化为空数组（而非 undefined）
    expect(server.tools).toEqual([])
  })

  it("args 非数组 / env 无字符串值 / 标量入参 → 字段留空且不臆造", () => {
    const server = normalizeMcpServerConfig({
      id: "g2",
      name: "G2",
      args: "a b",
      env: { NUM: 1, NIL: null },
      command: "   ",
    })

    expect(server).not.toBeNull()
    if (!server) return
    expect(server.args).toBeUndefined()
    expect(server.env).toBeUndefined()
    expect(server.command).toBeUndefined()
    expect(server.transport).toBe("stdio")

    const emptyArgs = normalizeMcpServerConfig({ id: "g3", name: "G3", args: [], env: {} })
    expect(emptyArgs?.args).toBeUndefined()
    expect(emptyArgs?.env).toBeUndefined()
  })

  it("properties 非记录时 schema 保留但 properties 留空", () => {
    const server = normalizeMcpServerConfig({
      id: "g4",
      name: "G4",
      tools: [{ name: "t", description: "d", operation: "write", inputSchema: { type: "object", properties: "nope" } }],
    })

    expect(server?.tools[0].inputSchema).toEqual({ type: "object", properties: undefined, required: undefined })
  })
})
