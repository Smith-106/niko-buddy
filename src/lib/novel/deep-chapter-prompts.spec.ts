import { describe, expect, it } from "vitest"
import {
  DEEP_CHAPTER_DRAFT_MAX_CHARS,
  DEEP_CHAPTER_MAX_OUTPUT_TOKENS,
  DEEP_CHAPTER_MIN_CHARS,
  DEEP_CHAPTER_TARGET_CHARS,
  PLAN_BLUEPRINT_MAX_CHARS,
  STAGE_PROMPT_SCAFFOLD_TOKENS,
  appendTaskExtraSection,
  buildDeepChapterBriefPrompt,
  buildDeepChapterDraftPrompt,
  buildDeepChapterExpansionPrompt,
  buildDeepChapterFinalPolishPrompt,
  buildDeepChapterLengthRewritePrompt,
  buildDeepChapterRevisionPrompt,
  countCodePoints,
  fitStagePromptToWindow,
  planBlueprintSection,
  resolveChapterLengthSpec,
  truncateToCodePoints,
} from "./deep-chapter-prompts"
import type { StagePromptBudgetInput } from "./deep-chapter-prompts"
import { PER_MESSAGE_TOKEN_OVERHEAD, estimateTokens } from "@/lib/token-estimator"
import type { NovelReviewResult } from "./review-adapter"
import { createDefaultStore, createPreference } from "@/lib/user-memory/types"

describe("resolveChapterLengthSpec", () => {
  it("keeps the built-in defaults when no target is configured", () => {
    const spec = resolveChapterLengthSpec()

    expect(spec.targetChars).toBe(DEEP_CHAPTER_TARGET_CHARS)
    expect(spec.minChars).toBe(DEEP_CHAPTER_MIN_CHARS)
    expect(spec.draftMaxChars).toBe(DEEP_CHAPTER_DRAFT_MAX_CHARS)
    expect(spec.maxOutputTokens).toBe(DEEP_CHAPTER_MAX_OUTPUT_TOKENS)
  })

  it("derives all thresholds from a configured chapter target (issue #8)", () => {
    const spec = resolveChapterLengthSpec(2000)

    expect(spec.targetChars).toBe(2000)
    expect(spec.minChars).toBeLessThan(2000)
    expect(spec.minChars).toBeGreaterThan(1000)
    expect(spec.draftMaxChars).toBe(2500)
  })

  it("scales output token budget up for long chapters", () => {
    const spec = resolveChapterLengthSpec(6000)

    expect(spec.maxOutputTokens).toBeGreaterThan(DEEP_CHAPTER_MAX_OUTPUT_TOKENS)
  })

  it("clamps unreasonable targets", () => {
    expect(resolveChapterLengthSpec(10).targetChars).toBe(500)
    expect(resolveChapterLengthSpec(999999).targetChars).toBe(20000)
  })
})

describe("chapter prompts honor the configured length spec", () => {
  it("injects the configured target into brief and draft prompts", () => {
    const spec = resolveChapterLengthSpec(2000)
    const brief = buildDeepChapterBriefPrompt("", "context", "continue writing next chapter", 5, undefined, spec)
    const draft = buildDeepChapterDraftPrompt("", "context", "task brief", "continue writing next chapter", 5, undefined, spec)

    expect(brief).toContain("[TASK_BRIEF_MARKER]")
    expect(draft).toContain("[DRAFT_STAGE_MARKER]")
    expect(brief).toContain("2000")
    expect(draft).toContain("2000")
    expect(draft).toContain(String(spec.draftMaxChars))
    expect(draft).not.toContain(String(DEEP_CHAPTER_TARGET_CHARS))
  })
})

