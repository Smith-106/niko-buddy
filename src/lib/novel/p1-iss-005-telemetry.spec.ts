/**
 * ISS-20260713-005：A/B 遥测写 cognition-state.json 层错位改正确分层。
 *
 * 分层：engine 只产出样本（buildRoutingROISample，纯）→ 经 RoutingTelemetrySink
 * 投递；默认 sink 写 cognition-state.json 既有 key（HARD-1 守恒），调用方可注入
 * 探针 sink 接管落盘（engine 不再直连 cognition-state.json 写入实现）。
 *
 * 等价断言：variant 映射/chapterId 回退/timestamp/irrelevantRatio 与原内联一致；
 * 探针 sink 收到与纯函数输出字段一致的样本。
 */
import { describe, expect, it, vi } from "vitest"
import type { ContextEntity, ContextPack } from "./context-engine"
import {
  buildRoutingROISample,
  defaultRoutingTelemetrySink,
  reportRoutingROI,
  type RoutingROISample,
} from "./context-telemetry"

function makePack(): ContextPack {
  return {
    characterStates: "- Alice：勇敢\n- Bob：谨慎",
    relatedSettings: "",
    cognitionStates: "",
  } as ContextPack
}

function makeEntities(): ContextEntity[] {
  return [{ entityId: "e1", name: "Alice", type: "character" }]
}

describe("ISS-20260713-005 遥测分层 context-telemetry", () => {
  it("buildRoutingROISample 与原内联组装等价（variant/chapterId/占比）", () => {
    const enabled = buildRoutingROISample({
      pack: makePack(),
      activeEntities: makeEntities(),
      chapterNumber: 3,
      conditionalRoutingEnabled: true,
    })
    expect(enabled.variant).toBe("enabled")
    expect(enabled.chapterId).toBe("3")
    // 候选 {Alice, Bob}，active {Alice} → 1/2
    expect(enabled.irrelevantRatio).toBe(0.5)
    expect(typeof enabled.timestamp).toBe("string")
    expect(Number.isNaN(Date.parse(enabled.timestamp))).toBe(false)

    const disabled = buildRoutingROISample({
      pack: makePack(),
      activeEntities: makeEntities(),
      chapterNumber: undefined,
      conditionalRoutingEnabled: false,
    })
    expect(disabled.variant).toBe("disabled")
    expect(disabled.chapterId).toBe("unknown")
    expect(disabled.irrelevantRatio).toBe(0.5)
  })

  it("reportRoutingROI 经注入 sink 投递（engine 不直写文件，调用方接管 UI/落盘）", () => {
    const probe = vi.fn()
    const input = {
      pack: makePack(),
      activeEntities: makeEntities(),
      chapterNumber: 7,
      conditionalRoutingEnabled: true,
    }
    reportRoutingROI("E:/Proj", input, probe)
    expect(probe).toHaveBeenCalledTimes(1)
    const [projectPath, sample] = probe.mock.calls[0] as [string, RoutingROISample]
    expect(projectPath).toBe("E:/Proj")
    const expected = buildRoutingROISample(input)
    expect(sample.variant).toBe(expected.variant)
    expect(sample.chapterId).toBe(expected.chapterId)
    expect(sample.irrelevantRatio).toBe(expected.irrelevantRatio)
    expect(sample.chapterId).toBe("7")
  })

  it("默认 sink 为二元 fire-and-forget 函数（缺省行为 = 原内联语义）", () => {
    expect(typeof defaultRoutingTelemetrySink).toBe("function")
    expect(defaultRoutingTelemetrySink.length).toBe(2)
  })
})
