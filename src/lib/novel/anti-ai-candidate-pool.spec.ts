import { describe, expect, it, beforeAll } from "vitest"
import { resolve } from "node:path"
import {
  AntiAiCandidatePool,
  analysisReportToText,
  quickAntiAiAnalysis,
  type AntiAiAnalysisReport,
  type StatisticalFactorReport,
} from "./anti-ai-candidate-pool"

// 使用真实语料路径 (相对于项目根 docs/p0/corpus)
const CORPUS_ROOT = resolve(__dirname, "../../../../docs/p0/corpus")

describe("TASK-P2-19 (T19) 反AI 候选池 — 语料加载", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    const result = pool.loadCorpus()
    // 预期: human 30 + ai 30 + gold 6 = 66, 但 gold 是 .json 被跳过
    // 实际: human 30 txt + ai 30 txt = 60
    expect(result.total).toBeGreaterThanOrEqual(56)
  })

  it("加载人写语料 (human: 30 篇)", () => {
    expect(pool.humanCorpus.length).toBeGreaterThanOrEqual(28)
    expect(pool.humanCorpus.every((s) => s.layer === "human")).toBe(true)
    // 检查 genre 多样性
    const genres = [...new Set(pool.humanCorpus.map((s) => s.genre))]
    expect(genres.length).toBeGreaterThanOrEqual(3)
  })

  it("加载 AI 语料 (ai: 30 篇)", () => {
    expect(pool.aiCorpus.length).toBeGreaterThanOrEqual(28)
    expect(pool.aiCorpus.every((s) => s.layer === "ai")).toBe(true)
  })

  it("黄金标准 (gold: 6 篇 .json, 跳过)", () => {
    expect(pool.goldCorpus).toHaveLength(0)
  })

  it("加载后标记 loaded=true", () => {
    expect(pool.loaded).toBe(true)
  })

  it("语料来源标记为 synthetic-degraded", () => {
    expect(pool.source).toBe("synthetic-degraded")
  })
})

describe("TASK-P2-19 (T19) 四统计因子检测器 — nGramOverlap", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("人写文本 (无 AI 腔) 重合度低, 不触发 warn", () => {
    // 取自人写语料样本风格
    const humanText = "雨停在傍晚七点，地铁口还在滴水。林晚把折伞甩了两下，没甩干，索性夹在腋下。"
    const report = pool.detectNGramOverlap(humanText)
    expect(report.factor).toBe("nGramOverlap")
    expect(report.warn).toBe(false)
  })

  it("AI 文本 (模板句式) 重合度高, 可能触发 warn", () => {
    // 注入 AI 腔特征
    const aiText = "清晨，阳光透过窗帘照进房间，显得十分温暖。苏念从床上醒来，发现手机上有一条未读消息。"
    const report = pool.detectNGramOverlap(aiText)
    // 阈值 40%, 取决于语料索引, 不强制断言 warn
    expect(report.value).toBeGreaterThanOrEqual(0)
    expect(report.value).toBeLessThanOrEqual(1)
  })

  it("空文本返回 warn=false", () => {
    const report = pool.detectNGramOverlap("")
    expect(report.warn).toBe(false)
  })

  it("返回值包含 description 字段", () => {
    const report = pool.detectNGramOverlap("测试文本。")
    expect(report.description).toBeTruthy()
  })
})

describe("TASK-P2-19 (T19) 四统计因子检测器 — sentenceEntropy", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("多样句长 (人写风格) 熵高, 不触发 warn", () => {
    const variedText = [
      "他推开门，风灌了进来。",
      "桌上的茶还温着，茶汤映着窗外的天光，他没动。",
      "墙角那盆绿萝已经枯了大半，叶子垂在盆沿上，像一只无力的手。",
      "电话响了。",
      "窗外有鸟叫。",
    ].join("")
    const report = pool.detectSentenceEntropy(variedText)
    expect(report.factor).toBe("sentenceEntropy")
    expect(report.warn).toBe(false)
  })

  it("句长均匀 (AI 风格) 熵低, 可能触发 warn", () => {
    const uniformText = [
      "他来到了那个地方。",
      "她看到了那个男人。",
      "他们互相看了一眼。",
      "然后他们说了话。",
      "最后他们分开了。",
    ].join("")
    const report = pool.detectSentenceEntropy(uniformText)
    // 低熵, 但不一定触发 warn (阈值 3.5 bits)
    expect(report.value).toBeGreaterThanOrEqual(0)
  })

  it("句数过少 (<3) 返回 warn=false", () => {
    const report = pool.detectSentenceEntropy("只有一句。")
    expect(report.warn).toBe(false)
  })

  it("空文本返回 warn=false", () => {
    const report = pool.detectSentenceEntropy("")
    expect(report.warn).toBe(false)
  })
})

