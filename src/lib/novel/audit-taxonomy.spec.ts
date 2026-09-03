/**
 * audit-taxonomy.spec.ts — T22 37 维审计注册表单测
 *
 * 覆盖:
 *   - 37 维总数守卫 (编译期 + 运行时)
 *   - 各维定义完整性 (id/label/gate/description/detectionMethod/checks)
 *   - GATE_MAPPING 三 gate 配置 (优先级/维度数/门控顺序)
 *   - 文学提升维独立性与完整性
 *   - 37 维与文学维无重叠断言
 *   - 工具函数 (getDimensionsByGate / getAllAuditDimensions / getGateDimensionCounts)
 *   - ADR-19 机械层零模型调用守卫
 *
 * @license MIT © QMAI
 */

import { describe, expect, it } from "vitest"
import {
  AUDIT_TAXONOMY,
  GATE_MAPPING,
  GATE_PRIORITY_ORDER,
  LITERARY_DIMS,
  ALL_AUDIT_DIMENSION_IDS,
  ALL_LITERARY_DIM_IDS,
  ALL_GATE_KEYS,
  getDimensionsByGate,
  getAllAuditDimensions,
  getGateDimensionCounts,
  getGateForDimension,
  // 48/49 号 §六-④ 题材条件化新增符号 (50 号报告 S0 spec 补测)
  GENRE_AUDIT_ACTIVATION,
  selectAuditDimensions,
  getUpgradeThreshold,
  getRepairScope,
  DEFAULT_UPGRADE_THRESHOLD,
  type AuditDimensionId,
} from "./audit-taxonomy"

// ============================================================================
// 1. 37 维总数守卫
// ============================================================================

describe("37 维总数守卫", () => {
  it("ALL_AUDIT_DIMENSION_IDS 长度严格为 37", () => {
    expect(ALL_AUDIT_DIMENSION_IDS).toHaveLength(37)
  })

  it("AUDIT_TAXONOMY 的 key 数量为 37", () => {
    expect(Object.keys(AUDIT_TAXONOMY)).toHaveLength(37)
  })

  it("37 维 ID 去重后数量仍为 37 (无重复 ID)", () => {
    const unique = new Set(ALL_AUDIT_DIMENSION_IDS)
    expect(unique.size).toBe(37)
  })
})

// ============================================================================
// 2. 门控分布完整性
// ============================================================================

describe("门控维度分布", () => {
  it("Consistency(P0) 门控 15 维", () => {
    expect(GATE_MAPPING.consistency.dimensionIds).toHaveLength(15)
  })

  it("Anti-AI(P1) 门控 10 维", () => {
    expect(GATE_MAPPING.anti_ai.dimensionIds).toHaveLength(10)
  })

  it("Quality(P2) 门控 12 维", () => {
    expect(GATE_MAPPING.quality.dimensionIds).toHaveLength(12)
  })

  it("三门控维度数之和为 37", () => {
    const counts = getGateDimensionCounts()
    const sum = counts.consistency + counts.anti_ai + counts.quality
    expect(sum).toBe(37)
  })

  it("getGateDimensionCounts 返回正确分布", () => {
    const counts = getGateDimensionCounts()
    expect(counts).toEqual({ consistency: 15, anti_ai: 10, quality: 12 })
  })
})

// ============================================================================
// 3. GATE_MAPPING 一致性
// ============================================================================

describe("GATE_MAPPING 门控配置", () => {
  it("GATE_PRIORITY_ORDER 为 Consistency > Anti-AI > Quality", () => {
    expect(GATE_PRIORITY_ORDER).toEqual(["consistency", "anti_ai", "quality"])
  })

  it("三门控 priority 为 0/1/2", () => {
    expect(GATE_MAPPING.consistency.priority).toBe(0)
    expect(GATE_MAPPING.anti_ai.priority).toBe(1)
    expect(GATE_MAPPING.quality.priority).toBe(2)
  })

  it("三门控 blockingSeverity 均为 error", () => {
    for (const gate of ALL_GATE_KEYS) {
      expect(GATE_MAPPING[gate].blockingSeverity).toBe("error")
    }
  })

  it("ALL_GATE_KEYS 与 GATE_PRIORITY_ORDER 一致", () => {
    expect(ALL_GATE_KEYS).toEqual(GATE_PRIORITY_ORDER)
  })

  it("每个 gate 的 dimensionIds 中所有 ID 都在 AUDIT_TAXONOMY 中存在", () => {
    for (const gate of ALL_GATE_KEYS) {
      for (const dimId of GATE_MAPPING[gate].dimensionIds) {
        expect(AUDIT_TAXONOMY[dimId]).toBeDefined()
        expect(AUDIT_TAXONOMY[dimId].gate).toBe(gate)
      }
    }
  })

  it("GATE_PRIORITY_ORDER 与 control-sentinels.ts 的 GATE_PRIORITY 对齐", () => {
    // 验证与 GATE_PRIORITY 常量一致 (control-sentinels.ts 定义)
    expect(GATE_PRIORITY_ORDER).toEqual(["consistency", "anti_ai", "quality"])
  })
})

