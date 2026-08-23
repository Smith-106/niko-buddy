import { describe, expect, it } from "vitest"
import {
  normalizeSourceText,
  normalizeText,
  type NormalizeTextResult,
} from "./normalize-source-text"

/**
 * DEBT-a4-01a: normalizeSourceText 直接 spec。
 * 覆盖四类用例: ①NFKC 全角数字→半角与同形字映射冗余交互 ②软连字符 U+00AD 剥离
 * ③幂等性 ④边界 (空串/纯ASCII/纯CJK/混合)。
 *
 * 设计约束: 所有断言只校验「检测视图副本」的归一结果, 不涉及正文存储回写。
 */

describe("normalizeSourceText — ① NFKC 全角数字→半角与同形字映射冗余交互", () => {
  it("全角数字: NFKC 先转半角, 后续同形字映射不再命中但结果一致", () => {
    const input = "０１２３４５６７８９"
    const viaSrc = normalizeSourceText(input)
    const viaNorm = normalizeText(input)
    // 两条路径结果文本一致 ("0123456789"), 尽管各自走不同入口。
    expect(viaSrc.text).toBe("0123456789")
    expect(viaNorm.text).toBe("0123456789")
    expect(viaSrc.text).toBe(viaNorm.text)
    // NFKC 已先把全角数字转半角, 故 normalizeText 内的全角数字映射键 ("０"等)
    // 在 src 视图不再命中; 非 suspicious 键同样不计入 homoglyphCount。
    expect(viaSrc.homoglyphCount).toBe(0)
    expect(viaNorm.homoglyphCount).toBe(0)
  })

  it("全角数字+西里尔同形混合: 数字走 NFKC、西里尔走同形字映射, 结果仍一致", () => {
    const input = "а０" // 西里尔 а + 全角 ０
    const viaSrc = normalizeSourceText(input)
    const viaNorm = normalizeText(input)
    // 结果均为 "a0": 西里尔 а 在两条路径都经同形字映射归 a; 全角 ０ 在 src 路径
    // 由 NFKC 预处理, 在 norm 路径由同形字映射处理 —— 二者取同值, 无双重计数。
    expect(viaSrc.text).toBe("a0")
    expect(viaNorm.text).toBe("a0")
    // 西里尔 а 为 suspicious 键, 两路径各计 1; 全角数字不重复计数。
    expect(viaSrc.homoglyphCount).toBe(1)
    expect(viaNorm.homoglyphCount).toBe(1)
    expect(viaSrc.bypassCount).toBe(1)
  })

  it("冗余不是双处理: 同形字映射的 fullwidth 数字键在 NFKC 后无副作用", () => {
    // 对同一输入先 NFKC 再 normalizeText, 应与 normalizeSourceText 完全一致。
    const input = "编号Ｆ０１２"
    const composed: NormalizeTextResult = normalizeText(input.normalize("NFKC"))
    const src = normalizeSourceText(input)
    expect(src.text).toBe(composed.text)
    expect(src.homoglyphCount).toBe(composed.homoglyphCount)
    expect(src.zeroWidthCount).toBe(composed.zeroWidthCount)
  })
})

describe("normalizeSourceText — ② 软连字符 U+00AD 剥离", () => {
  it("剥离软连字符, 且 normalizeText 不剥离 (仅 normalizeSourceText 含该步)", () => {
    const input = `co\u00ADoperate` // 含 U+00AD 软连字符
    expect(normalizeSourceText(input).text).toBe("cooperate")
    // normalizeText 仅做零宽剥离 + 同形字还原, 不含软连字符剥离。
    expect(normalizeText(input).text).toBe(input)
  })

  it("软连字符不在 zeroWidth 计数集内, 剥离后 zeroWidthCount 仍为 0", () => {
    const input = `ab\u00ADcd`
    const r = normalizeSourceText(input)
    expect(r.text).toBe("abcd")
    expect(r.zeroWidthCount).toBe(0)
    expect(r.bypassCount).toBe(0)
  })

  it("软连字符与零宽字符共存: 软连字符剥离 + 零宽计数互不干扰", () => {
    const zws = "​" // U+200B
    const input = `a${zws}b\u00ADc`
    const r = normalizeSourceText(input)
    expect(r.text).toBe("abc")
    expect(r.zeroWidthCount).toBe(1)
  })
})

describe("normalizeSourceText — ③ 幂等性", () => {
  it("对已归一化文本再调用结果不变且计数归零", () => {
    const inputs = [
      "全角０１２与cyr ае",
      "The quick brown fox 123.",
      "床前明月光疑是地上霜",
      "他说：你好０１２！",
      "mixed Ｆｕｌｌ－ｗｉｄｔｈ",
    ]
    for (const x of inputs) {
      const first = normalizeSourceText(x)
      const second = normalizeSourceText(first.text)
      expect(second.text).toBe(first.text)
      expect(second.zeroWidthCount).toBe(0)
      expect(second.homoglyphCount).toBe(0)
      expect(second.bypassCount).toBe(0)
    }
  })

  it("normalizeText 自身亦幂等 (与 src 视图兼容)", () => {
    const x = "аеорсх０１２​" // cyrillic + fullwidth digit + ZWSP
    const once = normalizeText(x)
    const twice = normalizeText(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.bypassCount).toBe(0)
  })
})

describe("normalizeSourceText — ④ 边界 (空串/纯ASCII/纯CJK/混合)", () => {
  it("空串: 返回空结果与零计数结构", () => {
    const r = normalizeSourceText("")
    expect(r).toEqual({
      text: "",
      zeroWidthCount: 0,
      homoglyphCount: 0,
      bypassCount: 0,
    })
  })

  it("纯 ASCII: 原样不变且零计数", () => {
    const x = "The quick brown fox jumps 123 times."
    const r = normalizeSourceText(x)
    expect(r.text).toBe(x)
    expect(r.bypassCount).toBe(0)
  })

  it("纯 CJK (常见简体, 无全角标点/同形): 原样不变且零计数", () => {
    const x = "床前明月光疑是地上霜举头望明月低头思故乡"
    const r = normalizeSourceText(x)
    expect(r.text).toBe(x)
    expect(r.homoglyphCount).toBe(0)
    expect(r.zeroWidthCount).toBe(0)
  })

  it("混合 (CJK + 全角标点 + 全角数字 + 西里尔): NFKC 转标点/数字, 同形字映射西里尔", () => {
    const input = "他说：你好０１２！ас" // 西里尔 ас + 全角 ０１２ + 全角标点
    // NFKC: ：→: ，→. ！→! ０１２→012 ; 西里尔 ас 不受 NFKC 影响, 留给同形字映射。
    expect(normalizeSourceText(input).text).toBe("他说:你好012!ac")
    expect(normalizeSourceText(input).homoglyphCount).toBe(2) // а, с 为 suspicious
  })
})
