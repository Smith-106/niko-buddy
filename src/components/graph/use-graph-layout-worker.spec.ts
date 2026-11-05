// @vitest-environment jsdom
// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

const engineMocks = vi.hoisted(() => ({
  compute: vi.fn(),
}))

vi.mock("@/lib/graph-layout-engine", () => ({
  computeForceAtlas2Positions: engineMocks.compute,
}))

import { useGraphLayoutWorker } from "./use-graph-layout-worker"
import type { ForceAtlas2LayoutInput, NodePositions } from "@/lib/graph-layout-engine"

const INPUT: ForceAtlas2LayoutInput = {
  nodes: [
    { id: "a", x: 0, y: 0, size: 5 },
    { id: "b", x: 10, y: 10, size: 5 },
  ],
  edges: [{ source: "a", target: "b", weight: 1 }],
  iterations: 50,
  settings: {},
  barnesHutOptimize: false,
}

const ENGINE_POS: NodePositions = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }
const WORKER_POS: NodePositions = { a: { x: 7, y: 8 }, b: { x: 9, y: 10 } }

const workerControl = vi.hoisted(() => ({
  instances: [] as FakeWorker[],
  throwOnPost: false,
}))

class FakeWorker {
  onmessage: ((event: { data: { id: string; positions: NodePositions } }) => void) | null = null
  onerror: (() => void) | null = null
  posted: unknown[] = []
  terminated = false
  constructor() {
    workerControl.instances.push(this)
  }
  postMessage(message: unknown): void {
    this.posted.push(message)
    if (workerControl.throwOnPost) throw new Error("post failed")
  }
  terminate(): void {
    this.terminated = true
  }
  respond(id: string, positions: NodePositions): void {
    this.onmessage?.({ data: { id, positions } })
  }
  fail(): void {
    this.onerror?.()
  }
  postedId(index = 0): string {
    return (this.posted[index] as { id: string }).id
  }
}

describe("useGraphLayoutWorker", () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    workerControl.instances = []
    workerControl.throwOnPost = false
    engineMocks.compute.mockReset()
    engineMocks.compute.mockReturnValue(ENGINE_POS)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("Worker 不可用时回退主线程同步计算", async () => {
    const { result } = renderHook(() => useGraphLayoutWorker())
    let out: NodePositions | undefined
    await act(async () => {
      out = await result.current.computeLayout(INPUT)
    })
    expect(engineMocks.compute).toHaveBeenCalledWith(INPUT)
    expect(out).toBe(ENGINE_POS)
  })

  it("Worker 成功往返：postMessage 入参与 onmessage 出参闭环，复用同一实例", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const { result } = renderHook(() => useGraphLayoutWorker())
    let first: NodePositions | undefined
    let second: NodePositions | undefined
    await act(async () => {
      const p1 = result.current.computeLayout(INPUT)
      expect(workerControl.instances).toHaveLength(1)
      const instance = workerControl.instances[0]
      expect(instance.posted).toHaveLength(1)
      expect(instance.posted[0]).toMatchObject({ type: "layout", payload: INPUT })
      instance.respond(instance.postedId(), WORKER_POS)
      first = await p1
      // 第二次调用复用同一 Worker，不再新建
      const p2 = result.current.computeLayout(INPUT)
      instance.respond(instance.postedId(1), WORKER_POS)
      second = await p2
    })
    expect(first).toBe(WORKER_POS)
    expect(second).toBe(WORKER_POS)
    expect(workerControl.instances).toHaveLength(1)
  })

  it("未知 id 的 Worker 响应被忽略", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const { result } = renderHook(() => useGraphLayoutWorker())
    let out: NodePositions | undefined
    await act(async () => {
      const pending = result.current.computeLayout(INPUT)
      const instance = workerControl.instances[0]
      instance.respond("ghost-id", { z: { x: 0, y: 0 } })
      instance.respond(instance.postedId(), WORKER_POS)
      out = await pending
    })
    expect(out).toBe(WORKER_POS)
  })

  it("postMessage 抛错时回退主线程并标记失败，后续不再建 Worker", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    workerControl.throwOnPost = true
    const { result } = renderHook(() => useGraphLayoutWorker())
    let first: NodePositions | undefined
    let second: NodePositions | undefined
    await act(async () => {
      first = await result.current.computeLayout(INPUT)
      second = await result.current.computeLayout(INPUT)
    })
    expect(first).toBe(ENGINE_POS)
    expect(second).toBe(ENGINE_POS)
    expect(engineMocks.compute).toHaveBeenCalledTimes(2)
    // 失败后不再 new Worker
    expect(workerControl.instances).toHaveLength(1)
  })

  it("Worker 超时回退主线程并终止旧实例", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const { result } = renderHook(() => useGraphLayoutWorker())
    let out: NodePositions | undefined
    const pending = result.current.computeLayout(INPUT)
    const wait = pending.then((v) => {
      out = v
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })
    await wait
    expect(out).toBe(ENGINE_POS)
    expect(workerControl.instances[0].terminated).toBe(true)
  })

  it("Worker 出错回退主线程并清空挂起", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    const { result } = renderHook(() => useGraphLayoutWorker())
    let out: NodePositions | undefined
    const pending = result.current.computeLayout(INPUT).then((v) => {
      out = v
    })
    await act(async () => {
      workerControl.instances[0].fail()
    })
    await pending
    expect(out).toBe(ENGINE_POS)
    // 失败后不再建 Worker：直接走主线程
    let next: NodePositions | undefined
    await act(async () => {
      next = await result.current.computeLayout(INPUT)
    })
    expect(next).toBe(ENGINE_POS)
    expect(workerControl.instances).toHaveLength(1)
  })

  it("回退计算抛错时 resolve 空对象（超时 / onerror 双路径）", async () => {
    vi.stubGlobal("Worker", FakeWorker)
    // 超时路径：独立 hook 实例，避免失败标记污染后半段
    engineMocks.compute.mockImplementation(() => {
      throw new Error("fa2 down")
    })
    const first = renderHook(() => useGraphLayoutWorker())
    let timeoutOut: NodePositions | undefined
    const timeoutPending = first.result.current.computeLayout(INPUT).then((v) => {
      timeoutOut = v
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })
    await timeoutPending
    expect(timeoutOut).toEqual({})
    first.unmount()
    // onerror 路径：全新 hook，Worker 建好后再让引擎抛错
    engineMocks.compute.mockReturnValue(ENGINE_POS)
    const second = renderHook(() => useGraphLayoutWorker())
    let errorOut: NodePositions | undefined
    const errorPending = second.result.current.computeLayout(INPUT).then((v) => {
      errorOut = v
    })
    engineMocks.compute.mockImplementation(() => {
      throw new Error("fa2 down")
    })
    await act(async () => {
      workerControl.instances[workerControl.instances.length - 1].fail()
    })
    await errorPending
    expect(errorOut).toEqual({})
    second.unmount()
  })

  it("Worker 构造抛错时回退主线程", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("no worker")
        }
      },
    )
    const { result } = renderHook(() => useGraphLayoutWorker())
    let out: NodePositions | undefined
    await act(async () => {
      out = await result.current.computeLayout(INPUT)
    })
    expect(out).toBe(ENGINE_POS)
    expect(engineMocks.compute).toHaveBeenCalledWith(INPUT)
  })
})
