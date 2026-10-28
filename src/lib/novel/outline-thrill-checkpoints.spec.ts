import { describe, expect, it } from "vitest"
import {
  evaluateOutlineThrillCheckpoints,
  formatThrillSoftGateThinking,
  getOutlineThrillSoftGateRuntimeStatus,
  runOutlineThrillSoftGate,
  setThrillSoftGateAcknowledged,
  summarizeThrillSoftGate,
  thrillResultsToReviewResults,
} from "./outline-thrill-checkpoints"

const STRONG_OUTLINE = `
第3章纲要：开篇危机逼近，主角被追杀陷入绝境。
中段压抑到极点后反击破局，主动设局推动局面。
章末钩：门外传来倒计时滴答，下一阶段仍未揭开。
`.repeat(2)

const SPOILER_OUTLINE = `
开篇说明设定。最终存活者是阿宁，Offer 是契约。
真相是全员被选中。
`.repeat(3)

describe("evaluateOutlineThrillCheckpoints", () => {
  it("empty outline → structural unknown, fix1 pass", () => {
    const r = evaluateOutlineThrillCheckpoints("")
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("unknown")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("strong outline passes structural cues", () => {
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("pass")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("pass")
    expect(r.find((x) => x.id === "protagonist_agency")!.status).toBe("pass")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("FIX-1 spoiler phrasing fails hard constraint", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    const fix1 = r.find((x) => x.id === "fix1_no_conflict")!
    expect(fix1.status).toBe("fail")
    expect(fix1.hardLiteraryConstraint).toBe(true)
  })

  it("short text with allowUnknown=false hard-fails structural checks", () => {
    const r = evaluateOutlineThrillCheckpoints("短", { allowUnknown: false })
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("fail")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("fail")
    expect(r.find((x) => x.id === "protagonist_agency")!.status).toBe("fail")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("fail")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("null outline text is treated as empty", () => {
    const r = evaluateOutlineThrillCheckpoints(null as unknown as string)
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("unknown")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("detects an end hook that only appears within the final 200 chars", () => {
    // hook words placed outside lateSlice (55% mark) but inside the last 200
    const text = "危机 压抑 决定 ".repeat(20) + "下章悬念" + "平".repeat(96)
    const r = evaluateOutlineThrillCheckpoints(text)
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("pass")
  })

  it("takes the final-200-char hook branch when the late slice has no hook cue", () => {
    // 200 filler chars, hook at index 200..203, then 196 filler chars:
    // lateSlice starts at 55% (index 220) so it misses the hook, but the last
    // 200 chars still contain it → the `||` second operand must be evaluated
    const text = "字".repeat(200) + "下章悬念" + "字".repeat(196)
    const r = evaluateOutlineThrillCheckpoints(text)
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("fail") // longEnough
  })

  it("renders a result without evidence with an empty evidence suffix", () => {
    const r: ReturnType<typeof evaluateOutlineThrillCheckpoints> = [
      { id: "crisis_info_early", status: "pass", label: "无证据检查点" },
    ]
    const text = formatThrillSoftGateThinking(r)
    expect(text).toContain("[✓] 无证据检查点")
    expect(text).not.toContain("— ")
  })

  it("maps missing evidence to the raw status string in review results", () => {
    const r: ReturnType<typeof evaluateOutlineThrillCheckpoints> = [
      { id: "crisis_info_early", status: "unknown", label: "无证据检查点" },
    ]
    const reviews = thrillResultsToReviewResults(r)
    expect(reviews[0]!.evidence).toBe("unknown")
  })

  it("runtime status tolerates a missing outlineText via empty-string fallback", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({ chapter: 2, ackMap: {} })
    expect(st.enabled).toBe(true)
    expect(st.chapterKey).toBe("2")
    expect(st.failCount).toBe(0)
    expect(st.results.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })
})

describe("getOutlineThrillSoftGateRuntimeStatus", () => {
  it("exposes ack + FIX-1 without product hard gate", () => {
    const ack = setThrillSoftGateAcknowledged({}, 4, true)
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: STRONG_OUTLINE,
      chapter: 4,
      ackMap: ack,
    })
    expect(st.enabled).toBe(true)
    expect(st.acknowledged).toBe(true)
    expect(st.productHardGate).toBe(false)
    expect(st.mayContinueGeneration).toBe(true)
    expect(st.fix1Blocked).toBe(false)
  })

  it("FIX-1 blocked still may continue but flags constraint", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: SPOILER_OUTLINE,
      chapter: 3,
      ackMap: { "3": true },
    })
    expect(st.fix1Blocked).toBe(true)
    expect(st.acknowledged).toBe(true)
    expect(st.thinking).toMatch(/FIX-1/)
  })

  it("disabled runtime status short-circuits with empty results", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: SPOILER_OUTLINE,
      chapter: 3,
      enabled: false,
      ackMap: { "3": true },
    })
    expect(st.enabled).toBe(false)
    expect(st.results).toEqual([])
    expect(st.passCount).toBe(0)
    expect(st.fix1Blocked).toBe(false)
    expect(st.allStructuralOk).toBe(true)
    expect(st.mayContinueGeneration).toBe(true)
    expect(st.thinking).toContain("已关闭")
  })

  it("empty outline via runtime status yields structural unknowns and ack false", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: "",
      chapter: null,
    })
    expect(st.enabled).toBe(true)
    expect(st.chapterKey).toBe("0")
    expect(st.acknowledged).toBe(false)
    expect(st.failCount).toBe(0)
    expect(st.results.find((r) => r.id === "fix1_no_conflict")!.status).toBe("pass")
  })
})

