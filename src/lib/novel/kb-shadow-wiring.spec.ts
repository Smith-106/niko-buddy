/**
 * kb-shadow-wiring.spec.ts — R5 挂接层测试（镜像 anti-ai-telemetry-sink.spec 策略：
 * 全部副作用注入/mock，零真实 IO；store flag 翻转经 hoisted mock 验证恢复）。
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import {
  runKbShadowArmRetrieval,
  runKbShadowArmsIfConsented,
  defaultKbShadowDeps,
  goldenKbShadowCases,
  goldenCoverageOf,
} from "./kb-shadow-wiring"
import type { KbShadowFlags } from "./kb-shadow-collector"

const h = vi.hoisted(() => {
  const mockConsent = vi.fn<() => Promise<boolean>>()
  const state = {
    novelConfig: {
      dualKbRoutingEnabled: false,
      hardInjectEnabled: false,
      usefulnessRerankEnabled: false,
      entityBoostEnabled: true,
    } as Record<string, unknown>,
    setNovelConfig: (patch: Record<string, unknown>) => {
      state.novelConfig = { ...state.novelConfig, ...patch }
    },
    getState: () => state,
  }
  const mockFiles = new Map<string, string>()
  const mockRetrieve = vi.fn<(..._a: unknown[]) => Promise<{ hitIds: string[] }>>()
  return { mockConsent, state, mockFiles, mockRetrieve }
})

vi.mock("./anti-ai-telemetry-wiring", () => ({
  loadAntiAiTelemetryConsent: () => h.mockConsent(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: h.state,
}))

const fakeDeps = () => ({
  readFile: async (p: string) => {
    const v = h.mockFiles.get(p)
    if (v === undefined) throw new Error("ENOENT")
    return v
  },
  writeFile: async (p: string, c: string) => {
    h.mockFiles.set(p, c)
  },
  createDirectory: async () => undefined,
  listFiles: async () => [],
  now: () => new Date("2026-09-08T00:00:00.000Z"),
})

const cases = [
  { caseId: "OBL-001", query: "主角当前目标与义务覆盖实体", obligationCoverage: 0.8, scaleViolation: false },
  { caseId: "PSN-3", query: "伏笔信号检索", obligationCoverage: 0.5, scaleViolation: false },
]

beforeEach(() => {
  h.mockConsent.mockReset()
  h.mockRetrieve.mockReset()
  h.mockFiles.clear()
  h.state.novelConfig = {
    dualKbRoutingEnabled: false,
    hardInjectEnabled: false,
    usefulnessRerankEnabled: false,
    entityBoostEnabled: true,
  }
})

describe("runKbShadowArmsIfConsented — 同意门", () => {
  it("不同意（默认 false）→ skipped=true 零 IO（retrieve 与落盘均不触碰）", async () => {
    h.mockConsent.mockResolvedValue(false)
    const res = await runKbShadowArmsIfConsented(
      "E:/Proj",
      "TEST0000",
      cases,
      fakeDeps(),
      h.mockRetrieve as never,
    )
    expect(res).toEqual({ written: 0, failed: 0, skipped: true })
    expect(h.mockRetrieve).not.toHaveBeenCalled()
    expect(h.mockFiles.size).toBe(0)
  })
})

describe("runKbShadowArms — 同意开双臂双跑", () => {
  it("逐案×双臂 flags 翻转注入 + 检索后恢复 store（baseline 全关 / experiment 全开）", async () => {
    h.mockConsent.mockResolvedValue(true)
    h.mockRetrieve.mockImplementation((_query: unknown, flags: unknown) =>
      Promise.resolve({
        hitIds: (flags as KbShadowFlags).dualKbRoutingEnabled ? ["p-exp"] : ["p-base"],
      }),
    )
    const result = await runKbShadowArmsIfConsented(
      "E:/Proj",
      "TEST0000",
      cases,
      fakeDeps(),
      h.mockRetrieve as never,
    )
    expect(result).toEqual({ written: 4, failed: 0, skipped: false })
    // 4 次检索：2 case × 2 arm；flags 严格按臂
    const flagsSeq = (h.mockRetrieve.mock.calls as unknown[][]).map((c) => c[1] as KbShadowFlags)
    expect(flagsSeq).toHaveLength(4)
    expect(flagsSeq.filter((f) => f.dualKbRoutingEnabled)).toHaveLength(2)
    expect(flagsSeq.filter((f) => !f.dualKbRoutingEnabled && !f.hardInjectEnabled && !f.usefulnessRerank)).toHaveLength(2)
    // store 恢复：初始三 flag 全 false，entityBoost 未触碰
    const after = h.state.novelConfig
    expect(after.dualKbRoutingEnabled).toBe(false)
    expect(after.hardInjectEnabled).toBe(false)
    expect(after.usefulnessRerankEnabled).toBe(false)
    expect(after.entityBoostEnabled).toBe(true)
    // JSONL 落盘：每 caseId 一段；行含 caseId/arm/flags/hitIds/desensitized/status
    expect(h.mockFiles.size).toBe(2)
    for (const content of h.mockFiles.values()) {
      const lines = content.trim().split("\n")
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        const obj = JSON.parse(line)
        expect(obj.desensitized).toBe(true)
        expect(obj.status).toBe("ok")
        expect(obj.schemaVersion).toBe("qm-kb-shadow/1.0")
        expect(obj.arm).toMatch(/^baseline$|^experiment$/)
        expect(obj.flags).toMatchObject({ dualKbRoutingEnabled: obj.arm === "experiment" })
      }
    }
  })

  it("单臂检索失败 → 记 retrieval_error 行（hitIds 空 coverage null）不阻断其余", async () => {
    h.mockConsent.mockResolvedValue(true)
    h.mockRetrieve.mockImplementation((_q: unknown, flags: unknown) => {
      if (!(flags as KbShadowFlags).dualKbRoutingEnabled) throw new Error("boom")
      return Promise.resolve({ hitIds: ["p-exp"] })
    })
    const result = await runKbShadowArmsIfConsented(
      "E:/Proj",
      "TEST0000",
      cases,
      fakeDeps(),
      h.mockRetrieve as never,
    )
    expect(result.written).toBe(2)
    expect(result.failed).toBe(2)
    expect(result.skipped).toBe(false)
    const allLines = [...h.mockFiles.values()].flatMap((c) => c.trim().split("\n").map((l) => JSON.parse(l)))
    const errLines = allLines.filter((l) => l.status === "retrieval_error")
    expect(errLines).toHaveLength(2)
    for (const l of errLines) {
      expect(l.hitIds).toEqual([])
      expect(l.obligationCoverage).toBeNull()
      expect(l.scaleViolation).toBe(false)
    }
    const okLines = allLines.filter((l) => l.status === "ok")
    expect(okLines).toHaveLength(2)
  })
})

describe("runKbShadowArmRetrieval — 独立执行器", () => {
  it("快照-翻转-检索-finally 恢复（检索抛错也恢复）", async () => {
    const state = h.state
    state.novelConfig = { dualKbRoutingEnabled: true, hardInjectEnabled: true, usefulnessRerankEnabled: true }
    const seen: Array<{ query: string; flags: KbShadowFlags }> = []
    await expect(
      runKbShadowArmRetrieval(
        "q",
        { dualKbRoutingEnabled: false, hardInjectEnabled: false, usefulnessRerank: false },
        (query, flags) => {
          seen.push({ query, flags })
          expect(h.state.novelConfig.dualKbRoutingEnabled).toBe(false)
          throw new Error("mid-retrieval")
        },
      ),
    ).rejects.toThrow("mid-retrieval")
    expect(seen).toHaveLength(1)
    // 抛错后仍恢复
    expect(state.novelConfig).toEqual({
      dualKbRoutingEnabled: true,
      hardInjectEnabled: true,
      usefulnessRerankEnabled: true,
    })
  })
})

describe("runKbShadowArmsIfConsented — 串行互斥", () => {
  it("并发触发排队串行：检索期间 active ≤ 1", async () => {
    h.mockConsent.mockResolvedValue(true)
    let active = 0
    let maxActive = 0
    h.mockRetrieve.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active -= 1
      return { hitIds: ["p"] }
    })
    const single = [{ caseId: "OBL-001", query: "q", obligationCoverage: 0.8, scaleViolation: false }]
    const [a, b] = await Promise.all([
      runKbShadowArmsIfConsented("E:/Proj", "TEST0000", single, fakeDeps(), h.mockRetrieve as never),
      runKbShadowArmsIfConsented("E:/Proj", "TEST0000", single, fakeDeps(), h.mockRetrieve as never),
    ])
    expect(a.written).toBe(2)
    expect(b.written).toBe(2)
    expect(maxActive).toBe(1)
  })
})

describe("defaultKbShadowDeps", () => {
  it("镜像 fs IPC 形状（readFile/writeFile/createDirectory/now）", () => {
    const deps = defaultKbShadowDeps()
    expect(typeof deps.readFile).toBe("function")
    expect(typeof deps.writeFile).toBe("function")
    expect(typeof deps.createDirectory).toBe("function")
    expect(typeof deps.now).toBe("function")
  })
})

describe("goldenKbShadowCases（F4 golden 34 → 影子案例集）", () => {
  it("34 案例：caseId GOLDEN-01..34 递增 + minHits ≥1 + coverage 占位 null", () => {
    const cases = goldenKbShadowCases()
    expect(cases.length).toBe(34)
    expect(cases[0].caseId).toBe("GOLDEN-01")
    expect(cases[33].caseId).toBe("GOLDEN-34")
    expect(cases.every((c) => c.obligationCoverage === null && c.scaleViolation === false)).toBe(true)
    expect(cases.every((c) => c.minHits >= 1 && typeof c.query === "string" && c.query.trim() !== "")).toBe(true)
  })

  it("goldenCoverageOf：命中数对 minHits 截到 1", () => {
    expect(goldenCoverageOf({ minHits: 2 }, "baseline", ["a", "b"])).toBe(1)
    expect(goldenCoverageOf({ minHits: 2 }, "experiment", ["a"])).toBe(0.5)
    expect(goldenCoverageOf({ minHits: 0 }, "baseline", [])).toBe(0)
    expect(goldenCoverageOf({ minHits: 0 }, "baseline", ["a"])).toBe(1)
  })
})
