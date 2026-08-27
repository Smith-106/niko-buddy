/**
 * author-fingerprint.spec.ts — v2.6.4 V-07 验收
 *
 * 覆盖：原笔指纹抽取（句长/标点/对话/段落）+ 漂移检测
 */
import { describe, expect, it } from "vitest"
import { extractAuthorFingerprint, fingerprintDrift, splitSentences } from "./author-fingerprint"

describe("V-07 原笔指纹 — 抽取", () => {
  it("句切分（中文标点）", () => {
    expect(splitSentences("第一句。第二句！第三句？")).toHaveLength(3)
    expect(splitSentences("   ")).toHaveLength(0)
  })

  it("指纹字段齐全 + 样本量正确", () => {
    const fp = extractAuthorFingerprint("他推开门。月光洒进来。他愣住了。")
    expect(fp.sampleSize).toBe(3)
    expect(fp.meanSentenceLength).toBeGreaterThan(0)
    expect(fp.sentenceLengthStd).toBeGreaterThanOrEqual(0)
    expect(fp.punctuationDensity).toBeGreaterThan(0)
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0)
    expect(fp.meanParagraphLength).toBeGreaterThan(0)
  })

  it("空文本返回零指纹", () => {
    const fp = extractAuthorFingerprint("")
    expect(fp.sampleSize).toBe(0)
    expect(fp.meanSentenceLength).toBe(0)
  })

  it("对话占比（引号内字符）", () => {
    const fp = extractAuthorFingerprint('"你好。"他说。')
    expect(fp.dialogueRatio).toBeGreaterThan(0)
  })
})

describe("V-07 原笔指纹 — 漂移检测", () => {
  it("同文本漂移为 0", () => {
    const fp = extractAuthorFingerprint("他推开门。月光洒进来。他愣住了。")
    expect(fingerprintDrift(fp, fp)).toBeCloseTo(0, 10)
  })

  it("风格差异 → 漂移 > 0", () => {
    const baseline = extractAuthorFingerprint("他推开门。月光洒进来。他愣住了。")
    const drifted = extractAuthorFingerprint("他推开门，看见满屋的月光，愣住了，久久没有说话，仿佛时间都停止了流动。")
    expect(fingerprintDrift(drifted, baseline)).toBeGreaterThan(0)
  })

  it("空基线返回 0（无参照不告警）", () => {
    const empty = extractAuthorFingerprint("")
    const fp = extractAuthorFingerprint("他推开门。")
    expect(fingerprintDrift(fp, empty)).toBe(0)
  })
})
