/**
 * anti-ai-llm-pack.spec.ts — T24 反 AI LLM 投影规则包单测
 *
 * 蓝图 §6 T24 (TASK-P3-24) 收敛面:
 *   - 包结构: id / 单投影规则 / anti_ai 门 / combinePacks 校验通过;
 *   - 类型→维度映射表: 显式映射 + 未知 type 跨维通用（undefined）;
 *   - severity/message 透传; ADR-19 边界（零模型调用——本包为纯投影层,
 *     源码 token 守卫断言无 streamChat/invoke 引用）。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createAntiAiLlmPack,
  ANTI_AI_LLM_PACK_ID,
  ANTI_AI_LLM_TYPE_TO_DIM,
} from "./anti-ai-llm-pack"
import { combinePacks, runRuleStack, RuleStackIntegrityError } from "../rule-stack"

const PACK_SOURCE = readFileSync(resolve(__dirname, "anti-ai-llm-pack.ts"), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "") // 剥离块注释（文档提及 token 不算调用面）
  .replace(/^\s*\/\/.*$/gm, "") // 剥离行注释

describe("anti-ai-llm-pack 包结构", () => {
  it("包 id 固定 + 单投影规则属 anti_ai 门", () => {
    const pack = createAntiAiLlmPack({ findings: [] })
    expect(pack.id).toBe(ANTI_AI_LLM_PACK_ID)
    expect(pack.rules.map((r) => r.id)).toEqual(["anti-ai-llm.projection"])
    for (const rule of pack.rules) {
      expect(rule.gate).toBe("anti_ai")
    }
    expect(() => combinePacks([pack])).not.toThrow()
  })
})

describe("类型 → T22 维度投影", () => {
  it("显式映射: anti_ai/slop→slop_mechanical, de_ai→de_ai_residual, translationese/generic_description 同名维", () => {
    const pack = createAntiAiLlmPack({
      findings: [
        { severity: "warning", type: "slop", message: "机械句式偏多" },
        { severity: "error", type: "de_ai", message: "1A 档残留" },
        { severity: "info", type: "translationese", message: "欧化句式" },
        { severity: "info", type: "generic_description", message: "泛化描写" },
      ],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    const byDim = new Map(result.allFindings.map((f) => [f.dimensionId, f.severity]))
    expect(byDim.get("slop_mechanical")).toBe("warning")
    expect(byDim.get("de_ai_residual")).toBe("error")
    expect(byDim.get("translationese")).toBe("info")
    expect(byDim.get("generic_description")).toBe("info")
  })

  it("未知 type 与 style → 跨维通用 (dimensionId undefined)，不强行归维", () => {
    const pack = createAntiAiLlmPack({
      findings: [
        { severity: "warning", type: "style", message: "文风漂移" },
        { severity: "warning", type: "unknown_type", message: "未知分类" },
      ],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.allFindings).toHaveLength(2)
    for (const f of result.allFindings) {
      expect(f.dimensionId).toBeUndefined()
      expect(f.message).toMatch(/^\[llm:/)
    }
  })

  it("error 级 LLM finding 使 anti_ai 门 fail 并触发 P1 短路", () => {
    const pack = createAntiAiLlmPack({
      findings: [{ severity: "error", type: "de_ai", message: "高权重残留" }],
    })
    const result = runRuleStack(combinePacks([pack]), { isFinale: false })
    expect(result.verdicts.anti_ai).toBe("fail")
    expect(result.shortCircuitGate).toBe("anti_ai")
  })

  it("空 findings → 空产出", () => {
    const result = runRuleStack(combinePacks([createAntiAiLlmPack({ findings: [] })]), { isFinale: false })
    expect(result.allFindings).toEqual([])
  })

  it("非法 severity 经运行器盖章校验拒绝（RuleStackIntegrityError）", () => {
    const pack = createAntiAiLlmPack({
      // 故意注入非法 severity（绕过类型的运行期对抗样本）
      findings: [{ severity: "fatal" as never, type: "slop", message: "坏数据" }],
    })
    expect(() => runRuleStack(combinePacks([pack]), { isFinale: false })).toThrow(RuleStackIntegrityError)
  })
})

describe("ADR-19 边界守卫（源码 token 断言）", () => {
  it("本包源码零模型调用面：无 streamChat / invoke / fetch / IO import", () => {
    expect(PACK_SOURCE).not.toMatch(/streamChat/)
    expect(PACK_SOURCE).not.toMatch(/invoke\s*\(/)
    expect(PACK_SOURCE).not.toMatch(/\bfetch\s*\(/)
    expect(PACK_SOURCE).not.toMatch(/node:fs/)
    expect(PACK_SOURCE).not.toMatch(/useWikiStore/)
  })

  it("映射表 style 显式为 undefined（文风不越门归 anti_ai 37 维槽位）", () => {
    expect(ANTI_AI_LLM_TYPE_TO_DIM["style"]).toBeUndefined()
    expect(Object.keys(ANTI_AI_LLM_TYPE_TO_DIM)).toContain("style")
  })
})
