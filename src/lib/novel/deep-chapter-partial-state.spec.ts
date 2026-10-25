/**
 * ISS-20260709-045：partial 判别闭包 → 类型化状态对象（CORR-107 语义不变）。
 *
 * 锁定：first-wins（首因保留）+ 成功清除（完整成功置 null）+ draft 污染标记。
 * 状态对象承载于 deep-chapter-runtime-support.ts；generation 层薄闭包委托于此。
 */
import { describe, expect, it } from "vitest"
import {
  clearPartialState,
  createPartialState,
  noteDraftPartialState,
  notePartialState,
} from "./deep-chapter-runtime-support"

describe("ISS-20260709-045：PartialState（CORR-107 first-wins + 成功清除）", () => {
  it("初值：无 reason、无 draft 污染", () => {
    expect(createPartialState()).toEqual({ reason: null, draftStageHadPartial: false })
  })

  it("first-wins：首个 reason 保留，后来者忽略", () => {
    const s = createPartialState()
    notePartialState(s, "scene-breakdown: transport stalled mid-scene")
    notePartialState(s, "draft: transport stalled")
    expect(s.reason).toBe("scene-breakdown: transport stalled mid-scene")
  })

  it("成功清除：完整成功后 reason 置 null（幂等，null 上再清安全）", () => {
    const s = createPartialState()
    notePartialState(s, "early partial")
    clearPartialState(s)
    expect(s.reason).toBeNull()
    clearPartialState(s)
    expect(s.reason).toBeNull()
    // 清除后可重新记录（恢复-再失败路径）
    notePartialState(s, "later partial")
    expect(s.reason).toBe("later partial")
  })

  it("draft 污染标记：noteDraftPartialState 立标记 + 记首因", () => {
    const s = createPartialState()
    noteDraftPartialState(s, "draft transport stalled")
    expect(s.draftStageHadPartial).toBe(true)
    expect(s.reason).toBe("draft transport stalled")
    // draft 内二次 partial 不覆盖首因，但标记保持
    noteDraftPartialState(s, "draft second")
    expect(s.reason).toBe("draft transport stalled")
    expect(s.draftStageHadPartial).toBe(true)
  })

  it("编排层成功点语义：draft 零污染 + 内容完整才清早期 scene 残留", () => {
    // scene 残留
    const s = createPartialState()
    notePartialState(s, "scene-breakdown: transport stalled mid-scene")
    // draft 阶段零 partial → 编排层补清（clearPartialState）
    if (!s.draftStageHadPartial) {
      clearPartialState(s)
    }
    expect(s.reason).toBeNull()
    // draft 阶段有 partial → 不清（保留首因）
    const s2 = createPartialState()
    notePartialState(s2, "scene partial")
    noteDraftPartialState(s2, "draft partial")
    if (!s2.draftStageHadPartial) {
      clearPartialState(s2)
    }
    expect(s2.reason).toBe("scene partial")
  })
})
