import { describe, expect, it } from "vitest"
import {
  buildDeepChapterRouteRuntime,
  computeStepDigest,
  resolveAntiAiMode,
  resolveNextStageViaRoute,
  resolveRoleModel,
  resolveRouteShellMode,
} from "./deep-chapter-generation"

// 最小可构造输入（回避 store 依赖，仅覆盖 T10 薄编排化纯函数路径）。
function baseInput(overrides: Record<string, unknown> = {}): any {
  return {
    projectPath: "/p",
    userRequest: "写第1章",
    chapterNumber: 1,
    llmConfig: {},
    novelConfig: { deepChapterReview: true },
    ...overrides,
  }
}

function baseNovelConfig(overrides: Record<string, unknown> = {}): any {
  return { deepChapterReview: true, ...overrides }
}

describe("T10 薄编排化：route() 接入 + T09 字段 + role→model 解析点", () => {
  it("resolveRoleModel 默认全角色单模型 = 写作模型（A-35 位级等价，0 重构预留点）", () => {
    const writingConfig = { model: "m1" } as any
    expect(resolveRoleModel("writer", { writingConfig })).toBe(writingConfig)
    expect(resolveRoleModel("reviewer", { writingConfig })).toBe(writingConfig)
    expect(resolveRoleModel(undefined, { writingConfig })).toBe(writingConfig)
  })

  it("resolveRouteShellMode 缺省 legacy（字节级等价旧行为）", () => {
    const cfg = baseNovelConfig()
    expect(resolveRouteShellMode(baseInput(), cfg)).toBe("legacy")
    expect(resolveRouteShellMode(baseInput({ routeShellMode: "route" }), cfg)).toBe("route")
    // novelConfig 上的 T09 字段也可被读取（项目级隔离）。
    expect(resolveRouteShellMode(baseInput(), baseNovelConfig({ routeShellMode: "route" }))).toBe("route")
    // input 优先于 novelConfig。
    expect(resolveRouteShellMode(baseInput({ routeShellMode: "legacy" }), baseNovelConfig({ routeShellMode: "route" }))).toBe("legacy")
  })

  it("resolveAntiAiMode 缺省 off（现状：anti_ai 失败即挡）", () => {
    const cfg = baseNovelConfig()
    expect(resolveAntiAiMode(baseInput(), cfg)).toBe("off")
    expect(resolveAntiAiMode(baseInput({ antiAiMode: "block" }), cfg)).toBe("block")
    expect(resolveAntiAiMode(baseInput({ antiAiMode: "warn" }), cfg)).toBe("warn")
  })

  it("resolveNextStageViaRoute 缺省 legacy → null（既有顺序流水线不变）", () => {
    const input = baseInput()
    const cfg = baseNovelConfig()
    const runtime = buildDeepChapterRouteRuntime(input, undefined, cfg)
    expect(resolveNextStageViaRoute(input, cfg, runtime)).toBeNull()
  })

  it("buildDeepChapterRouteRuntime 将恢复检查点 resume stage 映射为 route() RouteStage", () => {
    const cfg = baseNovelConfig()
    const noCp = buildDeepChapterRouteRuntime(baseInput(), undefined, cfg)
    expect(noCp.stage).toBe("context")
    const withCp = buildDeepChapterRouteRuntime(
      baseInput(),
      {
        version: 1,
        originalRequest: "x",
        stage: "after_review",
        decisionGates: {
          consistency: { status: "failed", verdict: "fail", findings: [], repair_suggestions: [], retry_count: 0 },
          anti_ai: { status: "passed", verdict: "pass", findings: [], repair_suggestions: [], retry_count: 0 },
          quality: { status: "pending", verdict: "pending", findings: [], repair_suggestions: [], retry_count: 0 },
          overall: "fail",
        },
        manualReviewRequired: true,
      } as any,
      cfg,
    )
    expect(withCp.stage).toBe("review")
    expect(withCp.antiAiMode).toBe("off")
    expect(withCp.manualReviewRequired).toBe(true)
    expect(withCp.gates).toEqual({ consistency: "fail", anti_ai: "pass", quality: "pending" })
  })

  it("computeStepDigest 同输入恒定同 digest（T07 幂等键）", async () => {
    const a = await computeStepDigest("context", { chapter: 1 })
    const b = await computeStepDigest("context", { chapter: 1 })
    const c = await computeStepDigest("context", { chapter: 2 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
