/**
 * name-match.spec.ts — 中文人名命中判定（共享工具）行为锁定。
 *
 * 口径（见模块头注释）：中文没有词边界，判定只能靠「最长匹配优先」——
 * 命中的位置若被某个更长的已知名覆盖（正文「王府」、已知名含「王府」），
 * 这次出现就不算「王」。
 *
 * 覆盖点：
 *  - compareCodePoints：码点序（含代理对）与「前缀等长差」返回长度差；
 *  - nameAppears：空名、多字名直通、单字名被长名吸收后继续找下一次出现、
 *    吸收与非吸收两个方向的返回值；
 *  - isUnreliableName：按**码点**计数（代理对算 1 个字符）。
 */
import { describe, expect, it } from "vitest"
import { compareCodePoints, isUnreliableName, nameAppears } from "./name-match"

describe("compareCodePoints 码点序比较", () => {
  it("首个不同码点决定大小（王 U+738B > 李 U+674E）", () => {
    expect(compareCodePoints("王", "李")).toBeGreaterThan(0)
    expect(compareCodePoints("李", "王")).toBeLessThan(0)
  })

  it("前缀相同 → 返回长度差（短名在前）", () => {
    // 比较循环走完 size 次全部相等后落到长度差分支
    expect(compareCodePoints("王", "王府")).toBe(-1)
    expect(compareCodePoints("王府", "王")).toBe(1)
  })

  it("完全相等 → 0", () => {
    expect(compareCodePoints("王府", "王府")).toBe(0)
    expect(compareCodePoints("", "")).toBe(0)
  })

  it("按码点而非 UTF-16 码元排序（代理对）", () => {
    // 𠀀 = U+20000，鿿 = U+9FFF：码点序 𠀀 > 鿿；
    // 若按 UTF-16 码元比，首码元 0xD840 < 0x9FFF 会得到相反结果。
    expect(compareCodePoints("𠀀", "鿿")).toBeGreaterThan(0)
    expect(compareCodePoints("鿿", "𠀀")).toBeLessThan(0)
  })
})

describe("nameAppears 最长匹配优先", () => {
  it("空名字一律不命中（不能把空串当成到处出现）", () => {
    expect(nameAppears("王站在门外", "", [])).toBe(false)
    expect(nameAppears("", "", ["王"])).toBe(false)
  })

  it("多字名走整串包含，不做吸收判定", () => {
    expect(nameAppears("王府井大街很热闹", "王府", [])).toBe(true)
    expect(nameAppears("他去了别处", "王府", ["王府井"])).toBe(false)
  })

  it("单字名在无更长已知名覆盖时命中", () => {
    expect(nameAppears("王站在门外", "王", [])).toBe(true)
    expect(nameAppears("李站在门外", "王", [])).toBe(false)
  })

  it("单字名被更长的已知名覆盖 → 不算命中", () => {
    // 「王府」覆盖了「王」这一次出现：正文说的不是人「王」
    expect(nameAppears("王府很大", "王", ["王府"])).toBe(false)
  })

  it("前一次出现被覆盖、后一次出现未被覆盖 → 命中（吸收后继续往后找）", () => {
    expect(nameAppears("王府和王都来了", "王", ["王府"])).toBe(true)
  })

  it("已知名不比单字名更长或不含该字 → 不参与吸收", () => {
    // other.length <= name.length 短路；!other.includes(name) 短路
    expect(nameAppears("王来了", "王", ["王", "李四"])).toBe(true)
    // 更长但不含「王」的已知名同样不吸收
    expect(nameAppears("王来了", "王", ["王府井", "李四"]))
      .toBe(true)
  })

  it("多次出现全部被覆盖 → 不命中", () => {
    expect(nameAppears("王府东边是王府西边", "王", ["王府"])).toBe(false)
  })
})

describe("isUnreliableName 按码点计数", () => {
  it("单字与空名不可靠", () => {
    expect(isUnreliableName("")).toBe(true)
    expect(isUnreliableName("王")).toBe(true)
  })

  it("多字名可靠", () => {
    expect(isUnreliableName("王府")).toBe(false)
  })

  it("代理对单字符按 1 个码点计（不是 2 个码元）", () => {
    // 𠀀 的 UTF-16 长度是 2，码点长度是 1 —— 必须按码点判不可靠
    expect(isUnreliableName("𠀀")).toBe(true)
  })
})
