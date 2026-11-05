import { describe, expect, it } from "vitest"
import { runEvalCase, runEvalSuite } from "./eval-harness"
import type { ContextPack } from "../context-engine"
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type { EvalCase, EvalRunConfig, GoldChunk, PoisonChunk } from "./eval-schema"

const EMPTY_PACK: ContextPack = {
  task: "eval",
  chapterGoal: "",
  outline: "",
  recentSummaries: [],
  previousChapterEnding: "",
  characterStates: "",
  soulDoc: "",
  characterAuras: "",
  cognitionStates: "",
  foreshadowingStates: "",
  timeline: "",
  relatedSettings: "",
  canonRules: "",
  writingStyle: "",
  searchResults: "",
  graphSearchResults: "",
  mustDo: "",
  mustAvoid: "",
  nextChapterAdvice: "",
  revisionDirectives: "",
}

function gold(id: string, subject: string, predicate: string, object: string): GoldChunk {
  return { id, subject, predicate, object, tier: "protected", expectedLayer: "protected" }
}

function poison(
  id: string,
  subject: string,
  predicate: string,
  object: string,
  poisonType: PoisonChunk["poisonType"] = "contradiction",
  expectedLanding: PoisonChunk["expectedLanding"] = "excluded",
): PoisonChunk {
  return { id, subject, predicate, object, poisonType, expectedLanding }
}

function evalCase(id: string, goldChunks: GoldChunk[], poisonChunks: PoisonChunk[]): EvalCase {
  return { id, chapter: 3, query: "一致性评测", goldChunks, poisonChunks, expectedLayer: "protected", source: "synthetic" }
}

function criticalMechanicalFinding(): ContinuityFinding {
  return {
    type: "dormant_thread",
    subtype: "consistency_mechanical",
    severity: "critical",
    ref: "subplot:复仇线",
    message: "机械检测命中",
    chapter: 3,
  }
}

describe("runEvalCase", () => {
  it("gold 命中且毒丸未进 protected → 全层通过（L3 缺省跳过、secondSignal 缺省）", async () => {
    const goldChunk = gold("g-1", "爱丽丝", "持有", "圣剑")
    const poisonChunk = poison("p-1", "鲍勃", "背叛", "王国")
    const caseItem = evalCase("case-pass", [goldChunk], [poisonChunk])

    const result = await runEvalCase(caseItem, {
      assemble: async () => ({
        ...EMPTY_PACK,
        canonRules: `${goldChunk.subject} ${goldChunk.predicate} ${goldChunk.object}`,
        searchResults: `${poisonChunk.subject} ${poisonChunk.predicate} ${poisonChunk.object}`,
      }),
    })

    expect(result.caseId).toBe("case-pass")
    expect(result.passed).toBe(true)
    expect(result.layers.L1.pass).toBe(true)
    expect(result.layers.L1.score).toBe(1)
    expect(result.layers.L2.pass).toBe(true)
    expect(result.layers.L2.score).toBe(1)
    expect(result.layers.L3.pass).toBe(true)
    expect(result.layers.L3.detail).toMatchObject({ skipped: true })
    expect(result.secondSignal).toBeUndefined()
    expect(result.rejections).toEqual([])
  })

  it("gold 缺失 → L1 失败且整体失败", async () => {
    const caseItem = evalCase("case-l1-fail", [gold("g-1", "爱丽丝", "持有", "圣剑")], [])

    const result = await runEvalCase(caseItem, {
      assemble: async () => ({ ...EMPTY_PACK, canonRules: "无关的正典文本" }),
    })

    expect(result.passed).toBe(false)
    expect(result.layers.L1.pass).toBe(false)
    expect(result.layers.L1.score).toBe(0)
  })

  it("毒丸进入 protected → L2 失败", async () => {
    const poisonChunk = poison("p-1", "鲍勃", "背叛", "王国")
    const caseItem = evalCase("case-l2-fail", [], [poisonChunk])

    const result = await runEvalCase(caseItem, {
      assemble: async () => ({
        ...EMPTY_PACK,
        canonRules: `${poisonChunk.subject} ${poisonChunk.predicate} ${poisonChunk.object}`,
      }),
    })

    expect(result.passed).toBe(false)
    expect(result.layers.L2.pass).toBe(false)
    expect(result.layers.L2.detail).toMatchObject({ leaks: 1, total: 1 })
  })

  it("former 类毒丸同时落 former 层 → 豁免通过", async () => {
    const poisonChunk = poison("p-former", "旧城邦", "位于", "地表", "former_as_current", "former")
    const triple = `${poisonChunk.subject} ${poisonChunk.predicate} ${poisonChunk.object}`
    const caseItem = evalCase("case-former", [], [poisonChunk])

    const result = await runEvalCase(caseItem, {
      assemble: async () => ({
        ...EMPTY_PACK,
        characterStates: triple,
        formerFacts: [{ id: "f-1", subject: poisonChunk.subject, predicate: poisonChunk.predicate, object: poisonChunk.object, validFrom: 1, validUntil: 2, former: true, source: "synthetic" }],
      }),
    })

    expect(result.layers.L2.pass).toBe(true)
    expect(result.layers.L2.score).toBe(1)
  })

  it("l3Findings 返回 critical 机械发现 → L3 失败", async () => {
    const caseItem = evalCase("case-l3-fail", [], [])

    const result = await runEvalCase(caseItem, {
      assemble: async () => EMPTY_PACK,
      l3Findings: async () => [criticalMechanicalFinding()],
    })

    expect(result.layers.L3.pass).toBe(false)
    expect(result.layers.L3.score).toBe(1)
    expect(result.passed).toBe(false)
  })

  it("l3Findings 返回非 critical 发现 → L3 通过", async () => {
    const caseItem = evalCase("case-l3-pass", [], [])

    const result = await runEvalCase(caseItem, {
      assemble: async () => EMPTY_PACK,
      l3Findings: async () => [
        { ...criticalMechanicalFinding(), severity: "warning" as const },
      ],
    })

    expect(result.layers.L3.pass).toBe(true)
    expect(result.layers.L3.score).toBe(0)
  })

  it("secondSignal 接线时回填到结果", async () => {
    const caseItem = evalCase("case-signal", [], [])

    const result = await runEvalCase(caseItem, {
      assemble: async () => EMPTY_PACK,
      secondSignal: async () => ({ status: "run", obligationCount: 1, formerCount: 1, warnings: [] }),
    })

    expect(result.secondSignal).toMatchObject({ status: "run", obligationCount: 1 })
    expect(result.passed).toBe(true)
  })
})

