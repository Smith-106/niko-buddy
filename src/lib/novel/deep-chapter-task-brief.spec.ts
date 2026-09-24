import { describe, expect, it } from "vitest"
import type { ContextPack } from "./context-engine"
import type { ChapterLengthSpec } from "./deep-chapter-prompts"
import {
  buildChapterContractSection,
  buildCompactChapterContractSection,
  buildDraftRecoveryPrompt,
  buildFallbackTaskBrief,
  buildTaskBriefRepairPrompt,
  checkChapterContract,
  isMetaDraftContent,
  parseChapterContractSection,
  shouldRepairTaskBrief,
  shouldUseDeterministicTaskBriefFallback,
  splitContractLines,
} from "./deep-chapter-task-brief"

const thinPack: ContextPack = {
  task: "t",
  chapterGoal: "目标：推进冲突",
  outline: "o",
  recentSummaries: [],
  previousChapterEnding: "主角被困在塔顶",
  characterStates: "林动：状态正常",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "匕首伏笔：埋设于第1章",
  timeline: "时间线：第3日",
  relatedSettings: "场景：荒原",
  canonRules: "不得违背设定",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "必须完成：冲突升级",
  mustAvoid: "禁止违背：角色状态",
  nextChapterAdvice: "结尾留下下一章钩子",
  revisionDirectives: "",
  mustNotDo: "",
} as unknown as ContextPack

const lengthSpec: ChapterLengthSpec = {
  targetChars: 5000,
  minChars: 4000,
  draftMaxChars: 5500,
  maxOutputTokens: 12000,
}

describe("sanitize / fallback via buildFallbackTaskBrief", () => {
  it("builds a structured fallback brief preferring non-empty context fields", () => {
    const brief = buildFallbackTaskBrief(thinPack, "写第3章高潮戏", 3, lengthSpec)
    expect(brief).toContain("本章必须完成：必须完成：冲突升级")
    // 禁止违背：角色状态 → 前缀清洗后长度不足被丢弃 → 落到 canonRules
    expect(brief).toContain("禁止违背：不得违背设定")
    expect(brief).toContain("角色状态：林动：状态正常")
    expect(brief).toContain("伏笔推进：匕首伏笔：埋设于第1章")
    expect(brief).toContain("结尾钩子：结尾留下下一章钩子")
    // 场景：荒原 前缀清洗后长度不足被丢弃 → 落到 previousChapterEnding
    expect(brief).toContain("暂定设定：主角被困在塔顶")
    expect(brief).toContain("长度要求：目标约 5000 字；低于 4000 字视为未完成。")
    expect(brief).toContain("原始请求对齐：写第3章高潮戏")
  })

  it("falls back through the chain when higher-priority fields are empty", () => {
    const pack: ContextPack = {
      ...thinPack,
      mustDo: "",
      chapterGoal: "",
      mustAvoid: "",
      canonRules: "",
      timeline: "",
      characterStates: "",
      cognitionStates: "",
      foreshadowingStates: "",
      searchResults: "",
      graphSearchResults: "",
      nextChapterAdvice: "",
      previousChapterEnding: "",
      relatedSettings: "",
    } as unknown as ContextPack
    const brief = buildFallbackTaskBrief(pack, "   ", undefined, lengthSpec)
    expect(brief).toContain("本章必须完成：承接上一章结尾，完成 当前章节 的核心冲突推进，并自然落出下一步行动。")
    expect(brief).toContain("禁止违背：不得违背既有设定、角色认知边界与时间线。")
    expect(brief).toContain("角色状态：沿用现有角色状态与认知边界，不擅自越界知晓或反常行动。")
    expect(brief).toContain("伏笔推进：至少推进一个既有线索或伏笔，并把它和本章结果绑定。")
    expect(brief).toContain("结尾钩子：结尾保留下一章可直接承接的新压力、线索或选择题。")
    expect(brief).toContain("暂定设定：若上下文仍有缺口，只补最小必要场景设定，不新增会推翻既有设定的事实。")
    expect(brief).toContain("原始请求对齐：围绕 当前章节 的写作需求推进。")
  })

  it("uses previousChapterEnding-derived hooks when present as second source", () => {
    const pack: ContextPack = {
      ...thinPack,
      nextChapterAdvice: "",
      relatedSettings: "",
      previousChapterEnding: "主角被困在塔顶",
    } as unknown as ContextPack
    const brief = buildFallbackTaskBrief(pack, "写", 7, lengthSpec)
    expect(brief).toContain("结尾需承接上一章留下的压力：主角被困在塔顶")
    // 场景必须承接：前缀被清洗 → 只保留正文
    expect(brief).toContain("暂定设定：主角被困在塔顶")
    // 过短请求被清洗后落到兜底文案（含目标章节号）
    expect(brief).toContain("原始请求对齐：围绕 第7章 的写作需求推进。")
  })
})

