/**
 * edit-impact-analyzer.spec.ts — 51 号报告 G4 编辑影响分析 spec 锁定.
 *
 * 覆盖: 删除伏笔引用→affected 含该伏笔 / 无假阳性 / 跨类冲击面 / 零冲击空集 /
 * 确定性（纯函数）。
 */

import { describe, expect, it } from "vitest"
import { analyzeEditImpact } from "./edit-impact-analyzer"
import type { CanonEdge } from "../../components/canon-editor/canon-types"
import type { Foreshadowing } from "./foreshadowing-tracker"

const foreshadows: Foreshadowing[] = [
  {
    id: "f-1",
    name: "青铜钥匙",
    description: "伏笔：青铜钥匙开启地窖",
    status: "planted",
    plantedChapter: 3,
    advancedChapters: [],
    relatedCharacters: ["艾琳"],
    relatedEvents: [],
    notes: "",
  },
]

const edges: CanonEdge[] = [
  {
    id: "e-1",
    source_id: "艾琳",
    target_id: "地窖",
    predicate: "持有",
    edge_kind: "world_fact",
    valid_at: 1000,
  },
]

const characters = [{ id: "c-1", characterName: "艾琳" }]
const subplots = [{ id: "s-1", title: "地窖之谜" }]

describe("analyzeEditImpact（G4 事前冲击面预测）", () => {
  it("删除伏笔引用 → affected 含该伏笔（removed）", () => {
    const r = analyzeEditImpact(
      { before: "她握紧青铜钥匙，走向地窖。", after: "她走向地窖。" },
      { foreshadows },
    )
    expect(r.affectedForeshadows.map((f) => f.id)).toContain("f-1")
    expect(r.affectedEntities).toContainEqual(
      expect.objectContaining({ ref: "foreshadowing:f-1", category: "foreshadowing", kind: "removed" }),
    )
  })

  it("两版文本均在的实体 → 不进受影响集合（无假阳性）", () => {
    const r = analyzeEditImpact(
      { before: "她握紧青铜钥匙。", after: "她握紧青铜钥匙，走向地窖。" },
      { foreshadows, characters },
    )
    expect(r.affectedEntities).toHaveLength(0)
    expect(r.riskLevel).toBe("low")
  })

  it("跨类冲击面：角色引用被删 → 集合含 character 且 canon 边受影响", () => {
    const r = analyzeEditImpact(
      { before: "艾琳握紧青铜钥匙。", after: "他握紧青铜钥匙。" },
      { characters, canonEdges: edges },
    )
    expect(r.affectedCharacters.map((c) => c.characterName)).toContain("艾琳")
    expect(r.affectedEdges.map((e) => e.id)).toContain("e-1")
    expect(r.riskLevel).toBe("high") // world_fact 边命中 → high
  })

  it("零冲击：before === after → 空 affected 集", () => {
    const r = analyzeEditImpact({ before: "原文", after: "原文" }, { foreshadows, canonEdges: edges, characters, subplots })
    expect(r.affectedEntities).toHaveLength(0)
    expect(r.affectedEdges).toHaveLength(0)
    expect(r.affectedForeshadows).toHaveLength(0)
    expect(r.riskLevel).toBe("low")
  })

  it("确定性：同输入两次调用结果逐字段相等（纯函数）", () => {
    const input = { before: "她握紧青铜钥匙。", after: "她走向地窖。" }
    const stores = { foreshadows, canonEdges: edges, characters, subplots }
    const a = analyzeEditImpact(input, stores)
    const b = analyzeEditImpact(input, stores)
    expect(a).toEqual(b)
  })

  it("支线标题被删 → affected 含 subplot", () => {
    const r = analyzeEditImpact(
      { before: "地窖之谜渐渐揭开。", after: "谜底渐渐揭开。" },
      { subplots },
    )
    expect(r.affectedSubplots.map((s) => s.id)).toContain("s-1")
  })

  it("无引用普通文本删除 → 空集（不误报整库）", () => {
    const r = analyzeEditImpact(
      { before: "风吹过旷野。", after: "风停了。" },
      { foreshadows, canonEdges: edges, characters, subplots },
    )
    expect(r.affectedEntities).toHaveLength(0)
  })
})
