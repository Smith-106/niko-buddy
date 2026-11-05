import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  assessChapter,
  buildFix,
  extractSignals,
  scoreDimension,
  DIMENSION_KEYS,
  type ChapterSignals,
  type SelfAssessmentInput,
} from "./self-assessment"

const NOVEL_DIR = resolve(__dirname)
function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

/** 构建含对话、场景断开与段落分隔的"健康"章节文本。 */
function healthyText(): string {
  return [
    "他推开门走了进去。屋里的人抬起头。",
    "“你来了。”她说。",
    "“嗯。”他点了点头。",
    "夜风从窗缝灌进来，烛火晃了晃。两人一时无言，只听得见彼此的呼吸。",
    "",
    "“那件事查得怎么样了？”他问。",
    "“有眉目了。”她压低声音，“但需要一个帮手。”",
    "他沉默了一会儿，最终嗯了一声。窗外的灯终于彻底暗下去。",
  ].join("\n")
}

describe("C8 self-assessment — 纯函数/零 LLM", () => {
  it("模块源码不含 llm-client / streamChat / invoke 依赖", () => {
    const src = readSource("self-assessment.ts")
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/\bstreamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })
})

describe("extractSignals 信号抽取方向", () => {
  it("健康文本：发出若干对话字符与场景断点", () => {
    const s = extractSignals(healthyText())
    expect(s.charCount).toBeGreaterThan(0)
    expect(s.sentenceCount).toBeGreaterThan(0)
    expect(s.dialogueChars).toBeGreaterThan(0)
    expect(s.sceneBreakCount).toBe(1) // 中间空行
  })

  it("空白/空文本安全（不抛错，计数为 0）", () => {
    const s = extractSignals("")
    expect(s.charCount).toBe(0)
    expect(s.dialogueChars).toBe(0)
    expect(s.sceneBreakCount).toBe(0)
    expect(s.openingHasEmphatic).toBe(true) // 空首句 < 30 字 => 视为"短句钩子"默认
  })
})

describe("scoreDimension 各维度打分方向", () => {
  it("length：短文本得分低，补齐后提升", () => {
    const shortSignals = extractSignals("很短。")
    const longSignals = extractSignals(healthyText() + healthyText() + healthyText())
    const short = scoreDimension("length", shortSignals)
    const long = scoreDimension("length", longSignals, { targetLength: 1000 })
    expect(short.score).toBeLessThan(long.score)
  })

  it("dialogueRatio：穷对话>富对话占比方向", () => {
    const noisy = extractSignals("他走了很久。风很大。天黑了。")
    const chatty = extractSignals('“快走。”他说。“跟上。”她答。')
    expect(scoreDimension("dialogueRatio", chatty).score)
      .toBeGreaterThan(scoreDimension("dialogueRatio", noisy).score)
  })
})

describe("scoreDimension 打分方向续", () => {
  it("sentenceVariety：长短交错>齐整句", () => {
    const varied = extractSignals("他走。他看见远方绵延不绝的山脉在暮色里缓缓溶化、下沉，透出最后一缕金。" + "走。走。")
    const flat = extractSignals("他走了很长的一段路，看见了很多的山，然后天就黑了，他也累了。")
    expect(scoreDimension("sentenceVariety", varied).score)
      .toBeGreaterThan(scoreDimension("sentenceVariety", flat).score)
  })

  it("sceneBreaks：分段多的>大段不分", () => {
    const breaks = extractSignals(["第一段。", "", "第二段。", "", "第三段。"].join("\n"))
    const wall = extractSignals("第一段连续。第二段连续。第三段连续。")
    expect(scoreDimension("sceneBreaks", breaks).score)
      .toBeGreaterThan(scoreDimension("sceneBreaks", wall).score)
  })

  it("openingHook：以对话开场>长篇铺陈", () => {
    const hook = extractSignals('“站住！”她喝道。远处那人停了一下。')
    const long = extractSignals("这是一个关于遥远天际与荒漠商站之间种种羁绊的漫长故事，从很久很久以前说起。")
    expect(scoreDimension("openingHook", hook).score)
      .toBeGreaterThan(scoreDimension("openingHook", long).score)
  })
})