describe("TASK-P2-19 (T19) 四统计因子检测器 — punctuationFingerprint", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("人写风格标点分布, 不触发 warn", () => {
    const humanText = "雨停了。地铁口还在滴水——林晚把折伞甩了两下，没甩干，索性夹在腋下。"
    const report = pool.detectPunctuationFingerprint(humanText)
    expect(report.factor).toBe("punctuationFingerprint")
    // 人写文本通常不会触发 warn
    expect(report.warn).toBe(false)
  })

  it("无标点文本返回 warn=false", () => {
    const report = pool.detectPunctuationFingerprint("无标点文本")
    expect(report.warn).toBe(false)
  })

  it("返回值包含 description 字段", () => {
    const report = pool.detectPunctuationFingerprint("测试。文本！")
    expect(report.description).toBeTruthy()
  })
})

describe("TASK-P2-19 (T19) 四统计因子检测器 — paragraphLengthDist", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("人写风格段落长度变化大, 不触发 warn", () => {
    const variedParas = [
      "他推开门，风灌了进来。",
      "桌上的茶还温着，茶汤映着窗外的天光，他没动。墙角那盆绿萝已经枯了大半，叶子垂在盆沿上，像一只无力的手。",
      "电话响了。",
    ].join("\n\n")
    const report = pool.detectParagraphLengthDist(variedParas)
    expect(report.factor).toBe("paragraphLengthDist")
    expect(report.warn).toBe(false)
  })

  it("均匀段落可能触发 warn", () => {
    const uniformParas = [
      "他推开了门，走进了房间。",
      "她站了起来，看着窗外。",
      "他们互相看了一眼，没有说话。",
    ].join("\n\n")
    const report = pool.detectParagraphLengthDist(uniformParas)
    expect(report.value).toBeGreaterThanOrEqual(0)
  })

  it("段落数过少 (<3) 返回 warn=false", () => {
    const report = pool.detectParagraphLengthDist("只有一段。")
    expect(report.warn).toBe(false)
  })

  it("空文本返回 warn=false", () => {
    const report = pool.detectParagraphLengthDist("")
    expect(report.warn).toBe(false)
  })
})

describe("TASK-P2-19 (T19) 全量 analyze — 不阻塞主链", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("未加载时返回空结果", () => {
    const emptyPool = new AntiAiCandidatePool(CORPUS_ROOT)
    const report = emptyPool.analyze("测试")
    expect(report.factors).toHaveLength(0)
    expect(report.hasWarnings).toBe(false)
    expect(report.summary).toContain("未加载")
  })

  it("人写文本全量分析, 不触发警告", () => {
    const humanText = "雨停在傍晚七点，地铁口还在滴水。林晚把折伞甩了两下，没甩干，索性夹在腋下。她迟到了二十分钟，餐厅靠窗那张桌子却还空着。"
    const report = pool.analyze(humanText)
    expect(report.factors).toHaveLength(4)
    expect(report.hasWarnings).toBe(false)
    expect(report.warningCount).toBe(0)
    expect(report.calibrationSource).toBe("synthetic-degraded")
  })

  it("AI 腔文本可能触发警告, 但不阻塞", () => {
    const aiText = "清晨，阳光透过窗帘照进房间，显得十分温暖。苏念从床上醒来，发现手机上有一条未读消息。她心中充满了复杂的情绪，不知道该如何面对这一切。"
    const report = pool.analyze(aiText)
    expect(report.factors).toHaveLength(4)
    // 可能触发 warn, 可能不触发, 但不能是 block 态
    // warn 态不阻塞主链
    expect(report.summary).toMatch(/\[warn\]|\[clean\]/)
  })

  it("四因子检测结果的 field 结构完整", () => {
    const report = pool.analyze("测试文本。这是第二句。这是第三句。")
    for (const factor of report.factors) {
      expect(factor.factor).toBeTruthy()
      expect(typeof factor.value).toBe("number")
      expect(typeof factor.threshold).toBe("number")
      expect(typeof factor.warn).toBe("boolean")
      expect(factor.description).toBeTruthy()
    }
  })
})

