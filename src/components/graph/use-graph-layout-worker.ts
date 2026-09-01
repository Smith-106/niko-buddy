// G3 (39 号修复): ForceAtlas2 布局 Web Worker hook — 模式对齐 use-simulation-worker。
// Worker 不可用/超时/出错时回退主线程同步计算 (与原逻辑等价)。
import { useRef, useCallback } from "react"
import {
  computeForceAtlas2Positions,
  type ForceAtlas2LayoutInput,
  type NodePositions,
} from "@/lib/graph-layout-engine"
import type { ForceAtlas2WorkerResponse } from "./graph-layout.worker"

const TIMEOUT_MS = 8000

interface PendingEntry {
  resolve: (value: NodePositions) => void
  reject: (reason: unknown) => void
  timeoutId: ReturnType<typeof setTimeout>
  /** onerror/超时回退主线程计算所需入参 (G3 修复) */
  input: ForceAtlas2LayoutInput
}

export function useGraphLayoutWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<string, PendingEntry>>(new Map())
  const failedRef = useRef(false)

  const ensureWorker = useCallback((): Worker | null => {
    if (failedRef.current) return null
    if (workerRef.current) return workerRef.current
    try {
      if (typeof Worker === "undefined") {
        failedRef.current = true
        return null
      }
      const worker = new Worker(new URL("./graph-layout.worker.ts", import.meta.url), {
        type: "module",
      })
      worker.onmessage = (event: MessageEvent<ForceAtlas2WorkerResponse>) => {
        const { id, positions } = event.data
        const pending = pendingRef.current.get(id)
        if (!pending) return
        pendingRef.current.delete(id)
        clearTimeout(pending.timeoutId)
        pending.resolve(positions)
      }
      worker.onerror = () => {
        failedRef.current = true
        workerRef.current?.terminate()
        workerRef.current = null
        for (const [, pending] of pendingRef.current) {
          clearTimeout(pending.timeoutId)
          // G3 修复: 与超时分支同语义 — 回退主线程同步计算, 保证布局仍产出
          try {
            pending.resolve(computeForceAtlas2Positions(pending.input))
          } catch {
            pending.resolve({})
          }
        }
        pendingRef.current.clear()
      }
      workerRef.current = worker
      return worker
    } catch {
      failedRef.current = true
      return null
    }
  }, [])

  const computeLayout = useCallback(
    (input: ForceAtlas2LayoutInput): Promise<NodePositions> => {
      const worker = ensureWorker()
      if (!worker) {
        // 主线程 fallback (与原逻辑等价)
        return Promise.resolve(computeForceAtlas2Positions(input))
      }
      const id = `${Date.now()}-${Math.random()}`
      return new Promise<NodePositions>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRef.current.delete(id)
          failedRef.current = true
          workerRef.current?.terminate()
          workerRef.current = null
          // 超时回退主线程
          try {
            resolve(computeForceAtlas2Positions(input))
          } catch {
            resolve({})
          }
        }, TIMEOUT_MS)
        pendingRef.current.set(id, { resolve, reject, timeoutId, input })
        try {
          worker.postMessage({ id, type: "layout", payload: input })
        } catch {
          pendingRef.current.delete(id)
          clearTimeout(timeoutId)
          failedRef.current = true
          resolve(computeForceAtlas2Positions(input))
        }
      })
    },
    [ensureWorker],
  )

  return { computeLayout }
}
