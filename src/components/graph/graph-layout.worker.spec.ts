// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const engineMocks = vi.hoisted(() => ({
  compute: vi.fn(),
}))

vi.mock("@/lib/graph-layout-engine", () => ({
  computeForceAtlas2Positions: engineMocks.compute,
}))

interface CapturedCtx {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: ReturnType<typeof vi.fn>
}

let captured: CapturedCtx | null = null

describe("graph-layout.worker", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    engineMocks.compute.mockReset()
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it("成功计算并按 id 回传 positions", async () => {
    const postMessage = vi.fn()
    captured = { onmessage: null, postMessage }
    vi.stubGlobal("self", captured)
    vi.resetModules()
    await import("./graph-layout.worker")
    const positions = { a: { x: 1, y: 2 } }
    engineMocks.compute.mockReturnValue(positions)
    const payload = { nodes: [], edges: [], iterations: 1, settings: {}, barnesHutOptimize: false }
    captured.onmessage?.({ data: { id: "req-1", type: "layout", payload } })
    expect(engineMocks.compute).toHaveBeenCalledWith(payload)
    expect(postMessage).toHaveBeenCalledWith({ id: "req-1", positions })
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it("计算抛错时回传空结果并记录错误", async () => {
    const postMessage = vi.fn()
    captured = { onmessage: null, postMessage }
    vi.stubGlobal("self", captured)
    vi.resetModules()
    await import("./graph-layout.worker")
    const failure = new Error("fa2 exploded")
    engineMocks.compute.mockImplementation(() => {
      throw failure
    })
    captured.onmessage?.({ data: { id: "req-9", type: "layout", payload: {} } })
    expect(postMessage).toHaveBeenCalledWith({ id: "req-9", positions: {} })
    expect(consoleErrorSpy).toHaveBeenCalledWith("[graph-layout-worker] layout failed", failure)
  })
})
