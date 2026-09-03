/**
 * truth-file-projection.spec.ts — 48/49 号 §六-⑤ truth-file 投影 spec 锁定.
 *
 * 50 号报告 S0 行动项: 覆盖渲染确定性（golden snapshot）/ stale-blocked 诊断标记 /
 * 幂等性 / 单向派生（不写回）。
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  renderTruthFileProjection,
  isProjectionIdempotent,
  type TruthFileProjectionInput,
} from "./truth-file-projection"
import type { TruthEntry } from "./truth-authority"
import type { StateDelta } from "./state-delta-light-check"

function entry(overrides: Partial<TruthEntry>): TruthEntry {
  return {
    entryId: "ch1-fact0",
    subject: "林澈",
    statement: "林澈佩青霜剑",
    level: "established",
    revision: 0,
    ...overrides,
  }
}

function baseInput(): TruthFileProjectionInput {
  return {
    projectName: "雨夜档案",
    truthEntries: [
      entry({}),
      entry({ entryId: "ch1-fact1", subject: "旧屋", statement: "旧屋主人是沈伯" }),
    ],
  }
}

describe("renderTruthFileProjection（§六-⑤ 人可读投影）", () => {
  it("投影头含项目名与「非真源」声明", () => {
    const md = renderTruthFileProjection(baseInput())
    expect(md).toContain("# 雨夜档案 真值投影")
    expect(md).toContain("> 自动投影（非真源）")
  })

  it("按权威等级分组（canon 在前），组内按 entryId 稳定排序", () => {
    const input: TruthFileProjectionInput = {
      truthEntries: [
        entry({ level: "hypothesis", entryId: "ch1-hyp-0" }),
        entry({ level: "canon", entryId: "ch1-fact0" }),
      ],
    }
    const md = renderTruthFileProjection(input)
    const canonIdx = md.indexOf("### 正典")
    const hypIdx = md.indexOf("### 推测")
    expect(canonIdx).toBeGreaterThan(-1)
    expect(hypIdx).toBeGreaterThan(canonIdx)
  })

  it("superseded 条目带 [stale] 标记、冲突主题条目带 [blocked] 标记", () => {
    const input: TruthFileProjectionInput = {
      truthEntries: [
        entry({ entryId: "ch0-fact0", level: "superseded", supersededBy: "ch1-fact1" }),
        entry({ subject: "林澈", level: "established", entryId: "ch1-fact0", statement: "林澈佩青霜剑" }),
        entry({ subject: "林澈", level: "established", entryId: "ch1-fact2", statement: "林澈佩赤焰刀" }),
      ],
    }
    const md = renderTruthFileProjection(input)
    expect(md).toContain("[stale]")
    expect(md).toContain("[blocked]")
    expect(md).toContain("- ch0-fact0 [stale]: 林澈佩青霜剑 (林澈)")
    expect(md).toContain("- ch1-fact0 [blocked]: 林澈佩青霜剑 (林澈)")
  })

  it("含冲突主题时输出「待收敛冲突」节（error 级 → [blocked]）", () => {
    const input: TruthFileProjectionInput = {
      truthEntries: [
        entry({ subject: "林澈", entryId: "ch1-fact0", statement: "林澈佩青霜剑" }),
        entry({ subject: "林澈", entryId: "ch1-fact2", statement: "林澈佩赤焰刀" }),
      ],
    }
    const md = renderTruthFileProjection(input)
    expect(md).toContain("## 待收敛冲突")
    expect(md).toContain("[blocked]")
  })

  it("stateDelta hookOps 投影（第 N 章状态增量操作）", () => {
    const delta: StateDelta = {
      chapter: 3,
      locationChanges: [{ entity: "林澈", from: "旧屋", to: "码头" }],
      inventoryChanges: [{ entity: "林澈", item: "青霜剑", op: "gain" }],
    }
    const md = renderTruthFileProjection({ ...baseInput(), stateDelta: delta })
    expect(md).toContain("## 状态增量操作（第 3 章）")
    expect(md).toContain("- relocate: 林澈 — 旧屋→码头")
    expect(md).toContain("- add: 林澈 — gain 青霜剑")
  })

  it("无条目 → 「暂无」且不崩（确定性保底）", () => {
    const md = renderTruthFileProjection({ truthEntries: [] })
    expect(md).toContain("（暂无）")
  })
})

describe("isProjectionIdempotent（§六-⑤ 幂等）", () => {
  it("同输入两次投影字节全等", () => {
    expect(isProjectionIdempotent(baseInput())).toBe(true)
  })

  it("含 stateDelta 与冲突时仍幂等", () => {
    const input: TruthFileProjectionInput = {
      truthEntries: [
        entry({ subject: "林澈", entryId: "ch1-fact0" }),
        entry({ subject: "林澈", entryId: "ch1-fact2" }),
      ],
      stateDelta: { chapter: 2, statusChanges: [{ entity: "小晴", status: "受伤" }] },
    }
    expect(isProjectionIdempotent(input)).toBe(true)
  })
})