describe("autoGenerateChapterTitle 开关（RV-001：恒 true → novelConfig 真值）", () => {
  it("四个生产阶段提示词都按开关切换标题要求", () => {
    const draftOff = buildDeepChapterDraftPrompt("o", "ctx", "brief", "user", 3, undefined, undefined, undefined, false)
    expect(draftOff).toContain("2. 不要输出章节标题。")
    expect(draftOff).not.toContain("正文第一行必须是章节标题")

    const revisionOff = buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", [], "user", 3, undefined, undefined, false)
    expect(revisionOff).toContain("2. 不要输出章节标题。")

    const expansionOff = buildDeepChapterExpansionPrompt("o", "ctx", "brief", "过短", "user", 3, undefined, undefined, undefined, false)
    expect(expansionOff).toContain("2. 不要输出章节标题。")

    const polishOff = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, undefined, undefined, undefined, false)
    expect(polishOff).toContain("6. 不要输出章节标题。")
  })

  it("开关缺省时保持原有标题要求（向后兼容）", () => {
    const draft = buildDeepChapterDraftPrompt("o", "ctx", "brief", "user", 3)
    expect(draft).toContain("2. 正文第一行必须是章节标题")
    const polish = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3)
    expect(polish).toContain("6. 正文第一行必须是章节标题")
  })
})

describe("prompt builders fallback branches (w3nb 补齐)", () => {
  it("length-rewrite prompt honors autoGenerateChapterTitle true/false and chapter number", () => {
    const withTitle = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7, undefined, {
      autoGenerateChapterTitle: true,
    })
    expect(withTitle).toContain("2. 正文第一行必须是章节标题")

    const noTitle = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7, undefined, {
      autoGenerateChapterTitle: false,
    })
    expect(noTitle).toContain("2. 不要输出章节标题。")

    // 缺省 options → autoGenerateChapterTitle 默认 true
    const defaulted = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7)
    expect(defaulted).toContain("2. 正文第一行必须是章节标题")

    const withChapter = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user", 7)
    expect(withChapter).toContain("目标章节：第7章")
    expect(withChapter).toContain("TARGET_CHAPTER_NUMBER: 7")

    const noChapter = buildDeepChapterLengthRewritePrompt("ctx", "brief", "正文", "user")
    expect(noChapter).toContain("目标章节：用户请求中的章节")
    expect(noChapter).not.toContain("TARGET_CHAPTER_NUMBER")
  })

  it("final polish prompt picks custom de-AI skill when provided, falls back otherwise", () => {
    const custom = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "  自定义去AI味规则  ")
    expect(custom).toContain("自定义去AI味规则")
    expect(custom).not.toContain("中文小说去 AI 味补充规则")

    const fallback = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "")
    expect(fallback).toContain("中文小说去 AI 味补充规则")
  })

  it("final polish prompt uses user-aware de-AI rules when store has weights", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "deai_boost:词汇", value: "2.0", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("用户个性化")
    expect(prompt).not.toContain("中文小说去 AI 味补充规则")
  })

  it("54 ⑧: genre 注入——传入流派时附加结构化规则片段, 缺省零变更", () => {
    const withGenre = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, undefined, "玄幻")
    expect(withGenre).toContain("中文小说去 AI 味语义层规则 (结构化)")
    expect(withGenre).toContain("流派基线: 玄幻")
    expect(withGenre).toContain("节奏: fast")
    // 未知流派 → 无基线行但规则矩阵仍在
    const unknown = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, undefined, "未知流派")
    expect(unknown).toContain("中文小说去 AI 味语义层规则 (结构化)")
    expect(unknown).not.toContain("流派基线:")
    // 缺省 → 与旧行为一致 (无结构化片段)
    const plain = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3)
    expect(plain).not.toContain("中文小说去 AI 味语义层规则 (结构化)")
  })

  it("final polish prompt includes user avoid words section", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "avoid_words", value: "仿佛、不禁", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("用户避用词")
    expect(prompt).toContain("仿佛、不禁")
  })

  it("final polish prompt falls back to built-in rules when store has no weights", () => {
    const store = createDefaultStore()
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, undefined, store)
    expect(prompt).toContain("中文小说去 AI 味补充规则")
    expect(prompt).not.toContain("用户个性化")
  })

  it("final polish prompt prefers custom skill over user store", () => {
    const store = createDefaultStore()
    store.preferences.push(
      createPreference({ key: "deai_boost:词汇", value: "2.0", category: "vocabulary" }),
    )
    const prompt = buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user", 3, undefined, "自定义规则", store)
    expect(prompt).toContain("自定义规则")
    expect(prompt).not.toContain("用户个性化")
  })

  it("revision prompt renders review issues incl. evidence/relatedMemory/suggestion", () => {
    const issues: NovelReviewResult[] = [
      {
        severity: "error",
        type: "continuity",
        message: "开头节奏慢",
        evidence: "第3段",
        relatedMemory: "上章钩子",
        suggestion: "压缩环境描写",
      },
      {
        severity: "warning",
        type: "style",
        message: "轻微解释腔",
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      },
    ]
    const prompt = buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", issues, "user", 3)
    expect(prompt).toContain("1. [error] 开头节奏慢")
    expect(prompt).toContain("证据：第3段")
    expect(prompt).toContain("相关记忆：上章钩子")
    expect(prompt).toContain("建议：压缩环境描写")
    expect(prompt).toContain("2. [warning] 轻微解释腔")
  })

  it("revision prompt with empty review issues reports 未发现问题", () => {
    const prompt = buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", [], "user", 3)
    expect(prompt).toContain("未发现问题。")
  })

  it("all stage builders fall back to the generic target line when chapterNumber is missing", () => {
    const prompts = [
      buildDeepChapterBriefPrompt("o", "ctx", "user"),
      buildDeepChapterDraftPrompt("o", "ctx", "brief", "user"),
      buildDeepChapterRevisionPrompt("o", "ctx", "brief", "草稿", [], "user"),
      buildDeepChapterExpansionPrompt("o", "ctx", "brief", "正文", "user"),
      buildDeepChapterFinalPolishPrompt("o", "ctx", "brief", "正文", "user"),
    ]
    for (const p of prompts) {
      expect(p).toContain("目标章节：用户请求中的章节")
      expect(p).not.toContain("TARGET_CHAPTER_NUMBER")
    }
  })
})

