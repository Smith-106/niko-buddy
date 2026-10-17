/**
 * naming-canonical-map.spec.ts — 命名唯一映射真源的一致性守卫
 *
 * 目的（ADR-50）：保证新增的 canonical map 与既有模块的本地常量**逐项一致**，
 * 既有的多轨写法因此被「钉住」，不会出现第三套漂移写法。
 */
import { describe, expect, it } from "vitest"
import {
  ARC_STEP_CANONICAL,
  ENTITY_DIR_CANONICAL,
  ENTITY_DIRS_CANONICAL,
  ENTITY_DIR_ROLES,
  KERNEL_STEP_TO_ARC,
  entityDirRole,
  isCanonicalEntityDir,
  toArcSettlementStep,
  toKernelArcStep,
} from "./naming-canonical-map"
import { ARBITRATION_TO_KERNEL_STEP } from "./cruise-wiring"
import { ARC_SETTLEMENT_ORDER } from "./arc-settlement"

describe("naming-canonical-map", () => {
  it("arc step 映射与 cruise-wiring 的 ARBITRATION_TO_KERNEL_STEP 逐项一致", () => {
    expect(ARC_STEP_CANONICAL).toEqual(ARBITRATION_TO_KERNEL_STEP)
  })

  it("arc step 映射覆盖 ARC_SETTLEMENT_ORDER 全部步骤", () => {
    for (const step of ARC_SETTLEMENT_ORDER) {
      expect(ARC_STEP_CANONICAL[step]).toBeTruthy()
      expect(toArcSettlementStep(toKernelArcStep(step))).toBe(step)
    }
  })

  it("反向映射与正向映射互逆", () => {
    for (const [arcStep, kernelStep] of Object.entries(ARC_STEP_CANONICAL)) {
      expect(KERNEL_STEP_TO_ARC[kernelStep]).toBe(arcStep)
    }
  })

  it("实体目录三轨与 local-entity-names 的 ENTITY_DIRS 一致（首项为规范轨）", () => {
    expect(ENTITY_DIRS_CANONICAL).toEqual(["wiki/entities", "wiki/characters", "wiki/concepts"])
    expect(ENTITY_DIRS_CANONICAL[0]).toBe(ENTITY_DIR_CANONICAL)
  })

  it("实体目录角色解析支持三轨并拒绝未知目录", () => {
    expect(entityDirRole("wiki/entities")).toBe("entities")
    expect(entityDirRole("wiki/characters/")).toBe("characters")
    expect(entityDirRole("wiki\\concepts")).toBe("concepts")
    expect(entityDirRole("wiki/other")).toBeNull()
    expect(isCanonicalEntityDir("wiki/entities")).toBe(true)
    expect(isCanonicalEntityDir("wiki/other")).toBe(false)
  })

  it("角色表 key 集合等于目录清单", () => {
    expect(Object.keys(ENTITY_DIR_ROLES).sort()).toEqual([...ENTITY_DIRS_CANONICAL].sort())
  })
})