describe("shouldRepairTaskBrief", () => {
  it("repairs non-executable briefs (meta request + refusal)", () => {
    expect(shouldRepairTaskBrief("请补充五句设定后我再推进，本轮只给任务书不写正文")).toBe(true)
  })

  it("repairs briefs that drift into narrative", () => {
    expect(shouldRepairTaskBrief("[N] 夜色如墨，主角推开木门……")).toBe(true)
    expect(shouldRepairTaskBrief("# 第3章 黎明\n\n长段落甲".repeat(40))).toBe(true)
  })

  it("repairs polluted briefs (noise markers + structure or bulk)", () => {
    const polluted = "必须完成A\n禁止违背B\n角色状态C\n伏笔推进D\n结尾钩子E\n--- type: memory\nchapter_number: 3"
    expect(shouldRepairTaskBrief(polluted)).toBe(true)
  })

  it("does not repair clean briefs", () => {
    expect(shouldRepairTaskBrief("本章必须完成：推进冲突")).toBe(false)
    expect(shouldRepairTaskBrief("")).toBe(false)
    expect(shouldRepairTaskBrief("   ")).toBe(false)
  })
})

describe("shouldUseDeterministicTaskBriefFallback", () => {
  it("uses deterministic fallback for polluted or long structure-heavy briefs", () => {
    expect(shouldUseDeterministicTaskBriefFallback("必须完成\n禁止违背\n--- type: memory\n")).toBe(true)
    const longStructural = "必须完成：".padEnd(120, "甲") + "禁止违背：".padEnd(120, "乙") + "角色状态：".padEnd(120, "丙") + "伏笔推进：".padEnd(120, "丁") + "结尾钩子：".padEnd(120, "戊") + "暂定设定：".padEnd(120, "己") + "长度要求：".padEnd(120, "庚")
    expect(longStructural.length).toBeGreaterThan(600)
    expect(shouldUseDeterministicTaskBriefFallback(longStructural)).toBe(true)
  })

  it("uses deterministic fallback for long narrative briefs", () => {
    const longNarrative = "第3章\n" + "长段落文字".repeat(120)
    expect(longNarrative.length).toBeGreaterThan(600)
    expect(shouldUseDeterministicTaskBriefFallback(longNarrative)).toBe(true)
  })

  it("returns false for empty or normal briefs", () => {
    expect(shouldUseDeterministicTaskBriefFallback("")).toBe(false)
    expect(shouldUseDeterministicTaskBriefFallback("   ")).toBe(false)
    expect(shouldUseDeterministicTaskBriefFallback("本章必须完成：推进冲突")).toBe(false)
  })
})

describe("isMetaDraftContent", () => {
  it("flags [N] draft marker", () => {
    expect(isMetaDraftContent("[N] 主角……")).toBe(true)
  })

  it("flags meta request + refusal drafts", () => {
    expect(isMetaDraftContent("请先补充五句话，本轮只给任务书不写正文")).toBe(true)
  })

  it("does not flag normal draft text or empty content", () => {
    expect(isMetaDraftContent("夜色如墨，主角推开木门。")).toBe(false)
    expect(isMetaDraftContent("")).toBe(false)
    expect(isMetaDraftContent("   ")).toBe(false)
    expect(isMetaDraftContent("请补充设定")).toBe(false)
  })
})

describe("buildTaskBriefRepairPrompt", () => {
  it("builds repair prompt with chapter number", () => {
    const prompt = buildTaskBriefRepairPrompt("outline", "context", "bad brief", "user req", 5, lengthSpec)
    expect(prompt).toContain("[TASK_BRIEF_MARKER]")
    expect(prompt).toContain("目标章节：第5章")
    expect(prompt).toContain("用户请求：user req")
    expect(prompt).toContain("不可执行任务书：\nbad brief")
    expect(prompt).toContain("目标约 5000 字；低于 4000 字视为未完成。")
  })

  it("builds repair prompt without chapter number", () => {
    const prompt = buildTaskBriefRepairPrompt("o", "c", "bad", "req", undefined, lengthSpec)
    expect(prompt).toContain("目标章节：用户请求中的章节")
    expect(prompt).not.toContain("第undefined章")
  })
})

describe("buildDraftRecoveryPrompt", () => {
  it("builds recovery prompt with chapter number", () => {
    const prompt = buildDraftRecoveryPrompt("o", "c", "brief", "bad draft", "req", 2, lengthSpec)
    expect(prompt).toContain("[DRAFT_STAGE_MARKER]")
    expect(prompt).toContain("目标章节：第2章")
    expect(prompt).toContain("用户请求：req")
    expect(prompt).toContain("写作任务书：\nbrief")
    expect(prompt).toContain("错误草稿（仅用于识别错误模式，不可沿用其元文本表达）：\nbad draft")
  })

  it("builds recovery prompt without chapter number", () => {
    const prompt = buildDraftRecoveryPrompt("o", "c", "brief", "bad", "req", undefined, lengthSpec)
    expect(prompt).toContain("目标章节：用户请求中的章节")
  })
})