describe("countCodePoints：按用户眼里的「字」计数", () => {
  it("空串为 0", () => {
    expect(countCodePoints("")).toBe(0)
  })

  it("BMP 字符按码元计数", () => {
    expect(countCodePoints("abc")).toBe(3)
    expect(countCodePoints("汉字")).toBe(2)
  })

  it("emoji 这类代理对只记 1 个字，不按 UTF-16 码元算 2 个", () => {
    expect(countCodePoints("😀")).toBe(1)
    expect(countCodePoints("😀😀")).toBe(2)
    expect(countCodePoints("a😀b")).toBe(3)
  })

  it("孤立代理不吞字：单个低代理、单个高代理都记 1", () => {
    expect(countCodePoints("\uDC00")).toBe(1)
    expect(countCodePoints("\uD83D")).toBe(1)
  })
})

describe("truncateToCodePoints：绝不切坏代理对", () => {
  it("空串返回空串", () => {
    expect(truncateToCodePoints("", 10)).toBe("")
  })

  it("上限非有限数时原样返回", () => {
    expect(truncateToCodePoints("abcdef", Number.POSITIVE_INFINITY)).toBe("abcdef")
    expect(truncateToCodePoints("abcdef", Number.NaN)).toBe("abcdef")
  })

  it("上限为 0 或负数时返回空串", () => {
    expect(truncateToCodePoints("abcdef", 0)).toBe("")
    expect(truncateToCodePoints("abcdef", -3)).toBe("")
  })

  it("长度未超限时走快路径原样返回", () => {
    expect(truncateToCodePoints("abc", 3)).toBe("abc")
    expect(truncateToCodePoints("abc", 10)).toBe("abc")
  })

  it("按码点截断，emoji 整字保留不切半", () => {
    expect(truncateToCodePoints("😀😀😀", 2)).toBe("😀😀")
    expect(truncateToCodePoints("a😀b", 2)).toBe("a😀")
  })

  it("小数上限向下取整", () => {
    expect(truncateToCodePoints("abcdef", 2.9)).toBe("ab")
  })

  it("截断结果里不含孤立代理（可安全进 JSON）", () => {
    const out = truncateToCodePoints("a😀😀", 2)
    for (let i = 0; i < out.length; i += 1) {
      const code = out.charCodeAt(i)
      const isHigh = code >= 0xd800 && code <= 0xdbff
      if (!isHigh) continue
      const next = out.charCodeAt(i + 1)
      expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
    }
  })
})

