import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  entityBareName,
  mechanicalVerdict,
  filterExtractedRelations,
  type ExtractedRelation,
} from "./canon-precision-filter"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

const rel = (partial: Partial<ExtractedRelation>): ExtractedRelation => ({
  source: "角色甲",
  target: "角色乙",
  relation: "敌对",
  ...partial,
})

describe("A7 图谱抽取精度过滤 (canon-precision-filter)", () => {
  it("uses zero LLM calls (机械层硬验证: 无 llm-client import / 无 streamChat / 无 invoke)", () => {
    const src = readSource("canon-precision-filter.ts")
    expect(src).not.toMatch(/from\s+["']@\/lib\/llm-client["']/)
    expect(src).not.toMatch(/\bawait\s+streamChat\b/)
    expect(src).not.toMatch(/\bawait\s+invoke\b/)
    // 模块自身不得直接引用 LLM 客户端 —— LLM 只经调用方注入的 verify 进入。
    expect(src).not.toMatch(/llm-client/)
  })

  describe("entityBareName (类型前缀清洗)", () => {
    it("strips type prefix 类型前缀", () => {
      expect(entityBareName("character:菜月昴")).toBe("菜月昴")
      expect(entityBareName("location:王都")).toBe("王都")
    })
    it("keeps bare name without prefix 无前缀原样返回", () => {
      expect(entityBareName("菜月昴")).toBe("菜月昴")
    })
    it("trims surrounding whitespace 去除首尾空白", () => {
      expect(entityBareName("  角色甲  ")).toBe("角色甲")
    })
  })

  describe("mechanicalVerdict 各拒绝原因", () => {
    const opts = { maxEntityLength: 60, maxRelationLength: 40, requireSourcePresence: true }
    const text = "角色甲在森林遇见了角色乙，两人互为敌对关系。"

    it("passes when entities present + no defect (返回 null = 通过)", () => {
      expect(mechanicalVerdict(rel({}), text, opts)).toBeNull()
    })

    it("rejects empty_source 空来源", () => {
      expect(mechanicalVerdict(rel({ source: "  " }), text, opts)).toBe("empty_source")
    })
    it("rejects empty_target 空目标", () => {
      expect(mechanicalVerdict(rel({ target: "" }), text, opts)).toBe("empty_target")
    })
    it("rejects empty_relation 空关系", () => {
      expect(mechanicalVerdict(rel({ relation: " \t" }), text, opts)).toBe("empty_relation")
    })

    it("rejects self_loop 自环 (source === target)", () => {
      expect(mechanicalVerdict(rel({ target: "角色甲" }), text, opts)).toBe("self_loop")
    })
    it("rejects self_loop across type prefixes 跨前缀自环", () => {
      expect(
        mechanicalVerdict(rel({ source: "character:角色甲", target: "角色甲" }), text, opts),
      ).toBe("self_loop")
    })

    it("rejects oversized_source 超长来源", () => {
      expect(
        mechanicalVerdict(rel({ source: "很".repeat(61) }), text, opts),
      ).toBe("oversized_source")
    })
    it("rejects oversized_target 超长目标", () => {
      expect(
        mechanicalVerdict(rel({ target: "很".repeat(61) }), text, opts),
      ).toBe("oversized_target")
    })
    it("rejects oversized_relation 超长关系", () => {
      expect(
        mechanicalVerdict(rel({ relation: "很".repeat(41) }), text, opts),
      ).toBe("oversized_relation")
    })

    it("rejects source_not_in_text 来源实体名未在源文出现", () => {
      expect(
        mechanicalVerdict(rel({ source: "不存在的角色" }), text, opts),
      ).toBe("source_not_in_text")
    })
    it("rejects target_not_in_text 目标实体名未在源文出现", () => {
      expect(
        mechanicalVerdict(rel({ target: "不存在的地点" }), text, opts),
      ).toBe("target_not_in_text")
    })
    it("matches prefixed entity against bare name in source text (带前缀实体名按裸名匹配)", () => {
      expect(
        mechanicalVerdict(rel({ source: "character:角色甲" }), text, opts),
      ).toBeNull()
    })
    it("skips source-presence check when requireSourcePresence=false", () => {
      const lax = { ...opts, requireSourcePresence: false }
      expect(mechanicalVerdict(rel({ source: "幽灵名" }), text, lax)).toBeNull()
    })
  })

  describe("filterExtractedRelations: degraded (未注入 verify)", () => {
    it("returns degraded:true and keeps mechanical survivors, rejects defective", async () => {
      const text = "角色甲在王都遇见了角色乙，两人敌对；还提到了某物。"

      const res = await filterExtractedRelations(
        [
          rel({ source: "角色甲", target: "角色乙", relation: "敌对" }),
          rel({ source: "不存在的角色", target: "角色乙", relation: "认识" }), // source_not_in_text
          rel({ source: "角色甲", target: "角色甲", relation: "认识" }),          // self_loop
        ],
        text,
      )

      expect(res.degraded).toBe(true)
      expect(res.kept).toHaveLength(1)
      expect(res.kept[0]?.source).toBe("角色甲")
      expect(res.rejected.map((r) => r.reason)).toEqual([
        "source_not_in_text",
        "self_loop",
      ])
    })
  })

  describe("filterExtractedRelations: 注入 verify LLM 批量核验", () => {
    it("runs verify over mechanical survivors; accepted kept, rejected marked verify_rejected", async () => {
      const text = "角色甲与角色乙敌对，角色丙在场，谁都不认识角色丁。"
      const verify = async (
        batch: readonly ExtractedRelation[],
      ): Promise<Array<{ accepted: boolean; detail?: string }>> => {
        expect(batch).toHaveLength(3) // 机械层三杀均通过（实体均在 text 中）
        return batch.map((r) => ({ accepted: r.source !== "角色丙", detail: "认知轴无法佐证" }))
      }

      const relations: ExtractedRelation[] = [
        rel({ source: "角色甲", target: "角色乙", relation: "敌对" }),
        rel({ source: "角色丙", target: "角色乙", relation: "合作" }),
        rel({ source: "角色丁", target: "角色乙", relation: "认识" }),
      ]

      const res = await filterExtractedRelations(relations, text, { verify })

      expect(res.degraded).toBe(false)
      // kept: 甲→乙 / 丁→乙（accepted=true）；丙→乙 被核验层拒
      expect(res.kept.map((r) => r.source).sort()).toEqual(["角色丁", "角色甲"])
      const tryRejected = res.rejected.filter((r) => r.reason === "verify_rejected")
      expect(tryRejected.map((r) => r.relation.source)).toEqual(["角色丙"])
      expect(tryRejected[0]?.detail).toBe("认知轴无法佐证")
    })

    it("verify throwing degrades all mechanical survivors to rejected (verify-threw)", async () => {
      const verify = async () => {
        throw new Error("llm 超时")
      }
      const res = await filterExtractedRelations(
        [rel({})], // 机械层通过
        "角色甲在角色乙面前敌对。",
        { verify },
      )
      expect(res.degraded).toBe(false)
      expect(res.kept).toHaveLength(0)
      expect(res.rejected[0]?.reason).toBe("verify_rejected")
      expect(res.rejected[0]?.detail).toBe("verify-threw")
    })
  })

  describe("filterExtractedRelations: 边界/组合", () => {
    it("empty input returns empty kept/rejected, degraded (no verify)", async () => {
      const res = await filterExtractedRelations([], "任意文本")
      expect(res.kept).toHaveLength(0)
      expect(res.rejected).toHaveLength(0)
      expect(res.degraded).toBe(true)
    })

    it("empty sourceText + requireSourcePresence=false keeps entities", async () => {
      const res = await filterExtractedRelations(
        [rel({ source: "角色甲", target: "角色乙", relation: "敌对" })],
        "",
        { requireSourcePresence: false },
      )
      expect(res.kept).toHaveLength(1)
    })

    it("custom length thresholds respected", async () => {
      const res = await filterExtractedRelations(
        [rel({ source: "甲乙", relation: "太长关系标签".repeat(4) })],
        "角色甲角色乙出现",
        { maxEntityLength: 5, maxRelationLength: 10 },
      )
      expect(res.rejected.map((r) => r.reason)).toContain("oversized_relation")
    })

    it("verify result length mismatch tolerated (missing verdicts dropped)", async () => {
      const verify = async () => [{ accepted: true }] // 只给 1 个结论，curly 2 个
      const res = await filterExtractedRelations(
        [rel({}), rel({ source: "角色甲", target: "角色乙", relation: "合作" })],
        "角色甲角色乙",
        { verify },
      )
      // 仅第 1 条 accepted；第 2 条缺结论 => verify_rejected
      expect(res.kept).toHaveLength(1)
      expect(res.rejected.filter((r) => r.reason === "verify_rejected")).toHaveLength(1)
    })
  })
})