describe("gap 触发与阈值", () => {
  it("短文本在默认阈值下 length 维度命中 gap", async () => {
    const res = await assessChapter({ text: "很短。" })
    const len = res.scores.find((s) => s.key === "length")!
    expect(len.gap).toBe(true)
    expect(res.gaps.map((g) => g.key)).toContain("length")
  })

  it("goals 覆盖阈值可翻转 gap 判定", async () => {
    const input: SelfAssessmentInput = {
      text: "很短。",
      goals: { thresholds: { length: 0 } },
    }
    const res = await assessChapter(input)
    const len = res.scores.find((s) => s.key === "length")!
    expect(len.gap).toBe(false)
  })
})

describe("fix 与 gap 对齐", () => {
  it("fixes 与 gaps 一一对应（同维度、同数量）", async () => {
    const res = await assessChapter({ text: "很短。" })
    expect(res.fixes.length).toBe(res.gaps.length)
    for (let i = 0; i < res.gaps.length; i += 1) {
      expect(res.fixes[i]!.dimension).toBe(res.gaps[i]!.key)
      expect(res.fixes[i]!.currentScore).toBe(res.gaps[i]!.score)
      expect(res.fixes[i]!.text.length).toBeGreaterThan(0)
      expect(res.fixes[i]!.label).toBe(res.gaps[i]!.label)
    }
  })

  it("buildFix 对每个 gap 维度都产出非空可执行文案", () => {
    for (const key of DIMENSION_KEYS) {
      const fix = buildFix({
        key,
        label: "测试",
        score: 10,
        gap: true,
        threshold: 50,
        evidence: "x",
      })
      expect(fix.text.length).toBeGreaterThan(10)
      expect(fix.dimension).toBe(key)
    }
  })
})

describe("空输入安全 / LLM 扩展缝", () => {
  it("空文本不抛错：scores 六维齐全、gaps 生成、overall 为 0", async () => {
    const res = await assessChapter({ text: "" })
    expect(res.scores).toHaveLength(DIMENSION_KEYS.length)
    expect(res.gaps.length).toBeGreaterThan(0)
    expect(res.overall).toBe(0)
    expect(res.degraded).toBe(true)
  })

  it("未注入 llm => degraded=true", async () => {
    const res = await assessChapter({ text: healthyText() })
    expect(res.degraded).toBe(true)
  })

  it("注入 llm 覆盖各维打分 => degraded=false 且采用覆盖值", async () => {
    const res = await assessChapter(
      { text: healthyText() },
      {
        llm: {
          async evaluate() {
            return {
              length: 90,
              dialogueRatio: 95,
              paragraphRhythm: 85,
              sentenceVariety: 90,
              sceneBreaks: 80,
              openingHook: 95,
            }
          },
        },
      }
    )
    expect(res.degraded).toBe(false)
    expect(res.scores.find((s) => s.key === "length")!.score).toBe(90)
    expect(res.gaps).toHaveLength(0)
  })

  it("注入 llm 抛错 => 回退机械打分并保持 degraded=true", async () => {
    const res = await assessChapter(
      { text: "很短。" },
      {
        llm: {
          async evaluate() {
            throw new Error("llm boom")
          },
        },
      }
    )
    expect(res.degraded).toBe(true)
    // 回退后 length 仍为低分（机械）。
    expect(res.scores.find((s) => s.key === "length")!.gap).toBe(true)
  })
})

// ── 覆盖加深（增补：原有用例保留不动）─────────────────────────────────────────
// 目标：三处「区间上沿」打分分支（对话过多、段落过长）、目标篇幅为 0、
// 以及两个运行时防线（text 为 null / 缺省）与非有限 LLM 覆盖值。

/** 直接构造信号表，用于钉死打分公式的边界（不走 extractSignals 的文本路径）。 */
function signals(overrides: Partial<ChapterSignals> = {}): ChapterSignals {
  return {
    charCount: 3000,
    sentenceCount: 120,
    dialogueChars: 600,
    dialogueRatio: 0.2,
    avgParagraphLength: 120,
    sentenceLengthCv: 0.6,
    sceneBreakCount: 5,
    openingSentenceLength: 12,
    openingHasDialogue: false,
    openingHasEmphatic: false,
    ...overrides,
  }
}

