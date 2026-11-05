import { describe, expect, it, vi } from "vitest"
import { JsonRpcClient, type StdioTransport } from "./json-rpc"

function createTransport(lines: Array<string | null>) {
  const sent: string[] = []
  const transport: StdioTransport = {
    send: vi.fn(async (data: string) => {
      sent.push(data)
    }),
    receive: vi.fn(async () => lines.shift() ?? null),
    close: vi.fn(async () => {}),
  }
  return { transport, sent }
}

describe("JsonRpcClient", () => {
  it("call 方法发送正确格式的 request", async () => {
    const { transport, sent } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ])
    const client = new JsonRpcClient(transport)

    await client.call("initialize", { client: "niko-buddy" })

    expect(JSON.parse(sent[0])).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { client: "niko-buddy" },
    })
  })

  it("收到 response 时解析 result", async () => {
    const { transport } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    ])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/list")).resolves.toEqual({ tools: [] })
  })

  it("收到 error 时抛出中文错误", async () => {
    const { transport } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "工具失败" } }),
    ])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/call")).rejects.toThrow("工具失败")
  })
})

describe("JsonRpcClient 覆盖补齐", () => {
  it("收不到回包时抛出超时错误", async () => {
    const { transport } = createTransport([])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/list", undefined, 10)).rejects.toThrow("MCP 调用超时：tools/list")
  })

  it("回包不是 JSON 时抛出格式错误", async () => {
    const { transport } = createTransport(["this is not json"])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/list")).rejects.toThrow("MCP 返回格式无法解析：tools/list")
  })

  it("回包 ID 不匹配时抛出错误", async () => {
    const { transport } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }),
    ])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/list")).rejects.toThrow("MCP 返回 ID 不匹配：tools/list")
  })

  it("error 回包无 message 时使用默认失败文案", async () => {
    const { transport } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: {} }),
    ])
    const client = new JsonRpcClient(transport)

    await expect(client.call("tools/call")).rejects.toThrow("MCP 调用失败：tools/call")
  })

  it("无 params 调用省略 params 字段", async () => {
    const { transport, sent } = createTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
    ])
    const client = new JsonRpcClient(transport)

    await client.call("ping")

    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" })
  })

  it("notify 无 params 时只发送 method", async () => {
    const { transport, sent } = createTransport([])
    const client = new JsonRpcClient(transport)

    await client.notify("session/started")

    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: "2.0", method: "session/started" })
  })

  it("notify 有 params 时携带 params", async () => {
    const { transport, sent } = createTransport([])
    const client = new JsonRpcClient(transport)

    await client.notify("progress", { percent: 50 })

    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: "2.0", method: "progress", params: { percent: 50 } })
  })

  it("close 转调底层传输关闭", async () => {
    const { transport } = createTransport([])
    const client = new JsonRpcClient(transport)

    await client.close()

    expect(transport.close).toHaveBeenCalledTimes(1)
  })
})
