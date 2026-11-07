import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { TauriStdioTransport } from "./stdio"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

describe("TauriStdioTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("start 调用 mcp_stdio_spawn", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(123)
    const transport = new TauriStdioTransport({ command: "node", args: ["server.js"] })

    await transport.start()

    expect(invoke).toHaveBeenCalledWith("mcp_stdio_spawn", {
      options: { command: "node", args: ["server.js"] },
    })
  })

  it("send 调用 mcp_stdio_write", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(123).mockResolvedValueOnce(undefined)
    const transport = new TauriStdioTransport({ command: "node" })

    await transport.send('{"jsonrpc":"2.0"}')

    expect(invoke).toHaveBeenCalledWith("mcp_stdio_write", {
      pid: 123,
      data: '{"jsonrpc":"2.0"}',
    })
  })

  it("receive 调用 mcp_stdio_read", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(123).mockResolvedValueOnce('{"ok":true}')
    const transport = new TauriStdioTransport({ command: "node" })

    await expect(transport.receive(1000)).resolves.toBe('{"ok":true}')
    expect(invoke).toHaveBeenCalledWith("mcp_stdio_read", {
      pid: 123,
      timeoutMs: 1000,
    })
  })

  it("close 调用 mcp_stdio_kill", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(123).mockResolvedValueOnce(undefined)
    const transport = new TauriStdioTransport({ command: "node" })

    await transport.start()
    await transport.close()

    expect(invoke).toHaveBeenCalledWith("mcp_stdio_kill", { pid: 123 })
  })
})

describe("TauriStdioTransport 生命周期幂等", () => {
  it("start 幂等：已启动后再次 start 直接返回缓存 pid，不重复 spawn", async () => {
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValueOnce(456)
    const transport = new TauriStdioTransport({ command: "node" })

    expect(await transport.start()).toBe(456)
    expect(await transport.start()).toBe(456)
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
  })

  it("未启动即 close → 空操作，不调用 kill", async () => {
    vi.mocked(invoke).mockReset()
    const transport = new TauriStdioTransport({ command: "node" })

    await expect(transport.close()).resolves.toBeUndefined()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })
})