describe("summarize + review mapping", () => {
  it("soft-gate review results are warnings only", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    const reviews = thrillResultsToReviewResults(r, 3)
    expect(reviews.every((x) => x.severity === "warning")).toBe(true)
    expect(reviews.some((x) => x.type === "outline_thrill_fix1")).toBe(true)
  })

  it("thinking is non-silent and mentions acknowledge", () => {
    const r = evaluateOutlineThrillCheckpoints("短")
    const text = formatThrillSoftGateThinking(r)
    expect(text).toContain("软门")
    expect(text).toContain("acknowledge")
  })

  it("runOutlineThrillSoftGate bundles", () => {
    const out = runOutlineThrillSoftGate(STRONG_OUTLINE, 2)
    expect(out.summary.failCount).toBe(0)
    expect(out.thinking.length).toBeGreaterThan(20)
  })

  it("summarize detects fix1Blocked", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    expect(summarizeThrillSoftGate(r).fix1Blocked).toBe(true)
  })
})

describe("thril soft-gate acknowledge helpers", () => {
  it("set/get/clear acknowledge by chapter", async () => {
    const {
      isThrillSoftGateAcknowledged,
      setThrillSoftGateAcknowledged,
      thrilAckChapterKey,
      formatThrillSoftGateThinkingWithAck,
    } = await import("./outline-thrill-checkpoints")
    expect(thrilAckChapterKey(3)).toBe("3")
    let map = setThrillSoftGateAcknowledged({}, 3, true)
    expect(isThrillSoftGateAcknowledged(map, 3)).toBe(true)
    expect(isThrillSoftGateAcknowledged(map, 2)).toBe(false)
    map = setThrillSoftGateAcknowledged(map, 3, false)
    expect(isThrillSoftGateAcknowledged(map, 3)).toBe(false)
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    expect(formatThrillSoftGateThinkingWithAck(r, true)).toContain("已确认")
    expect(formatThrillSoftGateThinkingWithAck(r, false)).toContain("待确认")
  })

  it("thrilAckChapterKey handles null, NaN, Infinity and fractional chapters", async () => {
    const { thrilAckChapterKey } = await import("./outline-thrill-checkpoints")
    expect(thrilAckChapterKey(null)).toBe("0")
    expect(thrilAckChapterKey(undefined)).toBe("0")
    expect(thrilAckChapterKey(NaN)).toBe("0")
    expect(thrilAckChapterKey(Infinity)).toBe("0")
    expect(thrilAckChapterKey(3.7)).toBe("3")
    expect(thrilAckChapterKey(-2)).toBe("-2")
  })

  it("setThrillSoftGateAcknowledged tolerates null ackMap and setThrillSoftGateAcknowledged delete path", async () => {
    const { isThrillSoftGateAcknowledged, setThrillSoftGateAcknowledged } = await import("./outline-thrill-checkpoints")
    expect(isThrillSoftGateAcknowledged(null, 2)).toBe(false)
    const fresh = setThrillSoftGateAcknowledged(null, 2, true)
    expect(fresh).toEqual({ "2": true })
  })

  it("thrillResultsToReviewResults maps unknown status with default chapter 0", async () => {
    const { evaluateOutlineThrillCheckpoints, thrillResultsToReviewResults } = await import("./outline-thrill-checkpoints")
    const r = evaluateOutlineThrillCheckpoints("短")
    const reviews = thrillResultsToReviewResults(r)
    expect(reviews.length).toBe(4) // four structural unknowns (fix1 passes)
    expect(reviews.every((x) => x.continuityMeta!.chapter === 0)).toBe(true)
    expect(reviews[0]!.evidence).toBe("no crisis/pressure cue in first ~40%")
  })
})

