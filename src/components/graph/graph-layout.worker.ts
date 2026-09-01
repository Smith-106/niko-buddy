// G3 (39 号修复): ForceAtlas2 布局 Web Worker — 纯 JS, 避免主线程 ≥500 节点阻塞。
// 与主线程无共享对象: 入参为可结构化克隆的节点/边数组, 出参为位置数组。
// 注意: 不引入 WebWorker lib (与 DOM lib 冲突), 用局部断言。
import {
  computeForceAtlas2Positions,
  type ForceAtlas2LayoutInput,
  type NodePositions,
} from "@/lib/graph-layout-engine"

export interface ForceAtlas2WorkerRequest {
  id: string
  type: "layout"
  payload: ForceAtlas2LayoutInput
}

export interface ForceAtlas2WorkerResponse {
  id: string
  positions: NodePositions
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ForceAtlas2WorkerRequest>) => void) | null
  postMessage: (message: ForceAtlas2WorkerResponse) => void
}

ctx.onmessage = (event: MessageEvent<ForceAtlas2WorkerRequest>) => {
  const { id, payload } = event.data
  try {
    const positions = computeForceAtlas2Positions(payload)
    ctx.postMessage({ id, positions })
  } catch (error) {
    // 出错也回传空结果, 避免主线程永久等待; 主线程会走兜底渲染
    ctx.postMessage({ id, positions: {} })
    console.error("[graph-layout-worker] layout failed", error)
  }
}
