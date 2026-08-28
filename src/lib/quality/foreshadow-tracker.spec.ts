/**
 * foreshadow-tracker.spec.ts — v2.6.10 D2 验收
 *
 * 覆盖：登记置信度 / key 匹配+别名词典 / 回收判定 / 闭环统计
 */
import { describe, expect, it } from "vitest"
import {
  REGISTER_CONFIDENCE,
  closureRate,
  matchForeshadowKey,
  payoffQuality,
  payoffQualityV2,
  registerForeshadow,
  resolveForeshadow,
  type Foreshadow,
} from "./foreshadow-tracker"

const base: Omit<Foreshadow, "id" | "status"> = {
  kind: "explicit",
  key: "玉簪",
  loc: { chapter: 1, sentence: 10 },
  expectedPayoffChapter: 5,
  confidence: 0.9,
}

describe("D2 伏笔追踪 — 登记（置信度≥0.7）", () => {
  it("置信度达标入册", () => {
    const r = registerForeshadow(base, "f1")
    expect(r.ok).toBe(true)
    expect(r.foreshadow?.status).toBe("planted")
  })

  it("置信度<0.7 拒绝（防过度登记弱伏笔）", () => {
    const r = registerForeshadow({ ...base, confidence: 0.5 }, "f2")
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("置信度不足")
    expect(REGISTER_CONFIDENCE).toBe(0.7)
  })
})

describe("D2 伏笔追踪 — key 匹配 + 别名词典", () => {
  it("直接 key 命中", () => {
    expect(matchForeshadowKey("她拿起玉簪", "玉簪")).toBe(true)
  })

  it("别名词典兜底（防漏别名误报 dangling）", () => {
    expect(matchForeshadowKey("她拿起那支簪", "玉簪")).toBe(true)
    expect(matchForeshadowKey("她拿起阿明的信", "阿明")).toBe(true)
  })

  it("无关文本不命中", () => {
    expect(matchForeshadowKey("她拿起一本书", "玉簪")).toBe(false)
  })
})

describe("D2 伏笔追踪 — 回收判定 + 闭环", () => {
  it("目标章呼应 → resolved", () => {
    const f = registerForeshadow(base, "f3").foreshadow!
    const r = resolveForeshadow(f, "她终于找到了那支簪", 5)
    expect(r.status).toBe("resolved")
  })

  it("超预期章未收 → orphan（漏收告警）", () => {
    const f = registerForeshadow(base, "f4").foreshadow!
    const r = resolveForeshadow(f, "她翻遍了房间", 6)
    expect(r.status).toBe("orphan")
    expect(r.alert).toContain("漏收告警")
  })

  it("闭环统计：零悬挂", () => {
    const f1 = registerForeshadow(base, "f5").foreshadow!
    const f2 = registerForeshadow({ ...base, key: "阿明" }, "f6").foreshadow!
    const resolved = resolveForeshadow(f1, "她拿起玉簪", 5)
    const r = closureRate([{ ...f1, status: resolved.status }, f2])
    expect(r.rate).toBe(0.5)
    expect(r.dangling).toHaveLength(1)
  })
})

describe("D2 回扣质量观测（机械闭环≠文学闭环——补语义层）", () => {
  it("锚点摘要与回收上下文重叠 → 回扣相关", () => {
    const q = payoffQuality("玉簪是母亲留下的遗物", "她终于找到了那支玉簪，想起母亲")
    expect(q).toBeGreaterThan(0.3)
  })

  it("无关上下文 → 回扣弱（生硬回扣被观测）", () => {
    const q = payoffQuality("玉簪是母亲留下的遗物", "他今天去集市买了菜")
    expect(q).toBeLessThan(0.3)
  })
})

describe("D2 回扣质量二级校验（防偷懒回扣误判高质量）", () => {
  it("逐字复述偷懒回扣 → 质量减半 + lazyCopy 标记", () => {
    const r = payoffQualityV2("玉簪是母亲留下的遗物", "玉簪是母亲留下的遗物，她握紧它")
    expect(r.lazyCopy).toBe(true)
    expect(r.quality).toBe(0.5)
  })

  it("转化处理回扣 → 无偷懒标记", () => {
    const r = payoffQualityV2("玉簪是母亲留下的遗物", "她摩挲着簪身，想起母亲临终的话")
    expect(r.lazyCopy).toBe(false)
  })
})