describe("thril 大纲层改造：提示块与评估同口径", () => {
  it("buildThrillOutlinePromptBlock 覆盖四条结构检查点与 FIX-1", async () => {
    const { buildThrillOutlinePromptBlock, THRILL_CHECKPOINT_LABELS } = await import("./outline-thrill-checkpoints")
    const block = buildThrillOutlinePromptBlock()
    for (const id of ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook", "fix1_no_conflict"] as const) {
      expect(block).toContain(THRILL_CHECKPOINT_LABELS[id])
      expect(block).toContain(id)
    }
    expect(block).toContain("【thril 结构硬要求】")
  })

  it("buildThrillOutlinePromptBlock 带章号落位，可关闭 FIX-1 段", async () => {
    const { buildThrillOutlinePromptBlock } = await import("./outline-thrill-checkpoints")
    expect(buildThrillOutlinePromptBlock({ chapterNumber: 36 })).toContain("第36章")
    const noFix1 = buildThrillOutlinePromptBlock({ chapterNumber: null, includeFix1: false })
    expect(noFix1).not.toContain("fix1_no_conflict")
    expect(noFix1).toContain("crisis_info_early")
  })

  it("章纲提示块要求爽点设计/章尾钩子可执行落位", async () => {
    const { buildThrillChapterOutlinePromptBlock } = await import("./outline-thrill-checkpoints")
    const block = buildThrillChapterOutlinePromptBlock(2)
    expect(block).toContain("第2章")
    expect(block).toContain("爽点设计")
    expect(block).toContain("章尾钩子")
    expect(block).toContain("微爽点")
  })

  it("提示块要求的内容写进大纲后能通过软门结构检查", async () => {
    const { buildThrillChapterOutlinePromptBlock, evaluateOutlineThrillCheckpoints } = await import("./outline-thrill-checkpoints")
    // 提示块本身是要求而非正文；此处验证它点名的四项在合规大纲里都被识别。
    expect(buildThrillChapterOutlinePromptBlock(1)).toContain("章末钩")
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    expect(r.filter((x) => x.status === "pass").length).toBe(5)
  })
})

describe("整本大纲 thril 审计（splitOutlineIntoChapters / auditOutlineThrillByChapter）", () => {
  it("按 ### 第N章 切分，保留章号与标题", async () => {
    const { splitOutlineIntoChapters } = await import("./outline-thrill-checkpoints")
    const text = [
      "### 第1章 合同到期日",
      "危机逼近，主角被追杀。",
      "### 第2章 小字",
      "他主动设局反击破局。",
    ].join("\n")
    const chapters = splitOutlineIntoChapters(text)
    expect(chapters.map((c) => c.chapterNumber)).toEqual([1, 2])
    expect(chapters[0]!.title).toBe("合同到期日")
    expect(chapters[1]!.text).toContain("主动设局")
  })

  it("支持 ## / **第N章** 形式与无章头回退", async () => {
    const { splitOutlineIntoChapters } = await import("./outline-thrill-checkpoints")
    expect(splitOutlineIntoChapters("## 第7章 转折\n内容").map((c) => c.chapterNumber)).toEqual([7])
    expect(splitOutlineIntoChapters("**第9章**\n内容").map((c) => c.chapterNumber)).toEqual([9])
    const fallback = splitOutlineIntoChapters("没有章头的整段大纲，长度足够时按整体评估。")
    expect(fallback).toHaveLength(1)
    expect(fallback[0]!.chapterNumber).toBe(0)
    expect(splitOutlineIntoChapters("")).toEqual([])
  })

  it("逐章汇总缺口计数与通过率", async () => {
    const { auditOutlineThrillByChapter } = await import("./outline-thrill-checkpoints")
    const text = [
      "### 第1章 完整",
      "开篇危机逼近，主角被追杀陷入绝境。中段压抑到极点后主动反击破局，推动局面。章末钩：门外倒计时滴答，下一阶段仍未揭开。",
      "### 第2章 只有危机",
      "开篇危机逼近，主角被追杀陷入绝境，随后一路说明设定背景与人物关系，章末没有留下任何钩子。",
    ].join("\n")
    const audit = auditOutlineThrillByChapter(text)
    expect(audit.chapters).toHaveLength(2)
    expect(audit.chapters[0]!.gaps).toEqual([])
    expect(audit.chapters[1]!.gaps.length).toBeGreaterThan(0)
    expect(audit.fullPassCount).toBe(1)
    expect(audit.averagePassPerChapter).toBeGreaterThan(3)
    expect(audit.averagePassPerChapter).toBeLessThanOrEqual(5)
    expect(audit.missingTally.protagonist_agency).toBeGreaterThanOrEqual(1)
  })

  it("空大纲审计不炸（0 章）", async () => {
    const { auditOutlineThrillByChapter } = await import("./outline-thrill-checkpoints")
    const audit = auditOutlineThrillByChapter("")
    expect(audit.chapters).toHaveLength(0)
    expect(audit.fullPassCount).toBe(0)
    expect(audit.averagePassPerChapter).toBe(0)
  })
})

