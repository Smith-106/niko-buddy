import { describe, expect, it } from "vitest"
import { checkContinuity, DEFAULT_CONTINUITY_CONFIG } from "./deterministic-continuity-engine"
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import type {
  BarrierStateEvent,
  ContainerStateEvent,
  PresenceEvent,
  SetCountSnapshot,
} from "./deterministic-continuity-engine"

// 最小空 store 辅助（必需字段空数组满足 readonly 切片，可选切片按用例注入）。
function baseStore(overrides: {
  barrierEvents?: BarrierStateEvent[]
  presenceEvents?: PresenceEvent[]
  containerEvents?: ContainerStateEvent[]
  setCountSnapshots?: SetCountSnapshot[]
}) {
  return {
    foreshadowing: [] as const,
    subplots: [] as const,
    characters: [] as const,
    snapshots: [] as const,
    currentChapter: 10,
    ...overrides,
  }
}

describe("deterministic-continuity-engine G1 / 51 号 4 类检测器", () => {
  it("barrier_state: 屏障关闭且有穿越记录 → critical", () => {
    const store = baseStore({
      barrierEvents: [{ ref: "barrier:北城门", chapter: 5, isOpen: false, crossedChapter: 6 }],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const f = findings.find((x) => x.type === "barrier_state")
    expect(f).toBeDefined()
    expect(f?.severity).toBe("critical")
    expect(f?.ref).toBe("barrier:北城门")
    expect(f?.subtype).toBe("consistency_mechanical")
  })

  it("barrier_state: 屏障开启且有穿越 → 不报", () => {
    const store = baseStore({
      barrierEvents: [{ ref: "barrier:北城门", chapter: 5, isOpen: true, crossedChapter: 6 }],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    expect(findings.find((x) => x.type === "barrier_state")).toBeUndefined()
  })

  it("presence_path: 角色同一章出现在 2 个不同地点 → warning", () => {
    const store = baseStore({
      presenceEvents: [
        { ref: "character:昴", chapter: 7, location: "王城" },
        { ref: "character:昴", chapter: 7, location: "森林" },
      ],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const f = findings.find((x) => x.type === "presence_path")
    expect(f).toBeDefined()
    expect(f?.severity).toBe("warning")
    expect(f?.chapter).toBe(7)
  })

  it("presence_path: 同一地点重复出现 → 不报", () => {
    const store = baseStore({
      presenceEvents: [
        { ref: "character:昴", chapter: 7, location: "王城" },
        { ref: "character:昴", chapter: 7, location: "王城" },
      ],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    expect(findings.find((x) => x.type === "presence_path")).toBeUndefined()
  })

  it("container_state: 容器关闭且取出物品 → warning", () => {
    const store = baseStore({
      containerEvents: [{ ref: "container:保险箱", chapter: 8, isOpen: false, takenOutItem: "密函" }],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const f = findings.find((x) => x.type === "container_state")
    expect(f).toBeDefined()
    expect(f?.severity).toBe("warning")
    expect(f?.ref).toBe("container:保险箱")
  })

  it("set_count_drift: 同集合相邻章计数变化 → warning", () => {
    const store = baseStore({
      setCountSnapshots: [
        { ref: "party:主角团", chapter: 3, count: 4 },
        { ref: "party:主角团", chapter: 4, count: 5 },
      ],
    })
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const f = findings.find((x) => x.type === "set_count_drift")
    expect(f).toBeDefined()
    expect(f?.severity).toBe("warning")
    expect(f?.chapter).toBe(4)
  })

  it("additive 向后兼容: 可选切片全缺失 → 仅返回既有检测器结果（零新增 finding）", () => {
    const store = baseStore({})
    const findings = checkContinuity(store, DEFAULT_CONTINUITY_CONFIG)
    const g1types: ContinuityFinding["type"][] = [
      "barrier_state",
      "presence_path",
      "container_state",
      "set_count_drift",
    ]
    expect(findings.filter((f) => g1types.includes(f.type))).toHaveLength(0)
  })
})
