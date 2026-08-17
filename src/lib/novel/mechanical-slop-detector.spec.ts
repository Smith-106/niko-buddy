import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  classifySlop,
  normalizeText,
  slopReportToText,
  slopScore,
  detectCharacterActions,
  characterActionsToText,
  type CharacterActionHit,
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

  it("ISS-20260802-001: detects the deferred Tier 1/2/3 Chinese lexicons", () => {
    const report = slopScore("值得一提的是，不难发现，综上所述，总而言之。赋能抓手依赖底层逻辑和颗粒度。确保这件事至关重要，提供全方位支持。")
    expect(report.tier1Hits.map((hit) => hit.kw)).toEqual(expect.arrayContaining([
      "值得一提的是", "不难发现", "综上所述", "总而言之",
    ]))
    expect(report.tier2Hits.map((hit) => hit.kw)).toEqual(expect.arrayContaining([
      "赋能", "抓手", "底层逻辑", "颗粒度",
    ]))
    expect(report.tier3Hits.map((hit) => hit.kw)).toEqual(expect.arrayContaining([
      "确保", "至关重要", "全方位",
    ]))
  })

  it("ISS-20260802-001: ordinary concrete prose does not match the new lexicons", () => {
    const report = slopScore("雨停后，阿青把潮湿的绳子挂在门槛上。炉火噼啪作响，屋里的猫没有抬头。")
    expect(report.tier1Hits).toHaveLength(0)
    expect(report.tier2Hits).toHaveLength(0)
    expect(report.tier3Hits).toHaveLength(0)
  })

  it("QF-v1 E6: detects extended TIER3 Chinese AI mannerisms (bounded subset)", () => {
    const content = [
      "他不禁陷入沉思。",
      "她心中暗道不妙。",
      "嘴角勾起一丝冷笑。",
      "空气中弥漫着紧张。",
      "时间仿佛静止。",
      "他不由自主地后退。",
    ].join("")
    const report = slopScore(content)
    expect(report.tier3Hits.length).toBeGreaterThan(0)
    expect(report.slopPenalty).toBeGreaterThan(0)
  })

  it("QF-v1 E6: extended pattern count is bounded (not full corpus dump)", async () => {
    const { TIER3_EXTENDED_PATTERN_COUNT } = await import("./mechanical-slop-detector")
    expect(TIER3_EXTENDED_PATTERN_COUNT).toBeGreaterThanOrEqual(10)
    expect(TIER3_EXTENDED_PATTERN_COUNT).toBeLessThanOrEqual(20)
  })
})

describe("S1a 防绕过预处理 normalizeText + TIER 词库补全 (roadmap S1 P1 机械层)", () => {
  it("normalizeText strips zero-width chars (ZWSP/ZWNJ/ZWJ/word-joiner/BOM)", () => {
    const zwsps = "\u200B\u200C\u200D\u2060\uFEFF"
    const result = normalizeText(`总而言之${zwsps}事情就这样${zwsps}结束了`)
    expect(result.zeroWidthCount).toBe(10)
    expect(result.text).toContain("总而言之")
    expect(result.text).not.toContain("\u200B")
  })

  it("slopScore detects TIER1 banned word hidden with ZWSP bypass (zero-width no longer bypasses lexicon)", () => {
    // humanizer 注入零宽使 "总而言之" 精确匹配失效
    const bypassText = "总\u200B而言之，这个项目势在必行。"
    const report = slopScore(bypassText)
    expect(report.tier1Hits.some((h) => h.kw === "总而言之")).toBe(true)
    expect(report.bypassCount).toBeGreaterThan(0)
    expect(report.slopPenalty).toBeGreaterThan(0)
  })

  it("slopScore normalizes CJK homoglyphs before matching (異體字 bypass)", () => {
    // 同形字: 彷彿 (異體) vs 仿佛 (词库)
    const homoglyphText = "他彷彿回到了从前。"
    const report = slopScore(homoglyphText)
    expect(report.tier1Hits.some((h) => h.kw === "仿佛")).toBe(true)
    expect(report.homoglyphCount).toBeGreaterThan(0)
  })

  it("S1a: humanizer-zh 23 条禁止模式词库补全 (新增 TIER1 词命中)", () => {
    const content = "众所周知，这个方案令人印象深刻且至关重要。其影响显而易见，不可否认的是，它从多维度彰显了价值，效果淋漓尽致。"
    const report = slopScore(content)
    const kws = report.tier1Hits.map((h) => h.kw)
    for (const w of ["众所周知", "令人印象深刻", "至关重要", "显而易见", "不可否认", "多维度", "彰显", "淋漓尽致"]) {
      expect(kws).toContain(w)
    }
    expect(report.slopPenalty).toBeGreaterThanOrEqual(8)
    expect(report.slopPenalty).toBeLessThanOrEqual(10)
  })

  it("normalizeText is idempotent and preserves clean prose", () => {
    const clean = "雨停后，阿青把潮湿的绳子挂在门槛上。"
    const once = normalizeText(clean)
    const twice = normalizeText(once.text)
    expect(once.text).toBe(clean)
    expect(twice.text).toBe(once.text)
    expect(once.bypassCount).toBe(0)
  })
})