describe("抗欺骗：裸关键词堆砌不得被判 pass（2026-10-28）", () => {
  // 背景：原实现只做 RE.test(text)，章纲里塞一个"压抑"/"反击"就能变绿，
  // 而实际内容仍是"冲突是什么"一句空话。改造后 pass 必须伴随可指认链条。

  const GAMING_OUTLINE = `### 第1章 测试
本章有冲突、有压抑、有释放、有反转。主角做出选择并决定反抗。章末有悬念，突然来电。`.repeat(2)

  it("纯关键词堆砌：能动性与章末钩不得判 pass", () => {
    const r = evaluateOutlineThrillCheckpoints(GAMING_OUTLINE)
    expect(r.find((x) => x.id === "protagonist_agency")!.status).not.toBe("pass")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).not.toBe("pass")
  })

  it("纯关键词堆砌的 evidence 明确指出缺可指认内容", () => {
    const r = evaluateOutlineThrillCheckpoints(GAMING_OUTLINE)
    const agency = r.find((x) => x.id === "protagonist_agency")!
    expect(agency.evidence).toMatch(/bare|identifiable/)
  })

  const REAL_CHAIN_OUTLINE = `### 第1章 测试
中介当面把续租费翻三倍，主角账户只够七天，被逼到绝境。陈默当众拆穿阴阳合同，用自己发现的条款反将对方一军，中介当场改口降价。
章末钩：下一阶段他要面对天枢营业厅的资质审核，而审核表上有一栏他根本填不出来。`.repeat(2)

  it("真实可指认链条（自然叙述）四项结构全 pass", () => {
    const r = evaluateOutlineThrillCheckpoints(REAL_CHAIN_OUTLINE)
    for (const id of ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook"] as const) {
      expect(r.find((x) => x.id === id)!.status, `${id} 应 pass`).toBe("pass")
    }
  })

  const LABELED_OUTLINE = `### 第1章 测试
压抑铺垫：公司通知续租费翻三倍，账户余额只够七天，身体开始排异。
压力释放：陈默当众拆穿阴阳合同，用自发现的条款反将一军，中介当场改口。
主角能动性：陈默主动设局，提前录音并请来第三方见证。
章末钩：下一阶段是资质审核，审核表上有一栏他根本填不出来。`.repeat(2)

  it("显式标签写法四项结构全 pass", () => {
    const r = evaluateOutlineThrillCheckpoints(LABELED_OUTLINE)
    for (const id of ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook"] as const) {
      expect(r.find((x) => x.id === id)!.status, `${id} 应 pass`).toBe("pass")
    }
  })

  it("既有自然叙述基准（STRONG_OUTLINE）不被抗欺骗收紧误杀", () => {
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    for (const id of ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook"] as const) {
      expect(r.find((x) => x.id === id)!.status, `${id} 不应被误杀`).toBe("pass")
    }
  })
})

describe("抗欺骗：空壳标签不得被判 pass（2026-10-28 加固）", () => {
  // 首版抗欺骗只要求「标签 + 12 字以上」，于是「主角能动性：有能动。」这类
  // 空壳仍能全过。加固后标签后的内容必须含具体名词/动作，否则不算可指认链条。

  it("只写标签与空壳内容（有压力/有释放/有能动/有钩子）不得全 pass", () => {
    const shell = `### 第1章 测试
压抑铺垫：有压力。压力释放：有释放。主角能动性：有能动。章末钩：有钩子。`.repeat(2)
    const r = evaluateOutlineThrillCheckpoints(shell)
    const passCount = r.filter((x) => x.status === "pass").length
    expect(passCount).toBeLessThan(5)
    expect(r.find((x) => x.id === "protagonist_agency")!.status).not.toBe("pass")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).not.toBe("pass")
  })

  it("真实改写章（含具体人物/机构/动作/后果）仍全 pass", () => {
    const real = `### 第1章 合同到期日
本章剧情概要与核心冲突：压抑铺垫：白曦毕业当天收到天枢人体租赁公司通知，身体债务与维护费同时到期，账户余额只够撑到月底；他翻看合同时看见小字灵纹，觉醒「合同修仙面板」。压力释放：天枢客服当面给出最后期限，白曦没签补充协议，而是把合同条款逐条拍下来，第一次看清「维护费」定义里有可钻的空白。主角能动性：他没有当场求情，而是主动选择先读完合同再回应，把被动催收变成争取时间的第一步。章末钩：面板提示「第一条可炼条款已锁定」，而下一阶段他要去营业厅协商展期，那里等着他的是信用评分与灵压契约。`
    const r = evaluateOutlineThrillCheckpoints(real)
    for (const id of ["crisis_info_early", "pressure_release", "protagonist_agency", "chapter_end_hook"] as const) {
      expect(r.find((x) => x.id === id)!.status, `${id} 应 pass`).toBe("pass")
    }
  })
})