describe("planBlueprintSection：来源口径与截断语义分层", () => {
  const plan = "第一节拍：主角入城。\n第二节拍：与旧识重逢。"

  it("缺省或纯空白返回空串，由调用方 filter(Boolean) 剔除", () => {
    expect(planBlueprintSection()).toBe("")
    expect(planBlueprintSection("")).toBe("")
    expect(planBlueprintSection("   \n\t ")).toBe("")
  })

  it("未截断 + user：强口径「必须原样执行」", () => {
    const out = planBlueprintSection(plan, 20000, "user")
    expect(out).toContain("【章节计划原文】")
    expect(out).toContain("必须原样执行")
    expect(out).not.toContain("未经用户确认")
  })

  it("未截断 + 缺省来源：中性口径，不冒充用户确认", () => {
    const out = planBlueprintSection(plan)
    expect(out).toContain("【章节计划参考】")
    expect(out).toContain("未经用户确认")
    expect(out).not.toContain("必须原样执行")
  })

  it("maxChars 显式 0 表示整段省略", () => {
    expect(planBlueprintSection(plan, 0)).toBe("")
  })

  it("maxChars 非有限数或负数时回退到默认上限（此处不触发截断）", () => {
    expect(planBlueprintSection(plan, Number.NaN, "user")).toContain("必须原样执行")
    expect(planBlueprintSection(plan, -1, "user")).toContain("必须原样执行")
  })

  it("已截断 + user：给出可核对的截断事实并降级权威口径", () => {
    const long = "字".repeat(50)
    const out = planBlueprintSection(long, 10, "user")
    expect(out).toContain("已截断")
    expect(out).toContain("原文 50 字")
    expect(out).toContain("此处保留前 10 字")
    expect(out).toContain("【计划完整性声明】")
    expect(out).toContain("请勿据此推断未给出的内容")
    expect(out).toContain("字".repeat(10))
    expect(out).not.toContain("字".repeat(11))
  })

  it("已截断 + 缺省来源：仍强调未经确认", () => {
    const out = planBlueprintSection("字".repeat(50), 10)
    expect(out).toContain("已截断")
    expect(out).toContain("未经用户确认")
    expect(out).toContain("【计划完整性声明】")
  })

  it("小数 maxChars 向下取整后再截断", () => {
    const out = planBlueprintSection("字".repeat(30), 7.9, "user")
    expect(out).toContain("此处保留前 7 字")
    expect(out).toContain("字".repeat(7))
  })
})

describe("appendTaskExtraSection：任务自定义追加段", () => {
  it("extra 缺省/空白时原样返回同一字符串", () => {
    expect(appendTaskExtraSection("prompt")).toBe("prompt")
    expect(appendTaskExtraSection("prompt", "")).toBe("prompt")
    expect(appendTaskExtraSection("prompt", "   \n\t ")).toBe("prompt")
  })

  it("非空 extra 在尾部追加【任务自定义要求】段", () => {
    const out = appendTaskExtraSection("prompt", "  自定义要求  ")
    expect(out.startsWith("prompt\n")).toBe(true)
    expect(out).toContain("# 【任务自定义要求】")
    expect(out.endsWith("自定义要求")).toBe(true)
    expect(out).not.toContain("  自定义要求  ")
  })

  it("阶段 builder 透传 extra（brief 含自定义段）", () => {
    const out = buildDeepChapterBriefPrompt("o", "ctx", "user", 3, undefined, undefined, "  自定义要求  ")
    expect(out).toContain("【任务自定义要求】")
    expect(out).toContain("自定义要求")
  })
})