describe("P0 角色-动作关联检测 detectCharacterActions + characterActionsToText", () => {
  it("detects actions and attributes them to the nearest named character", () => {
    // 归因窗口为动作前后 ±80 字符，用长间隔隔开避免窗口内出现多个角色名
    const gap = "。".repeat(100)
    const hits = detectCharacterActions(`白砚推了推眼镜${gap}王迦后退了一步${gap}苏未晞抠指甲`)
    const byAction = new Map(hits.map((h) => [h.action, h]))
    expect(byAction.get("推眼镜")!.perCharacter["白砚"]).toBeGreaterThanOrEqual(1)
    expect(byAction.get("后退")!.perCharacter["王迦"]).toBeGreaterThanOrEqual(1)
    expect(byAction.get("抠指甲")!.perCharacter["苏未晞"]).toBeGreaterThanOrEqual(1)
  })

  it("counts repeated actions per character and falls back to 未知 when no character nearby", () => {
    const repeated = detectCharacterActions("白砚推了推眼镜，白砚又推了推眼镜，白砚再推了推眼镜。")
    const push = repeated.find((h) => h.action === "推眼镜")!
    expect(push.totalCount).toBe(3)
    expect(push.perCharacter["白砚"]).toBe(3)

    const orphan = detectCharacterActions("推了推眼镜。")
    const orphanHit = orphan.find((h) => h.action === "推眼镜")!
    expect(orphanHit.perCharacter["未知"]).toBe(1)
  })

  it("keeps the closer character when multiple names share one attribution window", () => {
    // 窗口内同时出现苏未晞(远)与白砚(近): 白砚更近应胜出, 苏未晞的 dist >= nearestDist
    // 分支（falsy side of dist < nearestDist）被覆盖。
    const hits = detectCharacterActions(`苏未晞${("。").repeat(70)}白砚推了推眼镜。`)
    const push = hits.find((h) => h.action === "推眼镜")!
    expect(push.perCharacter["白砚"]).toBe(1)
    expect(push.perCharacter["苏未晞"]).toBeUndefined()
  })

  it("renders empty text for empty hits and skips single-occurrence hits", () => {
    expect(characterActionsToText([])).toBe("")
    const single: CharacterActionHit[] = [
      { action: "推眼镜", type: "mannerism", totalCount: 1, suggest: "s", perCharacter: { 白砚: 1 } },
    ]
    expect(characterActionsToText(single)).toBe("角色行为模式检测:")
  })

  it("renders warn/notice lines and per-character breakdown sorted by count", () => {
    const hits: CharacterActionHit[] = [
      {
        action: "推眼镜",
        type: "mannerism",
        totalCount: 3,
        suggest: "建议 ≤3 次/角色",
        perCharacter: { 白砚: 2, 王迦: 1 },
      },
      {
        action: "低下头",
        type: "reaction",
        totalCount: 2,
        suggest: "建议 ≤3 次",
        perCharacter: { 白砚: 2 },
      },
    ]
    const text = characterActionsToText(hits)
    expect(text).toContain("⚠️")
    expect(text).toContain("ℹ️")
    expect(text).toContain("推眼镜")
    expect(text).toContain("白砚: 2 次")
    expect(text).not.toContain("王迦: 1 次") // per-char count < 2 skipped
  })
})

describe("slopReportToText 附加分支 (bypass / 单 tier / 密度行)", () => {
  it("renders bypass 痕迹 line when zero-width chars were stripped", () => {
    const report = slopScore("显\u200B然，目光交汇的瞬间。")
    expect(report.bypassCount).toBeGreaterThan(0)
    const text = slopReportToText(report)
    expect(text).toContain("防绕过痕迹")
  })

  it("renders tier2-only hits without tier1/tier3 lines", () => {
    const report = slopScore("与此同时，这很复杂。他推开门走了出去。夜色很深。")
    expect(report.tier2Hits.length).toBeGreaterThan(0)
    const text = slopReportToText(report)
    expect(text).toContain("可疑词")
    expect(text).not.toContain("强禁用词")
    expect(text).not.toContain("机械句式")
  })

  it("renders transition-opener ratio line when >40% of paragraphs start with 转折词", () => {
    const report = slopScore("然而他来了。\n但是他又走了。\n然而他又来了。\n但是他又走了。")
    expect(report.transitionOpenerRatio).toBeGreaterThan(0.4)
    const text = slopReportToText(report)
    expect(text).toContain("段落转折词开头过多")
  })

  it("omits CV line when sentence lengths are varied (CV >= 0.1)", () => {
    const report = slopScore("显然。事实。这一切都结束了。他推开门走了出去。夜色很深。")
    expect(report.sentenceLengthCV).toBeGreaterThanOrEqual(0.1)
    const text = slopReportToText(report)
    expect(text).not.toContain("句长过于一致")
  })
})