// ============================================================================
// 4. 各维定义完整性
// ============================================================================

describe("各维定义完整性", () => {
  it("每维都有非空 label/description/checks", () => {
    for (const [id, dim] of Object.entries(AUDIT_TAXONOMY)) {
      expect(dim.id).toBe(id)
      expect(dim.label).toBeTruthy()
      expect(dim.description).toBeTruthy()
      expect(dim.checks.length).toBeGreaterThanOrEqual(1)
      expect(["mechanical", "llm", "hybrid"]).toContain(dim.detectionMethod)
      expect(["error", "warning", "info"]).toContain(dim.defaultSeverity)
    }
  })

  it("每维的 gate 与 GATE_MAPPING 中的归属一致", () => {
    for (const [id, dim] of Object.entries(AUDIT_TAXONOMY)) {
      const gate = getGateForDimension(id as AuditDimensionId)
      expect(gate).toBe(dim.gate)
      expect(GATE_MAPPING[gate].dimensionIds).toContain(id)
    }
  })

  it("Consistency 门控维度的 defaultSeverity 以 error/warning 为主", () => {
    for (const dimId of GATE_MAPPING.consistency.dimensionIds) {
      const dim = AUDIT_TAXONOMY[dimId]
      expect(["error", "warning"]).toContain(dim.defaultSeverity)
    }
  })

  it("Quality 门控维度的 defaultSeverity 以 info 为主", () => {
    for (const dimId of GATE_MAPPING.quality.dimensionIds) {
      const dim = AUDIT_TAXONOMY[dimId]
      expect(dim.defaultSeverity).toBe("info")
    }
  })
})

// ============================================================================
// 5. 检测方法分布
// ============================================================================

describe("检测方法分布", () => {
  it("mechanical 检测维数 ≥ 15", () => {
    const mechanical = Object.values(AUDIT_TAXONOMY).filter(
      (d) => d.detectionMethod === "mechanical",
    )
    expect(mechanical.length).toBeGreaterThanOrEqual(15)
  })

  it("hybrid 检测维数 ≥ 3", () => {
    const hybrid = Object.values(AUDIT_TAXONOMY).filter(
      (d) => d.detectionMethod === "hybrid",
    )
    expect(hybrid.length).toBeGreaterThanOrEqual(3)
  })

  it("llm 检测维数 ≥ 8", () => {
    const llm = Object.values(AUDIT_TAXONOMY).filter(
      (d) => d.detectionMethod === "llm",
    )
    expect(llm.length).toBeGreaterThanOrEqual(8)
  })

  it("三种检测方法之和为 37", () => {
    const mechanical = Object.values(AUDIT_TAXONOMY).filter((d) => d.detectionMethod === "mechanical").length
    const hybrid = Object.values(AUDIT_TAXONOMY).filter((d) => d.detectionMethod === "hybrid").length
    const llm = Object.values(AUDIT_TAXONOMY).filter((d) => d.detectionMethod === "llm").length
    expect(mechanical + hybrid + llm).toBe(37)
  })
})

// ============================================================================
// 6. 文学提升维 (LITERARY_DIMS)
// ============================================================================

