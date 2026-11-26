import { beforeEach, describe, expect, it, vi } from "vitest"

import { createDefaultStore, type UserMemoryStore } from "@/lib/user-memory"
import type { AntiAiAnalysisReport, NovelReviewResult } from "@/lib/novel"
import {
  buildPinpointSnippet,
  runMechanicalGateForMcp,
  type MechanicalGateDeps,
} from "./mechanical-gate"

/** 生成一段自然、干净、在默认字数规格区间（2200–3500 字）内且句长分布自然的中文正文。 */
function buildCleanChapterProse(repeat = 46): string {
  const paragraphs = [
    "雨点敲在青石板上，檐水顺着瓦沟滴进窄巷。陈砚把油纸伞靠在门槛边，掏出铜钥匙试了两下，生锈的锁芯卡住半圈才咔嗒松开。",
    "堂屋里黑着。桌上只剩半碗凉茶，旁边压着一张折成方块的借条。他伸手碰了碰碗沿，瓷壁已经透凉，屋主离去至少有两个时辰。",
    "巷口忽有木轮碾过石缝的吱呀声。卖豆腐的老周推车路过，隔着雨帘朝街尾喊了半句收摊，脚步随即拐进东侧岔道，巷子里很快恢复冷清。",
    "借条背面用炭笔抄着三个门牌号，墨迹被雨水洇开一角，最底下这道数字只剩半道弧线。他把纸折回原样，塞进袖袋内侧，顺手掩上木门。",
  ]
  const out: string[] = []
  for (let i = 0; i < repeat; i += 1) {
    out.push(paragraphs[i % paragraphs.length]!)
  }
  return out.join("\n\n")
}

function makeDeps(overrides: Partial<MechanicalGateDeps> = {}): MechanicalGateDeps {
  return {
    readFileText: vi.fn(async () => {
      throw new Error("ENOENT")
    }),
    runContinuityPreflight: vi.fn(async () => []),
    loadCharacterNames: vi.fn(async () => []),
    loadUserMemory: vi.fn(async () => createDefaultStore()),
    analyzeStatisticalFactors: vi.fn(async () => null),
    readDefaultTargetChars: () => 3000,
    readDefaultGenre: () => undefined,
    ...overrides,
  }
}

