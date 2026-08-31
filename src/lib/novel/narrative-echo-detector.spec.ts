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