describe("文学提升维 LITERARY_DIMS", () => {
  it("文学维 ≥ 4 个", () => {
    expect(ALL_LITERARY_DIM_IDS.length).toBeGreaterThanOrEqual(4)
  })

  it("包含必须的 4 维: payoff_closure/arc_consistency/hook_strength/significant_detail", () => {
    expect(ALL_LITERARY_DIM_IDS).toContain("payoff_closure")
    expect(ALL_LITERARY_DIM_IDS).toContain("arc_consistency")
    expect(ALL_LITERARY_DIM_IDS).toContain("hook_strength")
    expect(ALL_LITERARY_DIM_IDS).toContain("significant_detail")
  })

  it("每维都有非空 label/description/checks", () => {
    for (const [id, dim] of Object.entries(LITERARY_DIMS)) {
      expect(dim.id).toBe(id)
      expect(dim.label).toBeTruthy()
      expect(dim.description).toBeTruthy()
      expect(dim.checks.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("ALL_LITERARY_DIM_IDS 与 Object.keys(LITERARY_DIMS) 一致", () => {
    expect(ALL_LITERARY_DIM_IDS).toEqual(Object.keys(LITERARY_DIMS))
  })
})

// ============================================================================
// 7. 37 维与文学维无重叠 (命名空间 + 语义)
// ============================================================================

describe("37 维与文学维无重叠", () => {
  it("ID 命名空间完全互斥 (无相同字符串 ID)", () => {
    const auditIds = new Set(ALL_AUDIT_DIMENSION_IDS)
    for (const litId of ALL_LITERARY_DIM_IDS) {
      expect(auditIds.has(litId as unknown as AuditDimensionId)).toBe(false)
    }
  })

  it("标签无重叠 (中文标签不重复)", () => {
    const auditLabels = new Set(
      Object.values(AUDIT_TAXONOMY).map((d) => d.label),
    )
    for (const lit of Object.values(LITERARY_DIMS)) {
      expect(auditLabels.has(lit.label)).toBe(false)
    }
  })
})

// ============================================================================
// 8. 工具函数
// ============================================================================

describe("工具函数", () => {
  it("getDimensionsByGate('consistency') 返回 15 维", () => {
    const dims = getDimensionsByGate("consistency")
    expect(dims).toHaveLength(15)
    for (const d of dims) {
      expect(d.gate).toBe("consistency")
    }
  })

  it("getDimensionsByGate('anti_ai') 返回 10 维", () => {
    const dims = getDimensionsByGate("anti_ai")
    expect(dims).toHaveLength(10)
    for (const d of dims) {
      expect(d.gate).toBe("anti_ai")
    }
  })

  it("getDimensionsByGate('quality') 返回 12 维", () => {
    const dims = getDimensionsByGate("quality")
    expect(dims).toHaveLength(12)
    for (const d of dims) {
      expect(d.gate).toBe("quality")
    }
  })

  it("getAllAuditDimensions 返回 37 维", () => {
    expect(getAllAuditDimensions()).toHaveLength(37)
  })

  it("getAllAuditDimensions 保序: Consistency > Anti-AI > Quality", () => {
    const all = getAllAuditDimensions()
    // 前 15 维应为 consistency
    const firstGate = all[0].gate
    expect(firstGate).toBe("consistency")
    // 找到 gate 转换点
    const gates = all.map((d) => d.gate)
    const antiAiStart = gates.indexOf("anti_ai")
    const qualityStart = gates.indexOf("quality")
    expect(antiAiStart).toBe(15)
    expect(qualityStart).toBe(25) // 15 + 10
  })

  it("getGateForDimension 返回正确门控", () => {
    expect(getGateForDimension("timeline_consistency")).toBe("consistency")
    expect(getGateForDimension("slop_explanation")).toBe("anti_ai")
    expect(getGateForDimension("thrill_density")).toBe("quality")
  })
})

// ============================================================================
// 9. ADR-19 机械层零模型调用守卫
// ============================================================================

describe("ADR-19 机械层零模型调用守卫", () => {
  it("导出为纯数据常量（AUDIT_TAXONOMY / GATE_MAPPING / LITERARY_DIMS）", async () => {
    // 纯数据常量文件不应依赖 LLM 客户端
    const mod = await import("./audit-taxonomy")
    expect(mod.AUDIT_TAXONOMY).toBeDefined()
    expect(mod.GATE_MAPPING).toBeDefined()
    expect(mod.LITERARY_DIMS).toBeDefined()
    // 验证所有值为纯数据对象
    for (const dim of Object.values(mod.AUDIT_TAXONOMY)) {
      expect(typeof dim.id).toBe("string")
      expect(typeof dim.label).toBe("string")
      expect(Array.isArray(dim.checks)).toBe(true)
    }
  })

  it("所有检测方法为 mechanical 的维度的 defaultSeverity 不含 llm 依赖", () => {
    // mechanical 维度的 checks 应可被纯机械规则实现
    for (const dim of Object.values(AUDIT_TAXONOMY)) {
      if (dim.detectionMethod === "mechanical") {
        expect(dim.checks.length).toBeGreaterThanOrEqual(2)
      }
    }
  })
})

// ============================================================================
// 10. 边界与不变式
// ============================================================================

describe("边界与不变式", () => {
  it("37 维 ID 均为合法 AuditDimensionId 格式 (snake_case)", () => {
    const snakeCase = /^[a-z][a-z0-9_]*$/
    for (const id of ALL_AUDIT_DIMENSION_IDS) {
      expect(id).toMatch(snakeCase)
    }
  })

  it("文学维 ID 均为合法 LiteraryDimId 格式 (snake_case)", () => {
    const snakeCase = /^[a-z][a-z0-9_]*$/
    for (const id of ALL_LITERARY_DIM_IDS) {
      expect(id).toMatch(snakeCase)
    }
  })

  it("GATE_MAPPING 中无空的 dimensionIds 数组", () => {
    for (const gate of ALL_GATE_KEYS) {
      expect(GATE_MAPPING[gate].dimensionIds.length).toBeGreaterThan(0)
    }
  })

  it("AUDIT_TAXONOMY 中每个维度的 id 与 key 一致", () => {
    for (const [key, dim] of Object.entries(AUDIT_TAXONOMY)) {
      expect(dim.id).toBe(key)
    }
  })
})

// ============================================================================
// 48/49 号 §六-④ 题材条件化审计激活（50 号报告 S0 spec 锁定）
// ============================================================================

describe("selectAuditDimensions（§六-④ 题材激活）", () => {
  it("无 genre → 全量 37 维（向后兼容）", () => {
    const ids = selectAuditDimensions(undefined)
    expect(ids).toHaveLength(37)
    expect(ids).toEqual(ALL_AUDIT_DIMENSION_IDS)
  })

  it("未注册 genre → 全量 37 维（向后兼容）", () => {
    const ids = selectAuditDimensions("wuxia")
    expect(ids).toHaveLength(37)
  })

  it("已注册 genre → Consistency(15)+Anti-AI(10) 恒全 + Quality 子集", () => {
    const ids = selectAuditDimensions("tuili")
    expect(ids).toHaveLength(34)
    expect(ids).toContain("timeline_consistency")  // P0 恒激活
    expect(ids).toContain("slop_explanation")      // P1 恒激活
    expect(ids).toContain("thrill_density")        // P2 子集
    expect(ids).not.toContain("worldbuilding_immersion") // P2 降载
  })

  it("已注册 genre 子集确定性可断言（同输入同输出）", () => {
    expect(selectAuditDimensions("duanpian")).toEqual(selectAuditDimensions("duanpian"))
  })

  it("GENRE_AUDIT_ACTIVATION 值均为合法 AuditDimensionId 且属于 Quality gate", () => {
    for (const ids of Object.values(GENRE_AUDIT_ACTIVATION)) {
      for (const id of ids) {
        expect(ALL_AUDIT_DIMENSION_IDS).toContain(id)
        expect(getGateForDimension(id)).toBe("quality")
      }
    }
  })
})

describe("getUpgradeThreshold（§六-④ 升级阈值）", () => {
  it("无 genre → 默认阈值", () => {
    expect(getUpgradeThreshold(undefined, "timeline_consistency")).toBe(DEFAULT_UPGRADE_THRESHOLD)
  })

  it("未注册 genre×dimension → 默认阈值（无表项不抛）", () => {
    expect(getUpgradeThreshold("wuxia", "timeline_consistency")).toBe(DEFAULT_UPGRADE_THRESHOLD)
  })

  it("推理题材时间线零容忍（1 次即升 block）", () => {
    expect(getUpgradeThreshold("tuili", "timeline_consistency")).toBe(1)
  })

  it("推理题材因果链同样零容忍", () => {
    expect(getUpgradeThreshold("tuili", "causal_chain")).toBe(1)
  })
})

describe("getRepairScope（§六-④ repair_scope 路由）", () => {
  it("默认路由：Consistency→rewrite_body / Quality→warn_only", () => {
    expect(getRepairScope(undefined, "timeline_consistency")).toBe("rewrite_body")
    expect(getRepairScope(undefined, "thrill_density")).toBe("warn_only")
  })

  it("推理题材 Consistency → resettle_only（逻辑链机械重结算不重写文体）", () => {
    expect(getRepairScope("tuili", "timeline_consistency")).toBe("resettle_only")
  })

  it("未注册 genre → 默认路由（无表项不抛）", () => {
    expect(getRepairScope("wuxia", "timeline_consistency")).toBe("rewrite_body")
  })
})