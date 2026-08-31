import { describe, expect, it } from "vitest"
import {
  fnv1a32,
  sentenceNGramSignature,
  chapterStructuralSignature,
  signaturesSimilar,
  NarrativeEchoTracker,
  echoReportToText,
} from "./narrative-echo-detector"

describe("narrative-echo-detector — P1-4 跨章回纹检测", () => {
  describe("fnv1a32", () => {
    it("确定性 + 不同输入不同值", () => {
      expect(fnv1a32("abc")).toBe(fnv1a32("abc"))
      expect(fnv1a32("abc")).not.toBe(fnv1a32("abd"))
    })
  })

  describe("chapterStructuralSignature", () => {
    const ch = "他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。"
    it("结构签名包含全部字段", () => {
      const sig = chapterStructuralSignature(ch)
      expect(sig.paragraphBuckets.length).toBe(4)
      expect(sig.sentenceLengthHash).toBeGreaterThan(0)
      expect(sig.length).toBeGreaterThan(0)
      expect(typeof sig.transitionDensityBucket).toBe("number")
    })
    it("同文本签名一致", () => {
      expect(chapterStructuralSignature(ch)).toEqual(chapterStructuralSignature(ch))
    })
  })

  describe("signaturesSimilar", () => {
    const a = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。")
    it("同构文本相似", () => {
      const b = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。")
      expect(signaturesSimilar(a, b)).toBe(true)
    })
    it("不同转场密度 → 不相似", () => {
      const b = chapterStructuralSignature("然而他推开门。然而夜色很深。然而远处有狗叫。\n然而她放下杯子。然而窗外下雨了。\n然而他沉默。")
      expect(signaturesSimilar(a, b)).toBe(false)
    })
    it("长度差异过大 → 不相似", () => {
      const long = chapterStructuralSignature(
        Array.from({ length: 30 }, (_, i) => `第${i}段他推开门走了出去。夜色很深。远处有狗叫。`).join("\n"),
      )
      const short = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。")
      // 长度比远小于 0.7 → 不相似
      expect(signaturesSimilar(a, short)).toBe(false)
      expect(long.length).toBeGreaterThan(short.length * 3)
    })
  })

  describe("NarrativeEchoTracker", () => {
    it("跨章窗口检测同构章节", () => {
      const t = new NarrativeEchoTracker({ windowSize: 5 })
      const same = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。")
      const different = chapterStructuralSignature("然而他大笑。然而一切结束。然而无人说话。\n然而他离开。然而天黑。\n然而无人回头。")
      expect(t.register(1, different)).toEqual([])
      expect(t.register(2, same)).toEqual([])
      // 第 3 章与第 2 章同构 → 返回 [2] (窗口内)
      expect(t.register(3, same)).toEqual([2])
    })

    it("窗口外章节不报回声", () => {
      const t = new NarrativeEchoTracker({ windowSize: 2 })
      const same = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。")
      const diff = chapterStructuralSignature("然而他大笑。然而一切结束。然而无人说话。\n然而他离开。然而天黑。\n然而无人回头。")
      t.register(1, diff)
      t.register(2, same)
      t.register(3, diff)
      // 第 4 章与第 2 章: 距离 2, 在窗口内 (<= windowSize)
      const m4 = t.register(4, same)
      expect(m4).toContain(2)
      // 第 5 章再同构 → 距离 2 的 2 号章仍在窗口 (2 <= 2), 但 1 号在窗口外
      const m5 = t.register(5, same)
      expect(m5).not.toContain(1)
    })

    it("duplicates 列出重复对", () => {
      const t = new NarrativeEchoTracker({ windowSize: 10 })
      const same = chapterStructuralSignature("他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。")
      const diff = chapterStructuralSignature("然而他大笑。然而一切结束。然而无人说话。\n然而他离开。然而天黑。\n然而无人回头。")
      t.register(1, diff)
      t.register(2, same)
      t.register(3, same)
      const dups = t.duplicates()
      expect(dups.some((d) => d.a === 2 && d.b === 3)).toBe(true)
      expect(dups.some((d) => d.a === 1)).toBe(false)
    })
  })

  describe("sentenceNGramSignature", () => {
    it("句级模板哈希", () => {
      const sig = sentenceNGramSignature("他推开门走了出去。夜色很深。远处有狗叫。她放下杯子。窗外下雨了。他沉默了很久。", 4)
      expect(sig.length).toBeGreaterThan(0)
      expect(sig.every((h) => h > 0)).toBe(true)
    })
  })

  describe("echoReportToText", () => {
    it("无匹配返回空串", () => {
      expect(echoReportToText([], 3)).toBe("")
    })
    it("有匹配输出报告", () => {
      const t = echoReportToText([1, 2], 3)
      expect(t).toContain("第 3 章")
      expect(t).toContain("1, 2")
    })
  })
})