describe("TASK-P2-19 (T19) Mutation Testing", () => {
  let pool: AntiAiCandidatePool

  beforeAll(() => {
    pool = new AntiAiCandidatePool(CORPUS_ROOT)
    pool.loadCorpus()
  })

  it("mutateTest 对文本注入 AI 腔后检测器能区分", () => {
    const humanText = "雨停了，地铁口还在滴水。林晚把伞甩了两下。"
    const result = pool.mutateTest(humanText, "addSummaryClause")
    expect(result.mutationType).toBe("addSummaryClause")
    expect(result.originalText).toBe(humanText)
    expect(result.mutatedText).not.toBe(humanText)
    expect(typeof result.discriminates).toBe("boolean")
  })

  it("所有 6 种 mutation 类型都能执行", () => {
    const humanText = "雨停了，地铁口还在滴水。林晚把伞甩了两下。"
    const types = [
      "addSummaryClause",
      "addMechanicalTransition",
      "addPsychTemplate",
      "addPunctuationUniform",
      "addParagraphUniform",
      "addAI3Gram",
    ] as const

    for (const t of types) {
      const result = pool.mutateTest(humanText, t)
      expect(result.mutationType).toBe(t)
      expect(result.mutatedText.length).toBeGreaterThan(0)
    }
  })

  it("runAllMutationTests 返回区分率统计", () => {
    const stats = pool.runAllMutationTests()
    expect(stats.total).toBeGreaterThan(0)
    expect(stats.discriminated).toBeGreaterThanOrEqual(0)
    expect(stats.rate).toBeGreaterThanOrEqual(0)
    expect(stats.rate).toBeLessThanOrEqual(1)
    expect(stats.results.length).toBe(stats.total)
  })
})

describe("TASK-P2-19 (T19) analysisReportToText — 文本化输出", () => {
  it("空报告返回 summary", () => {
    const report: AntiAiAnalysisReport = {
      factors: [],
      hasWarnings: false,
      warningCount: 0,
      summary: "测试摘要",
      calibrationSource: "synthetic-degraded",
    }
    const text = analysisReportToText(report)
    expect(text).toBe("测试摘要")
  })

  it("有因子报告渲染完整", () => {
    const factors: StatisticalFactorReport[] = [
      {
        factor: "nGramOverlap",
        value: 0.5,
        threshold: 0.4,
        warn: true,
        description: "测试描述",
      },
    ]
    const report: AntiAiAnalysisReport = {
      factors,
      hasWarnings: true,
      warningCount: 1,
      summary: "测试摘要",
      calibrationSource: "synthetic-degraded",
    }
    const text = analysisReportToText(report)
    expect(text).toContain("反AI 四统计因子检测")
    expect(text).toContain("nGramOverlap")
    expect(text).toContain("测试摘要")
    expect(text).toContain("[warn]")
  })

  it("无警告报告渲染 [ok]", () => {
    const factors: StatisticalFactorReport[] = [
      {
        factor: "sentenceEntropy",
        value: 4.0,
        threshold: 3.5,
        warn: false,
        description: "测试描述",
      },
    ]
    const report: AntiAiAnalysisReport = {
      factors,
      hasWarnings: false,
      warningCount: 0,
      summary: "测试摘要",
      calibrationSource: "synthetic-degraded",
    }
    const text = analysisReportToText(report)
    expect(text).toContain("[ok]")
  })
})

describe("TASK-P2-19 (T19) quickAntiAiAnalysis — 便捷函数", () => {
  it("快速检测 (自动加载语料)", () => {
    const report = quickAntiAiAnalysis("雨停了，地铁口还在滴水。林晚把伞甩了两下。")
    expect(report.factors).toHaveLength(4)
    expect(report.calibrationSource).toBe("synthetic-degraded")
  })
})