describe("fitStagePromptToWindow：阶段入口前置预算", () => {
  const base: StagePromptBudgetInput = {
    outlinePrompt: "o",
    contextPrompt: "ctx",
  }

  it("无窗口信息时不预估、逐字节返回入参", () => {
    for (const windowTokens of [undefined, 0, -5, Number.NaN]) {
      const plan = "abc"
      const out = fitStagePromptToWindow({ ...base, planBlueprint: plan, windowTokens })
      expect(out.contextPrompt).toBe("ctx")
      expect(out.planBlueprint).toBe(plan)
      expect(out.planMaxChars).toBe(PLAN_BLUEPRINT_MAX_CHARS)
      expect(out.budgetTokens).toBe(0)
      expect(out.contextCompressed).toBe(false)
      expect(out.planCompressed).toBe(false)
      expect(out.droppedContextChars).toBe(0)
      expect(out.droppedPlanChars).toBe(0)
      expect(out.notes).toEqual([])
      expect(out.estimatedTokens).toBe(
        estimateTokens("o") + estimateTokens("ctx") + estimateTokens(plan) + STAGE_PROMPT_SCAFFOLD_TOKENS + PER_MESSAGE_TOKEN_OVERHEAD,
      )
    }
  })

  it("空白计划视为无计划", () => {
    const out = fitStagePromptToWindow({ ...base, planBlueprint: "   \n ", windowTokens: 100000 })
    expect(out.planBlueprint).toBeUndefined()
    expect(out.contextPrompt).toBe("ctx")
  })

  it("空输入估算 = 脚手架 + 消息开销（token 口径回归）", () => {
    const out = fitStagePromptToWindow({
      outlinePrompt: "",
      contextPrompt: "",
      windowTokens: 3000,
    })
    expect(out.estimatedTokens).toBe(STAGE_PROMPT_SCAFFOLD_TOKENS + PER_MESSAGE_TOKEN_OVERHEAD)
    expect(out.budgetTokens).toBe(2550)
    expect(out.notes).toEqual([])
  })

  it("预算充足时原样通过并上报预算", () => {
    const out = fitStagePromptToWindow({ ...base, windowTokens: 100000 })
    expect(out.budgetTokens).toBe(85000)
    expect(out.contextPrompt).toBe("ctx")
    expect(out.contextCompressed).toBe(false)
    expect(out.planCompressed).toBe(false)
    expect(out.notes).toEqual([])
  })

  it("窗口比输出预留还小时不压缩、如实上报", () => {
    const plan = "字".repeat(10)
    const out = fitStagePromptToWindow({
      ...base,
      planBlueprint: plan,
      windowTokens: 100,
      reservedOutputTokens: 10000,
    })
    expect(out.budgetTokens).toBe(85 - 10000)
    expect(out.contextPrompt).toBe("ctx")
    expect(out.planBlueprint).toBe(plan)
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toContain("已无输入预算")
  })

  it("安全比例/输出预留非法值回退默认，合法值按设生效", () => {
    const w = (safetyRatio: unknown, reservedOutputTokens: unknown) =>
      fitStagePromptToWindow({ ...base, windowTokens: 1000, safetyRatio: safetyRatio as number, reservedOutputTokens: reservedOutputTokens as number }).budgetTokens
    expect(w(2, 0)).toBe(850)
    expect(w(0, 0)).toBe(850)
    expect(w(Number.NaN, 0)).toBe(850)
    expect(w(0.5, 0)).toBe(500)
    expect(w(0.5, 10)).toBe(490)
    expect(w(0.85, -5)).toBe(850)
    expect(w(0.85, Number.NaN)).toBe(850)
  })

  it("planMaxChars 非法值回退默认上限", () => {
    for (const planMaxChars of [-5, Number.NaN, undefined]) {
      const out = fitStagePromptToWindow({
        ...base,
        planBlueprint: "字".repeat(10),
        windowTokens: 100000,
        planMaxChars: planMaxChars as number,
      })
      expect(out.planMaxChars).toBe(PLAN_BLUEPRINT_MAX_CHARS)
      expect(out.notes).toEqual([])
    }
  })

  it("计划超 20000 上限时截断上报（窗口充足也不压缩）", () => {
    const rawPlan = "字".repeat(25000)
    const out = fitStagePromptToWindow({
      ...base,
      planBlueprint: rawPlan,
      windowTokens: 10_000_000,
    })
    expect(out.planMaxChars).toBe(PLAN_BLUEPRINT_MAX_CHARS)
    expect(out.planBlueprint).toBe(rawPlan)
    expect(out.contextPrompt).toBe("ctx")
    expect(out.contextCompressed).toBe(false)
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toContain("超过上限 20000 字")
  })

  it("planMaxChars 覆盖上限：截断与上报按覆盖值", () => {
    const rawPlan = "字".repeat(500)
    const out = fitStagePromptToWindow({
      ...base,
      planBlueprint: rawPlan,
      planMaxChars: 100,
      windowTokens: 100000,
    })
    expect(out.planMaxChars).toBe(100)
    expect(out.planBlueprint).toBe(rawPlan)
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toContain("上限 100 字")
  })

  it("计划恰达上限时不记截断", () => {
    const out = fitStagePromptToWindow({
      ...base,
      planBlueprint: "字".repeat(10),
      planMaxChars: 10,
      windowTokens: 100000,
    })
    expect(out.notes).toEqual([])
    expect(out.planMaxChars).toBe(10)
  })

  it("超窗先压 context：计划不动、口径不降级", () => {
    const out = fitStagePromptToWindow({
      outlinePrompt: "o",
      contextPrompt: "字".repeat(5000),
      windowTokens: 3000,
    })
    // estimated = 1 + 5000 + 2004 = 7005；budget = 2550；cut = 4455 + 80 = 4535
    expect(out.budgetTokens).toBe(2550)
    expect(out.contextCompressed).toBe(true)
    expect(out.droppedContextChars).toBe(4535)
    expect(out.planCompressed).toBe(false)
    expect(out.droppedPlanChars).toBe(0)
    expect(out.planMaxChars).toBe(PLAN_BLUEPRINT_MAX_CHARS)
    expect(out.contextPrompt.startsWith("字".repeat(465))).toBe(true)
    expect(out.contextPrompt).toContain("省略后段 4535 字")
    expect(out.notes).toHaveLength(1)
  })

  it("context 为空时跳过第一压、只压计划（部分压缩）", () => {
    const rawPlan = "字".repeat(5000)
    const out = fitStagePromptToWindow({
      outlinePrompt: "o",
      contextPrompt: "",
      planBlueprint: rawPlan,
      windowTokens: 4706,
    })
    // estimated = 1 + 0 + 5000 + 2004 = 7005；budget = 4000；cut = 3005 + 160 = 3165
    expect(out.budgetTokens).toBe(4000)
    expect(out.contextCompressed).toBe(false)
    expect(out.droppedContextChars).toBe(0)
    expect(out.planCompressed).toBe(true)
    expect(out.droppedPlanChars).toBe(3165)
    expect(out.planMaxChars).toBe(1835)
    expect(out.planBlueprint).toBe(rawPlan)
    expect(out.estimatedTokens).toBe(1 + 0 + 1835 + STAGE_PROMPT_SCAFFOLD_TOKENS + PER_MESSAGE_TOKEN_OVERHEAD)
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0]).toContain("仅保留前 1835 字")
    expect(out.contextPrompt).toBe("")
  })

  it("context 压空仍超窗：计划整段省略并如实上报仍超窗", () => {
    const rawPlan = "字".repeat(30000)
    const out = fitStagePromptToWindow({
      outlinePrompt: "o",
      contextPrompt: "ctx",
      planBlueprint: rawPlan,
      windowTokens: 100,
    })
    expect(out.budgetTokens).toBe(85)
    expect(out.contextCompressed).toBe(true)
    expect(out.droppedContextChars).toBe(3)
    expect(out.planCompressed).toBe(true)
    expect(out.droppedPlanChars).toBe(30000)
    expect(out.planMaxChars).toBe(0)
    expect(out.planBlueprint).toBe(rawPlan)
    expect(out.estimatedTokens).toBeLessThan(22006)
    expect(out.notes).toHaveLength(4)
    expect(out.notes[0]).toContain("超过上限")
    expect(out.notes[1]).toContain("已先压缩 contextPrompt")
    expect(out.notes[2]).toContain("已整段省略")
    expect(out.notes[3]).toContain("仍超窗")
  })
})