describe("runEvalSuite", () => {
  const passCase = evalCase("suite-pass", [gold("g-1", "爱丽丝", "持有", "圣剑")], [])
  const failCase = evalCase("suite-fail", [gold("g-2", "查理", "失去", "王冠")], [])
  const options = {
    assemble: async (caseItem: EvalCase) => ({
      ...EMPTY_PACK,
      canonRules: caseItem.id === "suite-pass" ? "爱丽丝 持有 圣剑" : "无关文本",
    }),
  }
  const thresholds = { l1Min: 0.95, l2Min: 0.99, l3Max: 0.01 }

  it("默认 replayOnlyFailed=true 只保留失败 case（缺省与未传配置均回退 true）", async () => {
    const withoutConfig = await runEvalSuite([passCase, failCase], options)
    expect(withoutConfig.cases.map((c) => c.caseId)).toEqual(["suite-fail"])

    const withoutField = await runEvalSuite([passCase, failCase], options, { thresholds } as EvalRunConfig)
    expect(withoutField.cases.map((c) => c.caseId)).toEqual(["suite-fail"])
    expect(withoutField.aggregate.overall).toBe(false)
    expect(withoutField.aggregate.layers.L1.score).toBe(0)
  })

  it("replayOnlyFailed=false 保留全部 case 并平均聚合", async () => {
    const result = await runEvalSuite([passCase, failCase], options, { replayOnlyFailed: false, thresholds })

    expect(result.cases.map((c) => c.caseId)).toEqual(["suite-pass", "suite-fail"])
    expect(result.aggregate.layers.L1.score).toBeCloseTo(0.5)
    expect(result.aggregate.layers.L1.pass).toBe(false)
  })

  it("caseIds 过滤只运行指定 case", async () => {
    const result = await runEvalSuite([passCase, failCase], options, {
      replayOnlyFailed: false,
      caseIds: ["suite-pass"],
      thresholds,
    })

    expect(result.cases.map((c) => c.caseId)).toEqual(["suite-pass"])
    expect(result.aggregate.overall).toBe(true)
  })

  it("全部通过且仅重跑失败 → 空结果聚合为跳过通过", async () => {
    const result = await runEvalSuite([passCase], options, { replayOnlyFailed: true, thresholds })

    expect(result.cases).toEqual([])
    expect(result.aggregate.overall).toBe(true)
    expect(result.aggregate.layers.L1).toMatchObject({ pass: true, score: 1 })
  })
})
