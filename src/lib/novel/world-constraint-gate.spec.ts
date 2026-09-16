/**
 * world-constraint-gate.spec — 波2-A 世界样本约束 → P0 门联动测试。
 * 覆盖：硬约束 forbid/require 违规 → P0 FAIL / 干净文本 pass / 软约束违规
 * 永不 P0 FAIL（warning）/ 空 samples 空包 / rule id 唯一稳定 / DSL 跳过 /
 * message 可追溯（含 entryId）。
 */
import { describe, expect, it } from "vitest"
import { WORLD_SAMPLE_ENTRY_SCHEMA, type WorldSampleEntry } from "./asset-library"
import { combinePacks, runRuleStack } from "./rule-stack"
import {
  WORLD_CONSTRAINT_PACK_ID,
  buildWorldConstraintPack,
  parseWorldConstraint,
} from "./world-constraint-gate"

function sample(input: Partial<WorldSampleEntry> & { entryId: string }): WorldSampleEntry {
  return WORLD_SAMPLE_ENTRY_SCHEMA.parse({ sourceRef: "ref-1", ...input })
}

describe("parseWorldConstraint（DSL 解析）", () => {
  it("forbid:/require: 显式前缀 + 裸串 require 近似 + 空串跳过", () => {
    expect(parseWorldConstraint("forbid:钢铁")).toEqual({ kind: "forbid", literal: "钢铁", raw: "forbid:钢铁" })
    expect(parseWorldConstraint("require:左利手")).toEqual({ kind: "require", literal: "左利手", raw: "require:左利手" })
    expect(parseWorldConstraint("主角左利手")).toEqual({ kind: "require", literal: "主角左利手", raw: "主角左利手" })
    expect(parseWorldConstraint("  ")).toBeNull()
    expect(parseWorldConstraint("forbid:")).toBeNull()
    expect(parseWorldConstraint("forbid:   ")).toBeNull()
  })
})

describe("buildWorldConstraintPack（P0 门联动）", () => {
  it("硬 forbid 命中 → consistency 门 FAIL（P0 error finding）", () => {
    const pack = buildWorldConstraintPack({
      text: "他掏出了钢铁战衣。",
      samples: [sample({ entryId: "ws-a", transferableConstraints: ["forbid:钢铁"] })],
    })
    expect(pack.id).toBe(WORLD_CONSTRAINT_PACK_ID)
    const stack = combinePacks([pack])
    const result = runRuleStack(stack, { isFinale: false })
    expect(result.verdicts.consistency).toBe("fail")
    expect(result.allFindings.some((f) => f.severity === "error" && f.ruleId.startsWith("world-hard:ws-a"))).toBe(true)
  })

  it("硬 require 缺失 → consistency 门 FAIL（裸串 require 近似）", () => {
    const pack = buildWorldConstraintPack({
      text: "本章主角没有出场。",
      samples: [sample({ entryId: "ws-b", transferableConstraints: ["主角左利手"] })],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("fail")
    expect(result.allFindings[0]?.message).toContain("ws-b")
  })

  it("干净文本 → consistency 门 PASS", () => {
    const pack = buildWorldConstraintPack({
      text: "主角用左手握笔，写下第一行字。",
      samples: [sample({ entryId: "ws-c", transferableConstraints: ["forbid:钢铁", "require:左手"] })],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("pass")
    expect(result.allFindings).toHaveLength(0)
  })

  it("仅软约束命中 → consistency 仍 PASS（软违规永不 P0 FAIL，warning 态）", () => {
    const pack = buildWorldConstraintPack({
      text: "晴天，无雨。城市在阳光下发亮。",
      samples: [sample({ entryId: "ws-d", transferableConstraints: ["require:城市"], softConstraints: ["forbid:雨"] })],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("pass")
    const soft = result.allFindings.filter((f) => f.ruleId.startsWith("world-soft:ws-d"))
    expect(soft).toHaveLength(1)
    expect(soft[0]?.severity).toBe("warning")
    expect(soft[0]?.escalated).toBeUndefined()
  })

  it("空 samples → 空 rules 合法包；运行全门 PASS", () => {
    const pack = buildWorldConstraintPack({ text: "任意正文", samples: [] })
    expect(pack.rules).toHaveLength(0)
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("pass")
    expect(result.executedRuleCount).toBe(0)
  })

  it("rule id 唯一且确定性稳定（两次构建同 id；跨条目不冲突）", () => {
    const makePack = () =>
      buildWorldConstraintPack({
        text: "x",
        samples: [
          sample({ entryId: "ws-1", transferableConstraints: ["require:a"], softConstraints: ["require:b"] }),
          sample({ entryId: "ws-2", transferableConstraints: ["require:b"] }),
        ],
      })
    const first = makePack()
    const second = makePack()
    const ids = first.rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(second.rules.map((r) => r.id))
    expect(ids.every((id) => id.startsWith("world-"))).toBe(true)
  })

  it("entryId 含冒号被转义，rule id 仍全局唯一", () => {
    const pack = buildWorldConstraintPack({
      text: "",
      samples: [sample({ entryId: "ws:3", transferableConstraints: ["require:a"] })],
    })
    expect(pack.rules[0]?.id).toBe("world-hard:ws_3:0")
  })

  it("finding message 含 entryId + 约束原文 + 证据节选（可点开追溯）", () => {
    const pack = buildWorldConstraintPack({
      text: "0123456789 钢铁 9876543210",
      samples: [sample({ entryId: "ws-e", transferableConstraints: ["forbid:钢铁"] })],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const finding = result.allFindings[0]
    expect(finding?.message).toContain("ws-e")
    expect(finding?.message).toContain("forbid:钢铁")
    expect(finding?.message).toContain("钢铁")
    expect(finding?.message.length).toBeLessThanOrEqual(200)
  })

  it("空 entryId → 结构守卫抛错（rule id 无法落可追溯锚）", () => {
    expect(() =>
      buildWorldConstraintPack({
        text: "",
        samples: [sample({ entryId: "", transferableConstraints: ["require:a"] })],
      }),
    ).toThrow()
  })
})