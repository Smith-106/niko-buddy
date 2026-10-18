import { describe, expect, it } from "vitest"
import {
  buildDeepChapterRouteRuntime,
  computeStepDigest,
  resolveAntiAiMode,
  resolveNextStageViaRoute,
  resolveRoleModel,
  resolveDeepChapterRoleConfigs,
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
  it("resolveRoleModel 默认全角色单模型 = 写作模型（A-35 位级等价，未配置角色模型时不新建对象）", () => {
    const writingConfig = { model: "m1" } as any
    expect(resolveRoleModel("writer", { writingConfig })).toBe(writingConfig)
    expect(resolveRoleModel("reviewer", { writingConfig })).toBe(writingConfig)
    expect(resolveRoleModel(undefined, { writingConfig })).toBe(writingConfig)
    // 项目配置存在但角色模型字段全空：仍是写作模型本体
    const emptyNovelConfig = { writingModel: "", reviewModel: "", summaryModel: "", extractModel: "" } as any
    expect(resolveRoleModel("reviewer", { writingConfig, novelConfig: emptyNovelConfig })).toBe(writingConfig)
    expect(resolveRoleModel("judge", { writingConfig, novelConfig: emptyNovelConfig })).toBe(writingConfig)
    // writingModel 显式等于会话模型：仍不新增对象
    expect(resolveRoleModel("writer", { writingConfig, novelConfig: { writingModel: "m1" } as any })).toBe(writingConfig)
  })

  it("resolveRoleModel 接真实 per-role 模型：reviewer/arbiter/judge 取 reviewModel（不再恒等于写作模型）", () => {
    const writingConfig = { model: "session-model" } as any
    const novelConfig = { reviewModel: "review-model", writingModel: "" } as any

    for (const role of ["reviewer", "arbiter", "judge"] as const) {
      const resolved = resolveRoleModel(role, { writingConfig, novelConfig })
      expect(resolved.model).toBe("review-model")
      // provider/apiKey 等其余字段沿用会话配置，不凭空发明 provider
      expect(resolved).toMatchObject({ model: "review-model" })
      expect(resolved).not.toBe(writingConfig)
    }
    // writer/architect/editor 仍走写作侧（writingModel 未配置 → 会话模型）
    expect(resolveRoleModel("writer", { writingConfig, novelConfig })).toBe(writingConfig)
    expect(resolveRoleModel("architect", { writingConfig, novelConfig })).toBe(writingConfig)
    expect(resolveRoleModel("editor", { writingConfig, novelConfig })).toBe(writingConfig)
  })

  it("resolveRoleModel 支持 providerId/modelId 形式的角色模型（按 providerConfigs 解析）", () => {
    const writingConfig = { model: "session-model", provider: "custom" } as any
    const novelConfig = { reviewModel: "xai/grok-4.7" } as any
    const providerConfigs = {
      xai: {
        apiKey: "k",
        baseUrl: "https://api.x.ai/v1",
        savedModels: [{ model: "grok-4.7" }],
      },
    } as any
    const resolved = resolveRoleModel("judge", { writingConfig, novelConfig, providerConfigs })
    expect(resolved.model).toBe("grok-4.7")
  })

  it("resolveDeepChapterRoleConfigs 导出六个 route 角色绑定快照", () => {
    const writingConfig = { model: "session-model" } as any
    const novelConfig = { reviewModel: "review-model" } as any
    const map = resolveDeepChapterRoleConfigs({ writingConfig, novelConfig })
    expect(map.writer).toBe(writingConfig)
    expect(map.architect).toBe(writingConfig)
    expect(map.editor).toBe(writingConfig)
    expect(map.reviewer.model).toBe("review-model")
    expect(map.arbiter.model).toBe("review-model")
    expect(map.judge.model).toBe("review-model")

    // 无配置时六角色同一对象（默认行为不变）
    const defaults = resolveDeepChapterRoleConfigs({ writingConfig })
    expect(new Set(Object.values(defaults)).size).toBe(1)
    expect(defaults.reviewer).toBe(writingConfig)
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

  it("#42 集成：authoritative 输入经归一激活 route 分支（与 route 档等价、非 legacy-null）", () => {
    const cfg = baseNovelConfig()
    const viaAlias = baseInput({ routeShellMode: "authoritative" })
    const viaRoute = baseInput({ routeShellMode: "route" })
    const rtAlias = buildDeepChapterRouteRuntime(viaAlias, undefined, cfg)
    const rtRoute = buildDeepChapterRouteRuntime(viaRoute, undefined, cfg)
    const outAlias = resolveNextStageViaRoute(viaAlias, cfg, rtAlias)
    expect(outAlias).not.toBeNull() // 归一前此处恒为 null（静默回退）
    expect(outAlias).toEqual(resolveNextStageViaRoute(viaRoute, cfg, rtRoute))
  })

  it("#42 值归一：authoritative 别名归一为 route（不再静默回退 legacy）", () => {
    const cfg = baseNovelConfig()
    // input 侧
    expect(resolveRouteShellMode(baseInput({ routeShellMode: "authoritative" }), cfg)).toBe("route")
    // novelConfig 侧（项目级隔离）
    expect(resolveRouteShellMode(baseInput(), baseNovelConfig({ routeShellMode: "authoritative" }))).toBe("route")
    // input 优先级在归一前生效
    expect(resolveRouteShellMode(baseInput({ routeShellMode: "legacy" }), baseNovelConfig({ routeShellMode: "authoritative" }))).toBe("legacy")
    // 未知自定义值仍保持原样透传（由激活判定回退 legacy，行为不变）
    expect(resolveRouteShellMode(baseInput({ routeShellMode: "custom-x" as never }), cfg)).toBe("custom-x")
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
