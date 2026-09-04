import { describe, expect, it } from "vitest"
import { computeSelfRepetition } from "./self-repetition"

describe("computeSelfRepetition (55 号设计 W2-6 / B-03)", () => {
  it("高度重复文本 → rep2/3/4 高, diversity 低", () => {
    const text = "他走了。他走了。他走了。他走了。他走了。他走了。他走了。他走了。"
    const r = computeSelfRepetition(text)
    expect(r.rep2).toBeGreaterThan(0.5)
    expect(r.rep3).toBeGreaterThan(0.5)
    expect(r.rep4).toBeGreaterThan(0.5)
    expect(r.diversity).toBeLessThan(0.2)
    expect(r.logDiversity).toBeGreaterThan(0)
  })

  it("多样文本 → rep3/4 低, diversity 高 (中文按字 n-gram 需长文本才有区分度, 55 号设计基线归一化实证)", () => {
    const sentences = [
      "晨光穿过窗棂，他推开木门，山风裹着松香扑面而来。",
      "远处传来钟声，惊起檐下麻雀，她提着竹篮走过石桥。",
      "桥下溪水映着云影，老槐树下孩童追逐嬉闹，笑声惊动黄狗。",
      "他弯腰拾起一片落叶，叶脉间还凝着昨夜的露珠，晶莹剔透。",
      "巷口卖豆腐的老汉支起摊子，热气腾腾的豆浆香气飘散开来。",
      "她驻足片刻，想起儿时祖母在灶台边哼唱的歌谣，眼眶微热。",
      "远处山峦叠翠，云雾缭绕，一条小径蜿蜒通向密林深处。",
      "他深吸一口气，把行囊甩上肩头，大步流星走向山门。",
    ]
    const text = Array.from({ length: 8 }, (_, i) => sentences[i % sentences.length]!).join("\n")
    const r = computeSelfRepetition(text)
    expect(r.rep3).toBeLessThan(0.3)
    expect(r.rep4).toBeLessThan(0.3)
    expect(r.diversity).toBeGreaterThan(0.3)
  })

  it("空/过短文本 → 全 0 (零开销路径)", () => {
    expect(computeSelfRepetition("")).toEqual({ rep2: 0, rep3: 0, rep4: 0, diversity: 0, logDiversity: 0 })
    expect(computeSelfRepetition("短")).toEqual({ rep2: 0, rep3: 0, rep4: 0, diversity: 0, logDiversity: 0 })
  })

  it("幂等: 同输入同输出", () => {
    const text = "他走了。他走了。他走了。"
    expect(computeSelfRepetition(text)).toEqual(computeSelfRepetition(text))
  })
})