describe("mechanical-gate (zero-LLM read-only facade)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("干净正文的裁决为 mechanical_pass_pending_semantic（永不返回 pass），且 P2 quality 恒为 pending", async () => {
    const preflightMock = vi.fn(async () => [])
    const report = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: buildCleanChapterProse(46),
        chapterNumber: 5,
        genre: "悬疑",
      },
      makeDeps({ runContinuityPreflight: preflightMock }),
    )

    expect(report.mechanicalOnly).toBe(true)
    expect(report.semanticReviewCompleted).toBe(false)
    expect(report.verdict).toBe("mechanical_pass_pending_semantic")
    expect(report.verdict).not.toBe("pass")
    expect(report.blockingGate).toBeNull()
    expect(report.gates.quality).toMatchObject({
      priority: "P2",
      status: "pending",
      verdict: "pending",
    })
    expect(report.decisionGates.overall).toBe("pending")
    expect(report.decisionGates.quality.status).toBe("pending")
    expect(report.bodyStats.lengthStatus).toBe("ok")
    expect(report.meta.llmCalls).toBe(0)
    expect(report.meta.diskWrites).toBe(0)

    // 验证向连续性预检显式传入只读 + 非阻断审计选项（零磁盘写）
    expect(preflightMock).toHaveBeenCalledTimes(1)
    expect(preflightMock).toHaveBeenCalledWith(
      "/proj",
      5,
      expect.objectContaining({
        readOnly: true,
        includeNonBlockingAudit: true,
      }),
    )
  })

  it("经 extractDeAiChapterBody 剥离 frontmatter 与 H1 标题后再检测，并精准输出行列号/偏移/片段", async () => {
    const markdown = [
      "---",
      "title: 毫无疑问的秘密",
      "summary: 这一切显然都是伏笔",
      "---",
      "",
      "# 第1章 毫无疑问",
      "",
      "第一行干净句子，窗外飘着细雨。",
      "第二行出现毫无疑问这个总结腔词。",
    ].join("\n")

    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text: markdown, targetChars: 500 },
      makeDeps(),
    )

    // frontmatter 和标题中的「毫无疑问」「这一切」「显然」不得进入正文 pinpoint 命中
    const terms = report.metrics.pinpointHits.map((h) => h.term)
    expect(terms).not.toContain("这一切")
    expect(terms).not.toContain("显然")

    const hit = report.metrics.pinpointHits.find((h) => h.term === "毫无疑问")
    expect(hit).toBeDefined()
    expect(hit!.line).toBe(2)
    expect(hit!.column).toBe(6)
    expect(hit!.endIndex - hit!.startIndex).toBe("毫无疑问".length)
    expect(hit!.snippet).toContain("毫无疑问")
  })

  it("纯 frontmatter 空正文时优雅回退到 rawText 而不崩溃", async () => {
    const raw = "---\ntitle: 空章\n---\n"
    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text: raw },
      makeDeps(),
    )

    expect(report.mechanicalOnly).toBe(true)
    expect(report.bodyStats.bodyChars).toBe(raw.length)
    expect(report.bodyStats.lengthStatus).toBe("under_min")
  })

  it("严守门控优先级 Consistency(P0) > Anti-AI(P1) > Quality(P2)：P0 与 P1 同时 error 时 blockingGate=consistency 且 P0 前置", async () => {
    const p0Error: NovelReviewResult = {
      severity: "error",
      type: "consistency_mechanical",
      message: "已故角色在第8章重新活跃",
      evidence: "character:林七",
      relatedMemory: "",
      suggestion: "删除已故角色的在场动作",
    }
    const heavySlop = [
      "毫无疑问，这一切显然说明了问题的复杂性，事实上无可否认的是，空气仿佛凝固。",
      "与此同时，紧接着就在这时，他心中五味杂陈，眼神变得坚定，目光交汇的瞬间似乎仿佛如同命运的安排。",
      "换句话说，简单来说，说白了在某种程度上他既感到失望又感到欣慰，不仅如此还充满微妙情绪。",
    ]
      .join("\n")
      .repeat(8)

    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text: heavySlop, chapterNumber: 8 },
      makeDeps({ runContinuityPreflight: async () => [p0Error] }),
    )

    expect(report.verdict).toBe("fail")
    expect(report.blockingGate).toBe("consistency")
    expect(report.gates.consistency.status).toBe("failed")
    expect(report.gates.anti_ai.status).toBe("failed")
    expect(report.gates.quality.status).toBe("pending")
    expect(report.decisionGates.overall).toBe("fail")
    expect(report.issues[0]?.priority).toBe("P0")
    expect(report.issues[0]?.gate).toBe("consistency")
  })

  it("P0 仅有 warning、P1 slop 触发 block 时：blockingGate=anti_ai 且前置 P0 warning 不被吞掉", async () => {
    const p0Warn: NovelReviewResult = {
      severity: "warning",
      type: "consistency_mechanical",
      message: "支线休眠 6 章未推进",
      evidence: "subplot:暗线",
      relatedMemory: "",
      suggestion: "适当回收或提及支线",
    }
    const heavySlop = "毫无疑问，这一切显然无可否认，事实上空气仿佛凝固，心中五味杂陈，眼神变得坚定，与此同时紧接着就在这时。".repeat(12)

    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text: heavySlop, chapterNumber: 8 },
      makeDeps({ runContinuityPreflight: async () => [p0Warn] }),
    )

    expect(report.verdict).toBe("fail")
    expect(report.blockingGate).toBe("anti_ai")
    expect(report.gates.consistency.warningCount).toBe(1)
    expect(report.gates.consistency.errorCount).toBe(0)
    expect(report.issues[0]?.priority).toBe("P0")
    expect(report.issues.some((i) => i.priority === "P1" && i.severity === "error")).toBe(true)
  })

  it("P0 读取 .novel/book-rules.json 校验 prohibitions / allowedDeviations / eraConstraints 与 fanficMode", async () => {
    const bookRulesJson = JSON.stringify({
      version: "1.0",
      prohibitions: ["灭世禁忌词", "豁免词"],
      allowedDeviations: ["豁免词"],
      eraConstraints: {
        enabled: true,
        period: "唐代",
        anachronismTerms: ["智能手机"],
      },
    })
    const text = `${buildCleanChapterProse(22)}\n\n他掏出智能手机，念出灭世禁忌词与豁免词。`

    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text, chapterNumber: 3 },
      makeDeps({
        readFileText: async (path) => {
          if (path.endsWith("/.novel/book-rules.json")) return bookRulesJson
          throw new Error("ENOENT")
        },
      }),
    )

    expect(report.metrics.bookRules.loaded).toBe(true)
    expect(report.metrics.bookRules.verdict).toBe("violate")
    // 「灭世禁忌词」命中 error，「智能手机」命中 warn，「豁免词」被 allowedDeviations 豁免
    expect(report.metrics.bookRules.findings.map((f) => f.term)).toEqual(["灭世禁忌词", "智能手机"])
    expect(report.blockingGate).toBe("consistency")
    expect(report.verdict).toBe("fail")
    expect(report.gates.consistency.errorCount).toBe(1)
    expect(report.gates.consistency.warningCount).toBe(1)
  })

  it("P1 检测角色重复动作、轮唱、静默段、改写器腔、统计因子、用户避用词与字数超限", async () => {
    const userStore: UserMemoryStore = {
      ...createDefaultStore(),
      preferences: [
        {
          id: "pref-1",
          key: "avoid_words_custom",
          value: "骤然, 蓦地",
          category: "vocabulary",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }

    const statReport: AntiAiAnalysisReport = {
      factors: [
        {
          factor: "sentenceEntropy",
          value: 0.42,
          threshold: 0.7,
          warn: true,
          description: "句长熵偏低",
        },
      ],
      hasWarnings: true,
      warningCount: 1,
      summary: "[warn] 1 个因子触发警告: sentenceEntropy",
      calibrationSource: "synthetic-degraded",
    }

    const chorus = [
      "“快走！”",
      "“别回头！”",
      "“跟紧我！”",
      "“前面有光！”",
    ].join("\n\n")
    const silentParas = Array.from({ length: 9 }, (_, i) => `雨幕里的街巷空无一人，石阶湿滑第${i + 1}步。`).join("\n\n")
    const fillerBurst = "呃，嗯，那个，他低声咕哝着，骤然抬头，林墨推了推眼镜，林墨推了推眼镜，林墨推了推眼镜。"
    const longBody = [fillerBurst, chorus, silentParas, buildCleanChapterProse(45)].join("\n\n")

    const report = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: longBody,
        characterNames: ["林墨"],
        targetChars: 1500,
      },
      makeDeps({
        loadUserMemory: async () => userStore,
        analyzeStatisticalFactors: async () => statReport,
      }),
    )

    expect(report.metrics.characterActions.some((h) => h.action === "推眼镜" && h.totalCount >= 3)).toBe(true)
    expect(report.metrics.chorusHits.length).toBeGreaterThan(0)
    expect(report.metrics.silentStretches.length).toBeGreaterThan(0)
    expect(report.metrics.overCorrection.flags.length).toBeGreaterThan(0)
    expect(report.metrics.statisticalFactors.available).toBe(true)
    expect(report.metrics.statisticalFactors.hasWarnings).toBe(true)
    expect(report.metrics.avoidWordHits).toEqual([{ word: "骤然", count: 1 }])
    expect(report.bodyStats.lengthStatus).toBe("over_draft_max")

    const p1Messages = report.gates.anti_ai.issues.map((i) => i.message).join("\n")
    expect(p1Messages).toContain("角色行为模式")
    expect(p1Messages).toContain("轮唱对话信号")
    expect(p1Messages).toContain("角色长段静默")
    expect(p1Messages).toContain("改写痕迹警告")
    expect(p1Messages).toContain("统计因子警告")
    expect(p1Messages).toContain("命中用户避用词")
    expect(p1Messages).toContain("章节字数超出初稿上限")
    expect(report.gates.quality.status).toBe("pending")
  })

  it("真实 fanficMode（canon / ooc）规则经 validateFanficChapter 生效：否定性格锁与未标注 OOC 均在 P0 拦截", async () => {
    const canonRulesJson = JSON.stringify({
      version: "1.0",
      prohibitions: [],
      allowedDeviations: [],
      protagonist: {
        name: "顾青",
        personalityLock: ["坚守底线"],
        behavioralConstraints: [],
      },
      fanficMode: "canon",
    })
    const canonReport = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: `${buildCleanChapterProse(20)}\n\n顾青冷笑一声，他已经不再坚守底线。`,
        chapterNumber: 4,
      },
      makeDeps({
        readFileText: async (path) => {
          if (path.endsWith("/.novel/book-rules.json")) return canonRulesJson
          throw new Error("ENOENT")
        },
      }),
    )
    expect(canonReport.metrics.bookRules.loaded).toBe(true)
    expect(canonReport.metrics.bookRules.verdict).toBe("violate")
    expect(canonReport.metrics.bookRules.findings.some((f) => f.code === "fanfic_canon_lock")).toBe(true)
    expect(canonReport.blockingGate).toBe("consistency")
    expect(canonReport.verdict).toBe("fail")

    const oocRulesJson = JSON.stringify({
      version: "1.0",
      prohibitions: [],
      allowedDeviations: [],
      protagonist: {
        name: "顾青",
        personalityLock: ["冷漠克制"],
        behavioralConstraints: [],
      },
      fanficMode: "ooc",
    })
    const oocUnmarked = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: `${buildCleanChapterProse(20)}\n\n顾青一反常态打破了冷漠克制的样子。`,
        chapterNumber: 4,
      },
      makeDeps({
        readFileText: async (path) => {
          if (path.endsWith("/.novel/book-rules.json")) return oocRulesJson
          throw new Error("ENOENT")
        },
      }),
    )
    expect(oocUnmarked.metrics.bookRules.verdict).toBe("violate")
    expect(oocUnmarked.metrics.bookRules.findings.some((f) => f.code === "fanfic_ooc_unmarked")).toBe(true)
    expect(oocUnmarked.blockingGate).toBe("consistency")

    const oocMarked = await runMechanicalGateForMcp(
      {
        projectPath: "/proj",
        text: `${buildCleanChapterProse(20)}\n\n【OOC】顾青一反常态打破了冷漠克制的样子。`,
        chapterNumber: 4,
      },
      makeDeps({
        readFileText: async (path) => {
          if (path.endsWith("/.novel/book-rules.json")) return oocRulesJson
          throw new Error("ENOENT")
        },
      }),
    )
    expect(oocMarked.metrics.bookRules.verdict).toBe("comply")
    expect(oocMarked.metrics.bookRules.findings).toEqual([])
  })

  it("buildPinpointSnippet 对 emoji 与 CJK Ext-B UTF-16 代理对边界安全，绝不切出孤立代理码元", async () => {
    const loneSurrogateRe = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const hasNoLoneSurrogates = (value: string): boolean => !loneSurrogateRe.test(value)
    // 构造精确命中低代理(from=2)与高代理(to-1=45)边界的文本：
    // 'x'(0) + 10×'😀'(1..20) + 'a'(21) + '毫无疑问'(22..25) + 'b'(26) + 11×'𠀀'(27..48)
    const text = `x${"😀".repeat(10)}a毫无疑问b${"𠀀".repeat(11)}`
    const startIndex = text.indexOf("毫无疑问")
    const endIndex = startIndex + "毫无疑问".length
    expect(startIndex).toBe(22)
    expect(endIndex).toBe(26)

    const snippet = buildPinpointSnippet(text, startIndex, endIndex)
    expect(hasNoLoneSurrogates(snippet)).toBe(true)
    expect(snippet.startsWith("…😀")).toBe(true)
    expect(snippet.endsWith("𠀀…")).toBe(true)
    expect(snippet).toContain("毫无疑问")

    // 端到端经 runMechanicalGateForMcp 验证 pinpointHits 同样无孤立代理码元
    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text, targetChars: 500 },
      makeDeps(),
    )
    const hit = report.metrics.pinpointHits.find((h) => h.term === "毫无疑问")
    expect(hit).toBeDefined()
    expect(hasNoLoneSurrogates(hit!.snippet)).toBe(true)
  })

  it("pinpointHits 命中数超过 MAX_PINPOINT_HITS(200) 时严格截断并标注 pinpointTruncated=true", async () => {
    const manyHitsText = Array.from({ length: 220 }, (_, i) => `第${i + 1}句毫无疑问地出现。`).join("\n")
    const report = await runMechanicalGateForMcp(
      { projectPath: "/proj", text: manyHitsText, targetChars: 3000 },
      makeDeps(),
    )
    expect(report.metrics.pinpointTotalCount).toBeGreaterThan(200)
    expect(report.metrics.pinpointHits).toHaveLength(200)
    expect(report.metrics.pinpointTruncated).toBe(true)
  })

  it("book-rules.json 损坏或结构非法时优雅降级（loaded=false，不抛错）", async () => {
    for (const badJson of ["{not-valid-json", "[]", "null", "123"]) {
      const report = await runMechanicalGateForMcp(
        { projectPath: "/proj", text: buildCleanChapterProse(46), chapterNumber: 2 },
        makeDeps({
          readFileText: async (path) => {
            if (path.endsWith("/.novel/book-rules.json")) return badJson
            throw new Error("ENOENT")
          },
        }),
      )
      expect(report.metrics.bookRules.loaded).toBe(false)
      expect(report.metrics.bookRules.verdict).toBe("comply")
      expect(report.metrics.bookRules.findings).toEqual([])
      expect(report.verdict).toBe("mechanical_pass_pending_semantic")
    }
  })
})
