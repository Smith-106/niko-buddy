import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  classifySlop,
  slopReportToText,
  slopScore,
} from "./mechanical-slop-detector"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("A19 机械层中文 slop 检测器 (借鉴点 #1, 零 LLM 纯正则+算术)", () => {
  it("uses zero LLM calls (A19 机械层硬验证: 无 streamChat/llm-client import 或 await invoke 调用)", () => {
    const src = readSource("mechanical-slop-detector.ts")
    // 无 LLM 调用: 不 import llm-client, 不调用 streamChat, 不走 Tauri invoke。
    // (注释里提到这些词不算 — 只检查实际 import/调用语句)
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/await\s+streamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
  })

  it("slopScore returns low penalty for varied clean prose (无 slop 词, 句长多样)", () => {
    // 句长多样避免误触 CV 密度惩罚; 无 slop 词命中 → penalty 0。
    const clean = "他推开门，风灌了进来，凉意贴着脚踝往上爬。桌上的茶还温着，茶汤映着窗外的天光，他没动。"
    const report = slopScore(clean)
    expect(report.tier1Hits).toHaveLength(0)
    expect(report.tier2Hits).toHaveLength(0)
    expect(report.tier3Hits).toHaveLength(0)
    expect(report.slopPenalty).toBe(0)
  })

  it("slopScore detects TIER1 banned words (总结腔/解释腔/AI 特征词) with high penalty", () => {
    const content = "显然他是对的。事实上这一切都结束了。仿佛从未发生。"
    const report = slopScore(content)
    // TIER1 命中: 显然, 事实上, 这一切, 仿佛 (4 个词, 各 1 次)
    expect(report.tier1Hits.length).toBeGreaterThanOrEqual(3)
    const tier1Kws = report.tier1Hits.map((h) => h.kw)
    expect(tier1Kws).toContain("显然")
    expect(tier1Kws).toContain("事实上")
    expect(tier1Kws).toContain("这一切")
    // penalty 至少 4*1.5=6 (可能叠加密度惩罚, 不强求精确值)
    expect(report.slopPenalty).toBeGreaterThanOrEqual(6)
  })

  it("slopScore detects TIER2 suspicious words (模板句首/空洞形容) with medium penalty", () => {
    const content = "与此同时他走了。这很复杂。然而但是不过可是都出现。"
    const report = slopScore(content)
    const tier2Kws = report.tier2Hits.map((h) => h.kw)
    expect(tier2Kws).toContain("与此同时")
    expect(tier2Kws).toContain("复杂")
    // 转折词 然而/但是/不过/可是 4 个
    expect(tier2Kws).toContain("然而")
    expect(report.tier2Hits.length).toBeGreaterThanOrEqual(3)
  })

  it("slopScore detects TIER3 filler regex (机械句式 prose cliché)", () => {
    const content = "目光交汇的瞬间，空气仿佛凝固。心中五味杂陈。"
    const report = slopScore(content)
    // TIER3 命中: 目光交汇的瞬间, 空气仿佛凝固 (注意: 仿佛 是 TIER1, 命中 TIER1 也算)
    const tier3Kws = report.tier3Hits.map((h) => h.kw)
    expect(tier3Kws.length).toBeGreaterThanOrEqual(2)
    // TIER1 也命中 仿佛
    expect(report.tier1Hits.some((h) => h.kw === "仿佛")).toBe(true)
  })

  it("slopScore detects mechanical 排比 (既...又... / 不仅...还...)", () => {
    const content = "他既聪明又勤奋，不仅努力还机智。"
    const report = slopScore(content)
    const tier3Kws = report.tier3Hits.map((h) => h.kw)
    expect(tier3Kws.some((k) => k.includes("既"))).toBe(true)
    expect(tier3Kws.some((k) => k.includes("不仅"))).toBe(true)
  })

  it("slopScore counts repeated keyword occurrences (count > 1)", () => {
    // 多句多样文本避免误触 CV 密度惩罚, 孤立 TIER1 命中算术。
    const content = "显然他是对的，这一点毫无疑问。显然，事实再一次证明。显然，所有人都看错了。他推开门走了出去，风很大。"
    const report = slopScore(content)
    const xianran = report.tier1Hits.find((h) => h.kw === "显然")
    expect(xianran).toBeDefined()
    expect(xianran!.count).toBe(3)
    // penalty = 3*1.5 (显然) + 1.5 (毫无疑问 TIER1) = 6, <8 即 warn 不 block
    expect(report.slopPenalty).toBeLessThan(8)
    expect(report.slopPenalty).toBeGreaterThanOrEqual(4.5)
  })

  it("slopScore clamps penalty to 10 (heavy slop)", () => {
    // 大量 TIER1 + TIER3 + 密度惩罚, 超过 10 归 10
    const content =
      "显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。" +
      "与此同时紧接着就在这时。然而但是不过可是。" +
      "他既聪明又勤奋不仅努力还机智。眼神变得坚定。时间一分一秒过去。"
    const report = slopScore(content)
    expect(report.slopPenalty).toBeLessThanOrEqual(10)
    expect(report.slopPenalty).toBe(10)
  })

  it("slopScore density: low sentenceLengthCV (句长一致 + 句数>=5) adds +2 penalty", () => {
    // 6 句全同长, CV=0 <0.1 且句数>=5 → +2 (中文版 CV 阈值 0.1 + 句数 guard,
    // 避免短文本误罚; 此用例句数够多 + 句长完全一致才触发)。
    const content = "他来了。他走了。他来了。他走了。他来了。他走了。"
    const report = slopScore(content)
    expect(report.sentenceLengthCV).toBeLessThan(0.1)
    expect(report.slopPenalty).toBeGreaterThanOrEqual(2)
  })

  it("slopScore density: high transitionOpenerRatio (段落转折词开头) adds +2 penalty", () => {
    // 每段都转折词开头 → ratio 1.0 > 0.4 → +2
    const content = "然而他来了。\n但是他走了。\n而且他回来了。\n所以他又走了。"
    const report = slopScore(content)
    expect(report.transitionOpenerRatio).toBeGreaterThan(0.4)
    expect(report.slopPenalty).toBeGreaterThanOrEqual(2)
  })

  it("slopScore handles empty content (backward compat, penalty 0)", () => {
    const report = slopScore("")
    expect(report.slopPenalty).toBe(0)
    expect(report.tier1Hits).toHaveLength(0)
  })

  it("classifySlop returns block/warn/clean by penalty threshold (DD-3: >=8/5-8/<5)", () => {
    // clean: penalty 0 (多样句长无 slop)
    expect(classifySlop(slopScore("他推开门，风灌了进来，凉意贴着脚踝。桌上的茶还温着，他没动。"))).toBe("clean")
    // warn: penalty 5-7.9 — TIER1 4 词 = 6 (用多样句长避免 CV+2 误升 block)
    const warnContent = "显然他是对的，事实上这一点毫无疑问。这一切似乎早有预兆，他推开门走了出去，风很大，天色已暗。"
    const warnReport = slopScore(warnContent)
    expect(warnReport.slopPenalty).toBeGreaterThanOrEqual(5)
    expect(warnReport.slopPenalty).toBeLessThan(8)
    expect(classifySlop(warnReport)).toBe("warn")
    // block: penalty >=8 — 大量 slop 词 + 机械句式 (clamp 到 10)
    const blockReport = slopScore("显然事实上这一切似乎仿佛。目光交汇的瞬间空气凝固心中五味杂陈。然而但是不过。眼神变得坚定。时间一分一秒过去。他既聪明又勤奋。")
    expect(blockReport.slopPenalty).toBeGreaterThanOrEqual(8)
    expect(classifySlop(blockReport)).toBe("block")
  })

  it("slopReportToText returns '' for clean report (无命中 + penalty<5)", () => {
    expect(slopReportToText(slopScore("他推开门。风灌进来。"))).toBe("")
  })

  it("slopReportToText renders bullet report with tier hits + penalty for slop content", () => {
    const report = slopScore("显然事实上这一切。目光交汇的瞬间。")
    const text = slopReportToText(report)
    expect(text).toContain("机械 slop 检测")
    expect(text).toContain("penalty")
    expect(text).toContain("强禁用词")
    expect(text).toContain("显然")
    expect(text).toContain("机械句式")
  })
})