/** 把运行时脏值传给声明为 string 的入参（只测防线，不做类型谎言扩散）。 */
const asText = (value: unknown): string => value as string

describe("区间上沿打分（增补）", () => {
  it("dialogueRatio > 0.5 → 按 (0.7-d)/0.2 线性扣分，0.6 时正好 50 分", () => {
    const r = scoreDimension("dialogueRatio", signals({ dialogueRatio: 0.6 }))
    expect(r.score).toBe(50)
    expect(r.evidence).toContain("dialogue=60.0%")
  })

  it("dialogueRatio 恰在 0.5 上沿 → 仍算自然区，满分", () => {
    expect(scoreDimension("dialogueRatio", signals({ dialogueRatio: 0.5 })).score).toBe(100)
  })

  it("平均段长落在 [60,220] → 段落节奏满分", () => {
    const r = scoreDimension("paragraphRhythm", signals({ avgParagraphLength: 100 }))
    expect(r.score).toBe(100)
    expect(r.evidence).toContain("avgPara=100.0")
  })

  it("平均段长 300（超长段落）→ 按 (a-220)/180 扣分，得 56 分", () => {
    // 100 - ((300-220)/180)*100 = 55.56 → 四舍五入 56
    expect(scoreDimension("paragraphRhythm", signals({ avgParagraphLength: 300 })).score).toBe(56)
  })

  it("目标篇幅为 0 时 length 维度得 0（不产生 Infinity/NaN）", () => {
    const r = scoreDimension("length", signals(), { targetLength: 0 })
    expect(r.score).toBe(0)
    expect(r.evidence).toContain("target=0")
  })
})

describe("运行时防线（增补）", () => {
  it("extractSignals 收到 null → 按空文本抽取，不抛错", () => {
    const s = extractSignals(asText(null))
    expect(s.charCount).toBe(0)
    expect(s.sentenceCount).toBe(0)
    expect(s.dialogueChars).toBe(0)
    expect(s.sceneBreakCount).toBe(0)
  })

  it("assessChapter 缺 text 字段 → 按空文本评估，六维齐全且 overall 为 0", async () => {
    const input = {} as unknown as SelfAssessmentInput
    const res = await assessChapter(input)
    expect(res.scores).toHaveLength(DIMENSION_KEYS.length)
    expect(res.overall).toBe(0)
    expect(res.gaps.length).toBeGreaterThan(0)
    expect(res.degraded).toBe(true)
  })
})

describe("LLM 覆盖值不合规（增补）", () => {
  it("覆盖值为 NaN / 缺失 → 该维回落机械分，其余维仍采用覆盖值", async () => {
    const text = healthyText()
    const mechanical = await assessChapter({ text })
    const mechLength = mechanical.scores.find((s) => s.key === "length")!.score
    const mechSceneBreaks = mechanical.scores.find((s) => s.key === "sceneBreaks")!.score

    const res = await assessChapter(
      { text },
      {
        llm: {
          async evaluate() {
            return {
              length: Number.NaN,
              dialogueRatio: 90,
              // sceneBreaks 故意缺失（undefined）
            }
          },
        },
      },
    )

    expect(res.degraded).toBe(false)
    expect(res.scores.find((s) => s.key === "length")!.score).toBe(mechLength)
    expect(res.scores.find((s) => s.key === "sceneBreaks")!.score).toBe(mechSceneBreaks)
    expect(res.scores.find((s) => s.key === "dialogueRatio")!.score).toBe(90)
  })

  it("覆盖值越界 → 仍被钳到 0-100 区间", async () => {
    const res = await assessChapter(
      { text: "很短。" },
      {
        llm: {
          async evaluate() {
            return { length: 500, openingHook: -20 }
          },
        },
      },
    )
    expect(res.scores.find((s) => s.key === "length")!.score).toBe(100)
    expect(res.scores.find((s) => s.key === "openingHook")!.score).toBe(0)
  })
})
