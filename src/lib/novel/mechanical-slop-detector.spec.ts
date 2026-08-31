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
  overCorrectionReport,
  overCorrectionToText,
  cavityPatternPenalty,
  type CharacterActionHit,
} from "./mechanical-slop-detector"
import { SUSPICIOUS_HOMOGLYPH_KEYS } from "./normalize-source-text"

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
    // A3 密度制校准: 短文本命中率天然超高, 用中性叙事稀释至 warn 带验证算术而非绝对值。
    const neutral = [
      "他推开门走了出去，风很大，吹得衣角猎猎作响。",
      "桌上的茶凉了半盏，窗外的天色一点点暗了下去。",
      "他把纸叠好收进口袋，转身下了楼。",
    ].join("")
    const content =
      "显然他是对的，这一点毫无疑问。显然，事实再一次证明。显然，所有人都看错了。" +
      neutral.repeat(28)
    const report = slopScore(content)
    const xianran = report.tier1Hits.find((h) => h.kw === "显然")
    expect(xianran).toBeDefined()
    expect(xianran!.count).toBe(3)
    // 密度制: 稀释后孤立命中应落在 warn 带以下 (不误伤正常叙事中的少量强调词)
    expect(report.slopPenalty).toBeLessThan(8)
    expect(report.slopPenalty).toBeGreaterThanOrEqual(0)
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
    // warn: 密度制下用中性叙事稀释 TIER1 命中至 5-7.9 带 (多样句长避免 CV+2 误升 block)
    const neutralWarn = [
      "他推开门走了出去，风很大，吹得衣角猎猎作响。",
      "桌上的茶凉了半盏，窗外的天色一点点暗了下去。",
      "他把纸叠好收进口袋，转身下了楼。",
    ].join("")
    const warnContent =
      "显然他是对的，事实上这一点毫无疑问。这一切似乎早有预兆，他推开门走了出去，风很大，天色已暗。" +
      neutralWarn.repeat(34)
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
    expect(TIER3_EXTENDED_PATTERN_COUNT).toBeGreaterThanOrEqual(40)
    expect(TIER3_EXTENDED_PATTERN_COUNT).toBeLessThanOrEqual(60)
  })

  // A11 TIER 词库扩展: 每 tier 新增 ≤8 词, 各自触发对应 tier 命中且 penalty 方向正确 (密度制)
  it("A11: new TIER1 strong-signal words hit tier1 + raise penalty (density)", () => {
    const newTier1 = [
      "意味深长", "久久无法平静", "涌上心头", "难以忘怀",
      "刻骨铭心", "历历在目", "心潮澎湃", "思绪万千",
    ]
    const report = slopScore(newTier1.join("。") + "。")
    const kws = report.tier1Hits.map((h) => h.kw)
    for (const w of newTier1) expect(kws).toContain(w)
    // 密度制: 这些强信号词单独出现即推高 penalty, 且不误入 tier2/3 主导
    expect(report.slopPenalty).toBeGreaterThan(0)
    expect(report.slopPenalty).toBeLessThanOrEqual(10)
  })

  it("A11: new TIER2 suspicious modifiers hit tier + raise penalty (density)", () => {
    const newTier2 = [
      "微微一愣", "一丝不易察觉的", "莫名地", "若有所思地",
      "说不清缘由", "无端地", "隐约觉得", "怔怔地",
    ]
    const report = slopScore(newTier2.join("。") + "。")
    const kws = report.tier2Hits.map((h) => h.kw)
    for (const w of newTier2) expect(kws).toContain(w)
    expect(report.slopPenalty).toBeGreaterThan(0)
    expect(report.slopPenalty).toBeLessThanOrEqual(10)
  })

  it("A11: new TIER3 mechanical-filler patterns hit + raise penalty (density)", () => {
    const content = "呐呐自语了几句。眼底深处闪过一抹光。压在心头的秘密。出来时已成定局。暗中计划着。不禁陷入深思。内心深处涌起的情绪。刚想开口又止住。"
    const report = slopScore(content)
    const kws = report.tier3Hits.map((h) => h.kw)
    for (const re of ["呐呐自语", "眼底深处闪过", "压在心头的", "出来时已成", "暗中计划", "不禁陷入", "内心深处涌起的", "刚想开口"]) {
      expect(kws.some((k) => k.includes(re))).toBe(true)
    }
    expect(report.slopPenalty).toBeGreaterThan(0)
    expect(report.slopPenalty).toBeLessThanOrEqual(10)
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

  it("slopScore normalizes CJK homoglyphs before matching (C2 口径: 常见繁简互转只还原不计 bypass)", () => {
    // 同形字: 彷彿 (異體) vs 仿佛 (词库)。C2 重定义后 彷彿 属常见繁简/異嵂互换字,
    // 文本仍被还原 (词库命中), 但不计入 homoglyphCount/bypassCount (不把合法繁体当 AI 旁路)。
    const homoglyphText = "他彷彿回到了从前。"
    const report = slopScore(homoglyphText)
    expect(report.tier1Hits.some((h) => h.kw === "仿佛")).toBe(true)
    expect(report.homoglyphCount).toBe(0)
    expect(report.bypassCount).toBe(0)
  })

  it("C2: 纯繁体段落 bypassCount=0 且归一后词库检测仍命中 (不误判合法繁体文本)", () => {
    const trad = "顯然他們說這段時間，彷彿早就注定了一切。"
    const report = slopScore(trad)
    // 繁体常用字 (們/說/時間/…/彷彿) 只还原不计 bypass: 无零宽 + 无非疑同形。
    expect(report.zeroWidthCount).toBe(0)
    expect(report.homoglyphCount).toBe(0)
    expect(report.bypassCount).toBe(0)
    // 文本还原仍生效: 归一后词库命中仿佛 (TIER1)。
    expect(report.tier1Hits.some((h) => h.kw === "仿佛")).toBe(true)
  })

  it("C2: 西里尔同形字 (真正的 AI-humanizer 混淆) 计入 homoglyphCount/bypassCount", () => {
    // 西里尔 е U+0435 替换拉丁 e。“dанные” / cold 混淆: 人类正常写作不会出现。
    const cyr = "把值写进 c\u0435ll 数组" // c[е]ll
    const result = normalizeText(cyr)
    expect(result.text).toContain("cell")
    expect(result.homoglyphCount).toBe(1)
    expect(result.bypassCount).toBe(1)
    // slopScore 入口 (NFKC + normalizeText) 同样把西里尔同形计为 bypass。
    const report = slopScore(cyr)
    expect(report.homoglyphCount).toBeGreaterThan(0)
    expect(report.bypassCount).toBeGreaterThan(0)
  })

  it("C2: SUSPICIOUS_HOMOGLYPH_KEYS 只含生僻混淆字 (西里尔同形), 不含常见繁简互转字", () => {
    expect(SUSPICIOUS_HOMOGLYPH_KEYS.size).toBeGreaterThan(0)
    for (const s of ["裡", "說", "時間", "們", "話", "彷彿"]) {
      expect(SUSPICIOUS_HOMOGLYPH_KEYS.has(s)).toBe(false)
    }
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

// ============================================================================
// P0-1: Humanizer Cavity Guard + P1-5 规则补漏 (2026 检测对抗前沿)
// ============================================================================
describe("P0-1 overCorrectionReport — 反改写器腔 (humanizer 腔)", () => {
  it("句长过度齐整 → 改写痕迹", () => {
    const r = overCorrectionReport("他走了。她来了。天黑了。风起了。灯灭了。门关了。")
    expect(r.sentenceLengthCV).toBeLessThan(0.08)
    expect(r.flags.some((f) => f.includes("齐整"))).toBe(true)
    expect(r.humanizerCavityScore).toBeGreaterThan(0)
  })

  it("假口语密度异常 → 改写痕迹", () => {
    const fillerText = Array.from({ length: 12 }, () => "呃，这个嘛，嗯那个……").join("")
    const r = overCorrectionReport(fillerText)
    expect(r.fillerDensityPer1000).toBeGreaterThan(3)
    expect(r.flags.some((f) => f.includes("填充词"))).toBe(true)
  })

  it("正常文本 → 无标记", () => {
    const r = overCorrectionReport("他推开门，夜风卷着雨丝扑在脸上。走廊尽头那盏灯还亮着，像一只不肯闭上的眼睛。")
    expect(r.flags).toEqual([])
    expect(r.humanizerCavityScore).toBe(0)
  })

  it("overCorrectionToText 空 flags 返回空串", () => {
    expect(overCorrectionToText({ sentenceLengthCV: 0.5, fillerDensityPer1000: 1, fillerCount: 2, humanizerCavityScore: 0, flags: [] })).toBe("")
  })

  it("overCorrectionToText 有 flags 时输出报告", () => {
    const text = overCorrectionToText({ sentenceLengthCV: 0.05, fillerDensityPer1000: 5, fillerCount: 10, humanizerCavityScore: 0.8, flags: ["句长过度齐整 (CV 0.05) — 机械模板嫌疑", "假口语填充词密度异常 (5.0/千字) — humanizer 腔嫌疑"] })
    expect(text).toContain("综合改写痕迹分 0.80")
  })
})

describe("P1-5 cavityPatternPenalty — 2026 强信号补漏", () => {
  it("夸大腔命中有惩罚", () => {
    const { penalty, hits } = cavityPatternPenalty("这是划时代的革命性突破，史无前例的开创性时刻。")
    expect(hits.length).toBeGreaterThan(0)
    expect(penalty).toBeGreaterThan(0)
  })

  it("格言腔命中", () => {
    const { hits } = cavityPatternPenalty("所谓命运，不过是人自己选择的结果。")
    expect(hits.length).toBeGreaterThan(0)
  })

  it("三连排比命中", () => {
    const { hits } = cavityPatternPenalty("他愤怒、绝望、崩溃，最终沉默。")
    expect(hits.length).toBeGreaterThan(0)
  })

  it("稻草人腔命中", () => {
    const { hits } = cavityPatternPenalty("有人说，坚持就是胜利。")
    expect(hits.length).toBeGreaterThan(0)
  })

  it("干净文本零惩罚", () => {
    const { penalty, hits } = cavityPatternPenalty("他推开门走了出去，夜色很深，远处有狗叫。")
    expect(hits).toEqual([])
    expect(penalty).toBe(0)
  })
})
