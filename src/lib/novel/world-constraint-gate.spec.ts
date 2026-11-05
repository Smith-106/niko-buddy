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
  WorldConstraintGateError,
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

  it("空/纯前缀约束被跳过（防真空判据；硬+软两路 continue）", () => {
    // 空串通不过 WORLD_SAMPLE_ENTRY_SCHEMA（min(1)），走 JSON 边界传入
    // ——正好模拟磁盘资产未经 schema 校验的原始形态。
    const samples = JSON.parse(
      '[{"entryId":"ws-skip","transferableConstraints":["", "forbid:", "forbid:   ", "forbid:钢铁"],"softConstraints":["", "require:"]}]',
    )
    const pack = buildWorldConstraintPack({ text: "钢铁之城", samples })
    // 6 条约束中仅 forbid:钢铁 成规则；其余全部跳过不建规则
    expect(pack.rules.map((r) => r.id)).toEqual(["world-hard:ws-skip:3"])
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("fail")
  })

  it("损坏资产（JSON 边界非字符串约束）→ 永不抛错并跳过该条", () => {
    // transferableConstraints 来自 JSON 资产文件；损坏资产可能含非字符串。
    // parseWorldConstraint 的 typeof 守卫 + 取值处的 ?? "" 共同保证永不抛错。
    expect(parseWorldConstraint(JSON.parse("123"))).toBeNull()
    expect(parseWorldConstraint(JSON.parse("null"))).toBeNull()
    const samples = JSON.parse(
      '[{"entryId":"ws-corrupt","transferableConstraints":[123, "forbid:钢铁"]}]',
    )
    const pack = buildWorldConstraintPack({ text: "钢铁之城", samples })
    expect(pack.rules.map((r) => r.id)).toEqual(["world-hard:ws-corrupt:1"])
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.consistency).toBe("fail")
  })

  it("schema 未校验的空 entryId 直达结构守卫（WorldConstraintGateError，fail-loud）", () => {
    // 既有上例经 WORLD_SAMPLE_ENTRY_SCHEMA.parse 会先被 schema 拒绝（min(1)），
    // 守卫行（throw + Error 构造）只能由绕过 schema 的调用方触发：
    // spread 合法条目后清空 entryId，类型仍为 WorldSampleEntry，无需类型断言。
    const valid = sample({ entryId: "ws-ok", transferableConstraints: ["require:a"] })
    const bypassed = { ...valid, entryId: "" }
    expect(bypassed.entryId).toBe("")
    expect(() =>
      buildWorldConstraintPack({ text: "", samples: [bypassed] }),
    ).toThrow(WorldConstraintGateError)
    expect(() =>
      buildWorldConstraintPack({ text: "", samples: [bypassed] }),
    ).toThrow("entryId 为空")
  })
})