import { describe, expect, it } from "vitest"
import {
  applyTruthEdit,
  AUTHORITY_WEIGHT,
  detectTruthConflicts,
  resolveAuthoritative,
  type TruthEntry,
} from "./truth-authority"

function entry(overrides: Partial<TruthEntry>): TruthEntry {
  return {
    entryId: "e1",
    subject: "主角佩剑",
    statement: "林澈佩青霜剑",
    level: "draft",
    revision: 1,
    ...overrides,
  }
}

describe("truth-authority（吸收累积残余：真源五级分级+编辑事务模式）", () => {
  it("五级权重排序 canon 最高、superseded 终态", () => {
    expect(AUTHORITY_WEIGHT.canon).toBeGreaterThan(AUTHORITY_WEIGHT.established)
    expect(AUTHORITY_WEIGHT.hypothesis).toBeGreaterThan(AUTHORITY_WEIGHT.superseded)
  })

  it("合法迁移：draft→established→canon 逐级晋升（revision 递增）", () => {
    let entries = [entry({})]
    const step1 = applyTruthEdit(entries, { entryId: "e1", toLevel: "established", reason: "设定会通过" })
    expect(step1.applied).toBe(true)
    entries = step1.entries
    expect(entries[0]).toMatchObject({ level: "established", previousLevel: "draft", revision: 2 })
    const step2 = applyTruthEdit(entries, { entryId: "e1", toLevel: "canon", reason: "定稿" })
    expect(step2.entries[0].level).toBe("canon")
    expect(step2.entries[0].revision).toBe(3)
  })

  it("非法迁移拒绝：canon 不可直降 draft；superseded 为终态", () => {
    const entries = [entry({ level: "canon" })]
    const result = applyTruthEdit(entries, { entryId: "e1", toLevel: "draft", reason: "改" })
    expect(result.applied).toBe(false)
    expect(result.reason).toContain("非法迁移")
    const sup = applyTruthEdit(entries, { entryId: "e1", toLevel: "superseded", reason: "supersededBy:e2" })
    expect(sup.applied).toBe(true)
    expect(sup.entries[0].supersededBy).toBe("e2")
    const revive = applyTruthEdit(sup.entries, { entryId: "e1", toLevel: "canon", reason: "复活" })
    expect(revive.applied).toBe(false)
  })

  it("事务守门：理由缺失拒绝；未知条目拒绝", () => {
    const entries = [entry({})]
    expect(applyTruthEdit(entries, { entryId: "e1", toLevel: "established", reason: " " }).applied).toBe(false)
    expect(applyTruthEdit(entries, { entryId: "ghost", toLevel: "draft", reason: "x" }).applied).toBe(false)
  })

  it("冲突检测：双 canon 同主题 → error；多级并存 → warn；superseded 不参与", () => {
    const conflict = [
      entry({ entryId: "a", level: "canon" }),
      entry({ entryId: "b", level: "canon", statement: "矛盾版本" }),
    ]
    expect(detectTruthConflicts(conflict)[0].severity).toBe("error")
    const layered = [
      entry({ entryId: "a", level: "canon" }),
      entry({ entryId: "b", level: "hypothesis", statement: "推测版" }),
      entry({ entryId: "c", level: "superseded", statement: "旧版" }),
    ]
    expect(detectTruthConflicts(layered)[0].severity).toBe("warn")
    expect(detectTruthConflicts([entry({})])).toEqual([])
  })

  it("resolveAuthoritative：同主题取最高等级（canon 压 established）", () => {
    const entries = [
      entry({ entryId: "a", level: "established" }),
      entry({ entryId: "b", level: "canon", statement: "定稿版" }),
      entry({ entryId: "c", level: "superseded", statement: "废弃" }),
    ]
    expect(resolveAuthoritative(entries, "主角佩剑")?.entryId).toBe("b")
    expect(resolveAuthoritative(entries, "不存在主题")).toBeUndefined()
  })

  it("确定性：同输入双跑全等", () => {
    const entries = [entry({ level: "canon" }), entry({ entryId: "b", level: "canon", statement: "x" })]
    expect(JSON.stringify(detectTruthConflicts(entries))).toBe(JSON.stringify(detectTruthConflicts(entries)))
  })
})
