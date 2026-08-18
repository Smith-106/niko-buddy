import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createAvoidAiMechanicalSlopHook,
  createCedSoftReportHook,
  createDeAiDualPassHook,
  createGoldScaleReadinessHook,
  createStatisticalAiSignatureHook,
  getNovelSkillHookRegistry,
  listNovelSkillHooksForStage,
  registerNovelSkillHook,
  runNovelSkillHooks,
  setNovelSkillHookRegistry,
} from "./novel-skill-hooks"

/**
 * 动态 import 的支撑模块全部 mock，成功/失败路径可控：
 * - 成功路径（mock 默认值）覆盖主流程
 * - mockImplementationOnce(throw) 覆盖各 soft-fail catch 分支
 */
const moduleMocks = vi.hoisted(() => ({
  slopScore: vi.fn(),
  classifySlop: vi.fn(),
  slopReportToText: vi.fn(),
  analyzeAvoidAiPatterns: vi.fn(),
  formatAvoidAiPatternsSummary: vi.fn(),
  formatAvoidAiPatternsPromptFragment: vi.fn(),
  computeCedReport: vi.fn(),
  formatCedReportPromptFragment: vi.fn(),
  runDeAiDualPass: vi.fn(),
  formatDualPassSummary: vi.fn(),
  scoreStatisticalAiSignature: vi.fn(),
  formatStatisticalAiSignatureFragment: vi.fn(),
}))

vi.mock("./mechanical-slop-detector", () => ({
  slopScore: moduleMocks.slopScore,
  classifySlop: moduleMocks.classifySlop,
  slopReportToText: moduleMocks.slopReportToText,
}))

vi.mock("./avoid-ai-patterns", () => ({
  analyzeAvoidAiPatterns: moduleMocks.analyzeAvoidAiPatterns,
  formatAvoidAiPatternsSummary: moduleMocks.formatAvoidAiPatternsSummary,
  formatAvoidAiPatternsPromptFragment: moduleMocks.formatAvoidAiPatternsPromptFragment,
}))

vi.mock("./ced-report", () => ({
  computeCedReport: moduleMocks.computeCedReport,
  formatCedReportPromptFragment: moduleMocks.formatCedReportPromptFragment,
}))

vi.mock("./de-ai-dual-pass", () => ({
  runDeAiDualPass: moduleMocks.runDeAiDualPass,
  formatDualPassSummary: moduleMocks.formatDualPassSummary,
}))

vi.mock("./statistical-ai-signature", () => ({
  scoreStatisticalAiSignature: moduleMocks.scoreStatisticalAiSignature,
  formatStatisticalAiSignatureFragment: moduleMocks.formatStatisticalAiSignatureFragment,
}))