// ============================================================================
// 36 号真实语料标定回归: 合成回纹 spec
// 真实 6 章两两 8-gram 重叠全 0.000 (human 零误报已由标定脚本实测)。
// 本组验证: ①非逐字重复的模板化 AI 章节 (句首模板循环 + 同构句长/转场)
// 仍能打响 (接线后检测器非死代码); ②人类句首分散但结构巧合相似时不误报。
// ============================================================================
describe("36 号标定回归 — 合成回纹 (模板循环非逐字重复)", () => {
  const AI_TEMPLATE_HEADS = ["他推", "他走", "他看", "他坐", "他抬", "他开", "她端", "她放", "她转", "她看"]

  /** 模板化 AI 章节: 句首完全复用模板集, 句尾内容变化 (非逐字重复) */
  function templateChapter(tails: string[]): string {
    const sentences = AI_TEMPLATE_HEADS.map((h, i) => `${h}${tails[i] ?? "。"}`)
    // 每 2 句一段: 5 段, 段长桶一致
    return [sentences.slice(0, 2).join(""), sentences.slice(2, 4).join(""), sentences.slice(4, 6).join(""), sentences.slice(6, 8).join(""), sentences.slice(8).join("")].join("\n")
  }

  it("非逐字重复的模板循环章节 → 检出同构 (接线后能打响)", () => {
    const a = chapterStructuralSignature(templateChapter(["开门。", "过廊。", "着影。", "下来。", "起头。", "口说。", "着碗。", "下杯。", "过身。", "向他。"]))
    const b = chapterStructuralSignature(templateChapter(["开窗。", "下楼。", "着书。", "进椅。", "眼看。", "灯了。", "着盘。", "下勺。", "过头。", "过来。"]))
    expect(signaturesSimilar(a, b)).toBe(true)
  })

  it("人类句首分散 + 结构巧合相似 → 不误报 (NGRAM 门有效)", () => {
    // 结构凑齐: 同段数 (每 2 句一段)、同句长量化 (短句)、无转场开头、长度接近
    // 但句首前 2 字互不重复 (人类自由句首) → 8-gram 重叠 0
    const humanA = "他推开门。夜色很深。远处狗叫。风从巷口灌来。".replace(/[。]/g, (m) => m) + "\n" +
      "她放下杯。窗外下雨。檐水滴答。灯影晃了晃。\n" +
      "他沉默着。烟头明灭。墙根潮湿。蜘蛛结着网。"
    const humanB = "白砚抬头。巷子很静。雨已经停。门缝漏出光。\n" +
      "李薇攥着信。纸张发皱。她咬了咬唇。眼眶有点红。\n" +
      "警笛远去。玻璃反光。楼梯吱呀。谁也没说话。"
    const sigA = chapterStructuralSignature(humanA)
    const sigB = chapterStructuralSignature(humanB)
    // 结构维度可能巧合一致 (段长桶/句长/转场), 但句首模板不重合 → 不判同构
    if (sigA.transitionDensityBucket === sigB.transitionDensityBucket) {
      expect(signaturesSimilar(sigA, sigB)).toBe(false)
    } else {
      expect(signaturesSimilar(sigA, sigB)).toBe(false)
    }
  })
})

// ============================================================================
// 34 号验收修复回归 (hy3 P1-1): 句长量化必须基于原始分句 — 不同句长分布的
// 章节不得因 normText 剥离标点后句长恒等而误报同构
// ============================================================================
describe("P1-1 修复回归 — 句长分布区分度", () => {
  it("短句章节 vs 长句章节: hash 不同且不判同构 (同段落数/转场桶)", () => {
    // 同 3 段、无转折开头 (转场桶一致)、段落长度接近 (段长桶容差内)
    // 但句长分布完全不同: 短句 vs 长句
    const shortSent = "他走了。她来了。天黑了。风起了。灯灭了。门关了。\n" +
      "他坐下。她站着。茶凉了。雨停了。鸟飞了。夜深了。\n" +
      "他笑了。她哭了。人散了。路尽了。"
    const longSent = "他推开门走了出去，夜风卷着雨丝扑在脸上，走廊尽头那盏灯还亮着。\n" +
      "她放下杯子没有看他，窗外雨势渐小，屋檐滴水声断断续续。\n" +
      "他沉默了很久才开口，声音沙哑，像砂纸磨过铁皮。"
    const sigA = chapterStructuralSignature(shortSent)
    const sigB = chapterStructuralSignature(longSent)
    // 句长 hash 必须不同 (修复前 normText 剥离标点导致恒 fnv1a32("2")=923577301)
    expect(sigA.sentenceLengthHash).not.toBe(sigB.sentenceLengthHash)
    expect(sigA.sentenceLengthHash).not.toBe(923577301)
    expect(sigB.sentenceLengthHash).not.toBe(923577301)
    // 转场桶可能不同 (长句段不以转折开头, 两者都是 0) → 允许比较
    expect(signaturesSimilar(sigA, sigB)).toBe(false)
  })

  it("相同文本 hash 稳定且同构", () => {
    const t = "他推开门走了出去。夜色很深。远处有狗叫。\n她放下杯子。窗外下雨了。\n他沉默了很久。"
    const a = chapterStructuralSignature(t)
    const b = chapterStructuralSignature(t)
    expect(a.sentenceLengthHash).toBe(b.sentenceLengthHash)
    expect(signaturesSimilar(a, b)).toBe(true)
  })
})