describe("task brief source sanitization (via userRequest path)", () => {
  it("sanitizes raw request text with markdown/noise cleanup and dedup", () => {
    const brief = buildFallbackTaskBrief(
      { ...thinPack, mustDo: "", chapterGoal: "" } as unknown as ContextPack,
      "推进第3章高潮戏份；推进第3章高潮戏份；推进第3章高潮戏份；推进第3章高潮戏份；推进第3章高潮戏份",
      3,
      lengthSpec,
    )
    // 5 个重复段 Set 去重 → 1 段
    expect(brief).toContain("原始请求对齐：推进第3章高潮戏份")
  })

  it("drops noise labels/lines/narrative/blank/heading segments during sanitize", () => {
    const brief = buildFallbackTaskBrief(
      { ...thinPack, mustDo: "", chapterGoal: "" } as unknown as ContextPack,
      [
        "推进第3章高潮戏份",
        "配角互动再写一段",
        "正式设定记忆",
        "chapter_status: final",
        "[N] 这是一段正文内容",
        "",
        "# 本章标题",
      ].join("\n"),
      3,
      lengthSpec,
    )
    expect(brief).toContain("原始请求对齐：推进第3章高潮戏份；配角互动再写一段")
  })

  it("repairs long polluted briefs even without structure markers", () => {
    const long = "--- type: memory\n" + "纯文本内容".repeat(80)
    expect(long.length).toBeGreaterThanOrEqual(240)
    expect(shouldRepairTaskBrief(long)).toBe(true)
    expect(shouldUseDeterministicTaskBriefFallback(long)).toBe(true)
  })
})

describe("§GAP-88-01 章节契约 machine-readable 段", () => {
  it("build/parse 往返：完整段各标签同构", () => {
    const section = buildChapterContractSection({
      requiredBeats: ["主角握住陌生钥匙", "小青暴露隐秘联系"],
      forbiddenMoves: ["不得提前揭露屋主身份"],
      continuityChecks: ["雨夜时间线连续"],
      emotionTarget: "悬疑克制",
      payoffPoints: ["旧信警告不要相信送钥匙的人"],
      hookGoal: "引出屋内第二个人影",
    })
    const parsed = parseChapterContractSection(`任务书正文\n${section}\n后续段落`)
    expect(parsed).not.toBeNull()
    expect(parsed!.requiredBeats).toEqual(["主角握住陌生钥匙", "小青暴露隐秘联系"])
    expect(parsed!.forbiddenMoves).toEqual(["不得提前揭露屋主身份"])
    expect(parsed!.continuityChecks).toEqual(["雨夜时间线连续"])
    expect(parsed!.emotionTarget).toBe("悬疑克制")
    expect(parsed!.payoffPoints).toEqual(["旧信警告不要相信送钥匙的人"])
    expect(parsed!.hookGoal).toBe("引出屋内第二个人影")
  })

  it("parse 缺段返回 null（无契约=无约束，不伪造 findings）", () => {
    expect(parseChapterContractSection("本章必须完成：推进线索")).toBeNull()
  })

  it("fallback 紧凑段恒 2 行且 parse 同构", () => {
    const compact = buildCompactChapterContractSection({
      requiredBeat: "承接上一章门缝声推进锈钥匙线索",
      forbiddenMove: "不要提前揭露旧屋主人身份",
      continuityCheck: "雨夜当晚十点时间线连续",
      hookGoal: "结尾引出屋内第二个人影",
    })
    // 长度纪律：紧凑段 ≤120 字符（守 420/520 预算）
    expect(compact.length).toBeLessThanOrEqual(120)
    const parsed = parseChapterContractSection(`fallback正文\n${compact}\n正史指纹：abc`)
    expect(parsed).not.toBeNull()
    expect(parsed!.requiredBeats).toHaveLength(1)
    expect(parsed!.forbiddenMoves).toHaveLength(1)
    expect(parsed!.continuityChecks).toHaveLength(1)
    expect(parsed!.hookGoal).toBeTruthy()
  })

  it("checkChapterContract：禁区命中 error、节拍缺失 warning（防转述误杀 stranded）", () => {
    const contract = {
      requiredBeats: ["第十章完全不存在的节拍XYZ"],
      forbiddenMoves: ["旧屋主人身份"],
      continuityChecks: [] as string[],
    }
    // 正文含禁区原文 → error；节拍用转述表达 → warning（不管阻断）
    const body = "主角继续追查线索。旧屋主人身份在此刻被揭晓了。"
    const check = checkChapterContract(contract, body)
    expect(check.passed).toBe(false)
    expect(check.findings.some((f) => f.type === "contract" && f.severity === "error")).toBe(true)
    expect(check.findings.some((f) => f.type === "contract" && f.severity === "warning")).toBe(true)
    // contract finding 归 consistency 门（CORR108 双真源一致性）
    expect(check.findings.every((f) => f.type === "contract")).toBe(true)
  })

  it("splitContractLines 上限 5 条防膨胀", () => {
    expect(splitContractLines("a；b；c；d；e；f；g")).toHaveLength(5)
    expect(splitContractLines("   ")).toEqual([])
  })
})