describe("novel-skill-hooks", () => {
  beforeEach(() => {
    for (const mock of Object.values(moduleMocks)) mock.mockReset()
    // 默认成功路径
    moduleMocks.slopScore.mockReturnValue({ slopPenalty: 1.2, matches: [] })
    moduleMocks.classifySlop.mockReturnValue("slop")
    moduleMocks.slopReportToText.mockReturnValue("高密度 AI 套话")
    moduleMocks.analyzeAvoidAiPatterns.mockReturnValue({ total: 1 })
    moduleMocks.formatAvoidAiPatternsSummary.mockReturnValue("patterns summary")
    moduleMocks.formatAvoidAiPatternsPromptFragment.mockReturnValue("patterns frag")
    moduleMocks.computeCedReport.mockReturnValue({ summaryLine: "CED soft density 1.2/1k", density: 1.2 })
    moduleMocks.formatCedReportPromptFragment.mockReturnValue("ced frag")
    moduleMocks.runDeAiDualPass.mockReturnValue({ pass2: { promptFragment: "de-ai frag" } })
    moduleMocks.formatDualPassSummary.mockReturnValue("dual-pass summary")
    moduleMocks.scoreStatisticalAiSignature.mockReturnValue({ score0to1: 0.42, band: "low" })
    moduleMocks.formatStatisticalAiSignatureFragment.mockReturnValue("sig frag")
  })

  afterEach(() => {
    setNovelSkillHookRegistry(null)
  })

  it("default registry is empty", () => {
    expect(getNovelSkillHookRegistry().hooks).toEqual([])
    expect(listNovelSkillHooksForStage("pre_write_prompt")).toEqual([])
  })

  it("register and run Track B hook", async () => {
    registerNovelSkillHook({
      id: "test.frag",
      title: "t",
      stages: ["pre_write_prompt"],
      track: "B",
      run: (ctx) => {
        ctx.bag.promptFragments.push("HELLO")
      },
    })
    const ctx = await runNovelSkillHooks("pre_write_prompt", { projectPath: "/p", chapterNumber: 4 })
    expect(ctx.bag.promptFragments).toContain("HELLO")
    expect(ctx.chapterNumber).toBe(4)
  })

  it("rejects non-B track", () => {
    expect(() =>
      registerNovelSkillHook({
        id: "bad",
        title: "bad",
        stages: ["pre_write_prompt"],
        track: "A" as "B",
        run: () => {},
      }),
    ).toThrow(/Track B/)
  })

  it("re-registering the same id replaces the old hook (dedup)", () => {
    registerNovelSkillHook({ id: "dup", title: "v1", stages: ["pre_write_prompt"], track: "B", run: () => {} })
    registerNovelSkillHook({ id: "dup", title: "v2", stages: ["pre_write_prompt"], track: "B", run: () => {} })
    const registry = getNovelSkillHookRegistry()
    expect(registry.hooks.filter((h) => h.id === "dup")).toHaveLength(1)
    expect(registry.hooks.find((h) => h.id === "dup")?.title).toBe("v2")
  })

  it("disables hooks via enabled:false", async () => {
    registerNovelSkillHook({
      id: "off",
      title: "off",
      stages: ["pre_write_prompt"],
      track: "B",
      enabled: false,
      run: (ctx) => {
        ctx.bag.promptFragments.push("SHOULD-NOT-APPEAR")
      },
    })
    const ctx = await runNovelSkillHooks("pre_write_prompt", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(listNovelSkillHooksForStage("pre_write_prompt")).toEqual([])
  })

  it("soft-fails hook errors (Error instance)", async () => {
    registerNovelSkillHook({
      id: "boom",
      title: "boom",
      stages: ["post_draft_light_check"],
      track: "B",
      run: () => {
        throw new Error("nope")
      },
    })
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("boom"))).toBe(true)
    expect(ctx.bag.notes.some((n) => n.includes("nope"))).toBe(true)
  })

  it("soft-fails non-Error hook failures (String coercion)", async () => {
    registerNovelSkillHook({
      id: "boom-str",
      title: "boom-str",
      stages: ["post_draft_light_check"],
      track: "B",
      run: () => {
        throw "plain failure"
      },
    })
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("plain failure"))).toBe(true)
  })

  it("honors caller-provided bag (no default allocation)", async () => {
    registerNovelSkillHook({
      id: "bag",
      title: "bag",
      stages: ["pre_write_prompt"],
      track: "B",
      run: (ctx) => {
        ctx.bag.promptFragments.push("X")
      },
    })
    const ctx = await runNovelSkillHooks("pre_write_prompt", {
      projectPath: "/p",
      bag: { promptFragments: ["existing"], notes: ["note0"] },
    })
    expect(ctx.bag.promptFragments).toEqual(["existing", "X"])
    expect(ctx.bag.notes).toEqual(["note0"])
  })

  it("gold scale readiness hook injects fragment", async () => {
    registerNovelSkillHook(createGoldScaleReadinessHook("金标未就绪"))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.promptFragments.join("")).toContain("金标")
    expect(ctx.bag.notes).toContain("gold-scale readiness injected")
  })

  it("gold scale readiness hook no-ops on blank hint", async () => {
    registerNovelSkillHook(createGoldScaleReadinessHook("   "))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(ctx.bag.notes).toEqual([])
  })

  it("ced soft report hook notes density and pushes fragment", async () => {
    registerNovelSkillHook(
      createCedSoftReportHook({
        findings: [],
        textForWordCount: "她打开了门。",
        styleIssueCount: 2,
      }),
    )
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(moduleMocks.computeCedReport).toHaveBeenCalledWith({
      findings: [],
      textForWordCount: "她打开了门。",
      styleIssueCount: 2,
    })
    expect(ctx.bag.notes).toContain("CED soft density 1.2/1k")
    expect(ctx.bag.promptFragments).toContain("ced frag")
  })

  it("ced soft report hook skips empty prompt fragment", async () => {
    moduleMocks.formatCedReportPromptFragment.mockReturnValue("")
    registerNovelSkillHook(createCedSoftReportHook({ findings: [], textForWordCount: "x" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(ctx.bag.notes).toContain("CED soft density 1.2/1k")
    // findings 缺省 → ?? []
    expect(moduleMocks.computeCedReport).toHaveBeenCalledWith(
      expect.objectContaining({ findings: [] }),
    )
  })

  it("ced soft report hook soft-fails when compute throws", async () => {
    moduleMocks.computeCedReport.mockImplementationOnce(() => {
      throw new Error("ced boom")
    })
    registerNovelSkillHook(createCedSoftReportHook({ findings: [] }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("ced soft report failed") && n.includes("ced boom"))).toBe(true)
  })

  it("ced soft report hook soft-fails on non-Error throws (String coercion)", async () => {
    moduleMocks.computeCedReport.mockImplementationOnce(() => {
      throw "string ced boom"
    })
    registerNovelSkillHook(createCedSoftReportHook({ findings: [] }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("string ced boom"))).toBe(true)
  })

  it("avoid-ai mechanical slop hook is Track B and soft-injects on sloppy text", async () => {
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "然而，总而言之，他陷入沉思。" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("avoid-ai slop"))).toBe(true)
    expect(ctx.bag.notes.some((n) => n.includes("not product hard gate"))).toBe(true)
    expect(ctx.bag.promptFragments.some((f) => f.includes("slopVerdict=slop"))).toBe(true)
    // includeFullPatterns 默认 true → patterns 摘要 + fragment
    expect(ctx.bag.notes).toContain("patterns summary")
    expect(ctx.bag.promptFragments).toContain("patterns frag")
  })

  it("avoid-ai hook skips empty text without throwing", async () => {
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("skipped"))).toBe(true)
    expect(moduleMocks.slopScore).not.toHaveBeenCalled()
  })

  it("avoid-ai hook records clean verdict without fragment", async () => {
    moduleMocks.classifySlop.mockReturnValueOnce("clean")
    moduleMocks.slopReportToText.mockReturnValueOnce("")
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "正文内容" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("clean (no fragment)"))).toBe(true)
  })

  it("avoid-ai hook falls through silently when report text is empty and verdict is not clean", async () => {
    moduleMocks.classifySlop.mockReturnValueOnce("slop-heavy")
    moduleMocks.slopReportToText.mockReturnValueOnce("")
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "正文", includeFullPatterns: false }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(ctx.bag.notes.some((n) => n.includes("clean (no fragment)"))).toBe(false)
    expect(ctx.bag.notes.some((n) => n.includes("avoid-ai slop"))).toBe(true)
  })

  it("avoid-ai hook skips full patterns when includeFullPatterns=false", async () => {
    registerNovelSkillHook(
      createAvoidAiMechanicalSlopHook({ text: "正文", includeFullPatterns: false }),
    )
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(moduleMocks.analyzeAvoidAiPatterns).not.toHaveBeenCalled()
    expect(ctx.bag.promptFragments.some((f) => f.includes("slopVerdict"))).toBe(true)
  })

  it("avoid-ai hook soft-fails patterns engine without breaking slop result", async () => {
    moduleMocks.analyzeAvoidAiPatterns.mockImplementationOnce(() => {
      throw new Error("patterns boom")
    })
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("avoid-ai full patterns soft-failed") && n.includes("patterns boom"))).toBe(true)
    expect(ctx.bag.notes.some((n) => n.includes("avoid-ai slop"))).toBe(true)
  })

  it("avoid-ai hook soft-fails patterns engine on non-Error throws", async () => {
    moduleMocks.analyzeAvoidAiPatterns.mockImplementationOnce(() => {
      throw "string patterns boom"
    })
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("string patterns boom"))).toBe(true)
  })

  it("de-ai dual-pass hook pushes summary + pass2 fragment", async () => {
    registerNovelSkillHook(createDeAiDualPassHook({ text: "正文样本", baselineScores: [0.5] }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(moduleMocks.runDeAiDualPass).toHaveBeenCalledWith("正文样本", { baselineScores: [0.5] })
    expect(ctx.bag.notes).toContain("dual-pass summary")
    expect(ctx.bag.promptFragments).toContain("de-ai frag")
  })

  it("de-ai dual-pass hook skips empty text", async () => {
    registerNovelSkillHook(createDeAiDualPassHook({ text: "" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("de-ai dual-pass: skipped"))).toBe(true)
    expect(moduleMocks.runDeAiDualPass).not.toHaveBeenCalled()
  })

  it("de-ai dual-pass hook soft-fails on engine throw", async () => {
    moduleMocks.runDeAiDualPass.mockImplementationOnce(() => {
      throw "string boom"
    })
    registerNovelSkillHook(createDeAiDualPassHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("de-ai dual-pass soft-failed") && n.includes("string boom"))).toBe(true)
  })

  it("de-ai dual-pass hook soft-fails on Error throws", async () => {
    moduleMocks.runDeAiDualPass.mockImplementationOnce(() => {
      throw new Error("error boom")
    })
    registerNovelSkillHook(createDeAiDualPassHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("de-ai dual-pass soft-failed") && n.includes("error boom"))).toBe(true)
  })

  it("de-ai dual-pass hook skips empty pass2 fragment", async () => {
    moduleMocks.runDeAiDualPass.mockReturnValueOnce({ pass2: { promptFragment: "   " } })
    registerNovelSkillHook(createDeAiDualPassHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(ctx.bag.notes).toContain("dual-pass summary")
  })

  it("statistical-ai-signature hook pushes score note + fragment", async () => {
    registerNovelSkillHook(createStatisticalAiSignatureHook({ text: "正文样本" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("statistical-ai-signature: score=0.420 band=low"))).toBe(true)
    expect(ctx.bag.promptFragments).toContain("sig frag")
  })

  it("statistical-ai-signature hook skips empty text", async () => {
    registerNovelSkillHook(createStatisticalAiSignatureHook({ text: "" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("statistical-ai-signature: skipped"))).toBe(true)
    expect(moduleMocks.scoreStatisticalAiSignature).not.toHaveBeenCalled()
  })

  it("statistical-ai-signature hook soft-fails on engine throw", async () => {
    moduleMocks.scoreStatisticalAiSignature.mockImplementationOnce(() => {
      throw new Error("sig boom")
    })
    registerNovelSkillHook(createStatisticalAiSignatureHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("statistical-ai-signature soft-failed") && n.includes("sig boom"))).toBe(true)
  })

  it("statistical-ai-signature hook soft-fails on non-Error throws", async () => {
    moduleMocks.scoreStatisticalAiSignature.mockImplementationOnce(() => {
      throw "string sig boom"
    })
    registerNovelSkillHook(createStatisticalAiSignatureHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("string sig boom"))).toBe(true)
  })

  it("statistical-ai-signature hook skips empty fragment", async () => {
    moduleMocks.formatStatisticalAiSignatureFragment.mockReturnValueOnce("")
    registerNovelSkillHook(createStatisticalAiSignatureHook({ text: "正文" }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.promptFragments).toEqual([])
    expect(ctx.bag.notes.some((n) => n.includes("statistical-ai-signature: score"))).toBe(true)
  })
})
