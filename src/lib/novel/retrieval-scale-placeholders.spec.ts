/**
 * retrieval-scale-placeholders.spec — R3-c/d 占位契约测试（编译期靶子 + 锁死语义）。
 * 覆盖：占位恒 locked（ANN/分片 implemented=false）、矿脉管道 ⓪ 计价待定 → 不可用、
 * 契约非法 fail-loud、占位实例通过自身 schema（防占位漂移）。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  ANN_PLAN_PLACEHOLDER,
  ANN_PLAN_SCHEMA,
  ORE_PIPELINE_CONTRACT_PLACEHOLDER,
  ORE_PIPELINE_CONTRACT_SCHEMA,
  ORE_PIPELINE_STAGES,
  SHARD_PLAN_PLACEHOLDER,
  SHARD_PLAN_SCHEMA,
  isOrePipelineUsable,
} from "./retrieval-scale-placeholders"

describe("R3-c/d 占位契约", () => {
  it("ANN 占位恒 locked（implemented=false）；分片占位已实做（B3-a）——两者均过自身 schema", () => {
    expect(ANN_PLAN_SCHEMA.safeParse(ANN_PLAN_PLACEHOLDER).success).toBe(true)
    expect(SHARD_PLAN_SCHEMA.safeParse(SHARD_PLAN_PLACEHOLDER).success).toBe(true)
    expect(ANN_PLAN_PLACEHOLDER.implemented).toBe(false)
    expect(ANN_PLAN_PLACEHOLDER.kind).toBe("unspecified")
    // B3-a：分片实现已落地（shard-routing.ts）；该翻转不代表默认启用
    expect(SHARD_PLAN_PLACEHOLDER.implemented).toBe(true)
    expect(SHARD_PLAN_PLACEHOLDER.strategy).toBe("by-collection")
    expect(SHARD_PLAN_PLACEHOLDER.shardKeys).toEqual(["collection", "type"])
    expect(String(SHARD_PLAN_PLACEHOLDER.mergePolicy)).toContain("shard-major")
    expect(ANN_PLAN_PLACEHOLDER.prerequisites.length).toBeGreaterThanOrEqual(3)
  })

  it("矿脉管道契约：⓪ 计价待定 → enabled=false 且 isOrePipelineUsable=false", () => {
    expect(ORE_PIPELINE_CONTRACT_SCHEMA.safeParse(ORE_PIPELINE_CONTRACT_PLACEHOLDER).success).toBe(true)
    expect(ORE_PIPELINE_CONTRACT_PLACEHOLDER.pricing.status).toBe("pending")
    expect(ORE_PIPELINE_CONTRACT_PLACEHOLDER.enabled).toBe(false)
    expect(ORE_PIPELINE_CONTRACT_PLACEHOLDER.pricing.unitPrice).toBeUndefined()
    expect(isOrePipelineUsable(ORE_PIPELINE_CONTRACT_PLACEHOLDER)).toBe(false)
    expect(ORE_PIPELINE_CONTRACT_PLACEHOLDER.stages).toEqual([...ORE_PIPELINE_STAGES])
  })

  it("计价 agreed 且 enabled=true 才可用（未来启用路径的形状约束）", () => {
    const agreed = {
      ...ORE_PIPELINE_CONTRACT_PLACEHOLDER,
      enabled: true,
      pricing: { status: "agreed" as const, unitPrice: 0.5, currency: "CNY", note: "已拍板" },
    }
    expect(isOrePipelineUsable(agreed)).toBe(true)
    // 仅计价 agreed 但仍 disabled → 不可用
    expect(isOrePipelineUsable({ ...agreed, enabled: false })).toBe(false)
  })

  it("契约非法 fail-loud（计价未定却带单价 / 未知字段 / 空阶段）", () => {
    expect(ORE_PIPELINE_CONTRACT_SCHEMA.safeParse({ ...ORE_PIPELINE_CONTRACT_PLACEHOLDER, extra: 1 }).success).toBe(
      false,
    )
    expect(
      ORE_PIPELINE_CONTRACT_SCHEMA.safeParse({ ...ORE_PIPELINE_CONTRACT_PLACEHOLDER, stages: [] }).success,
    ).toBe(false)
    expect(ANN_PLAN_SCHEMA.safeParse({ ...ANN_PLAN_PLACEHOLDER, implemented: true }).success).toBe(false)
    // 非法输入不抛异常，isOrePipelineUsable 降级 false（不误判为可用）
    expect(isOrePipelineUsable({ ...ORE_PIPELINE_CONTRACT_PLACEHOLDER, stages: [] } as never)).toBe(false)
  })
})
