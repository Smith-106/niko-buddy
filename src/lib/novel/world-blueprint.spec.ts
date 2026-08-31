import { describe, expect, it } from "vitest"
import {
  createEmptyWorldBlueprint,
  REQUIRED_WORLD_LAYERS,
  validateWorldBlueprint,
  worldBlueprintToPromptFragment,
  WORLD_LAYERS,
  type WorldBlueprint,
} from "./world-blueprint"

function completeBlueprint(): WorldBlueprint {
  return {
    version: "1.0",
    worldType: "东方玄幻",
    layers: {
      axioms: ["灵气即资源", "境界决定话语权"],
      background: ["三千年前天倾之战后"],
      geography: ["九州大陆", "北境冰原"],
      cultures: ["中原儒家礼法", "草原部落武统"],
      conflicts: ["正魔两道千年积怨"],
      magicSystem: ["炼气→筑基→金丹"],
      races: ["人族", "妖族"],
    },
    crossRefs: [{ from: "magicSystem", to: "races", term: "人族" }],
  }
}

describe("world-blueprint（吸收自 ANWA services/world 分层结构模式）", () => {
  it("13 层常量与必填层声明", () => {
    expect(WORLD_LAYERS).toHaveLength(13)
    expect(REQUIRED_WORLD_LAYERS).toEqual(["axioms", "background", "geography", "cultures", "conflicts"])
  })

  it("完备蓝图 → complete 无 error", () => {
    const result = validateWorldBlueprint(completeBlueprint())
    expect(result.verdict).toBe("complete")
    expect(result.findings).toEqual([])
  })

  it("缺必填层 → error → incomplete（逐层报缺失）", () => {
    const bp = createEmptyWorldBlueprint("东方玄幻")
    const result = validateWorldBlueprint(bp)
    expect(result.verdict).toBe("incomplete")
    expect(result.findings).toHaveLength(REQUIRED_WORLD_LAYERS.length)
    expect(result.findings.every((f) => f.code === "missing_layer" && f.severity === "error")).toBe(true)
  })

  it("可选层为空合法（稀疏骨架不报错）", () => {
    const bp = completeBlueprint()
    const result = validateWorldBlueprint(bp)
    expect(result.findings.filter((f) => f.layer === "technology")).toHaveLength(0)
  })

  it("悬空交叉引用 → warn 不构成 incomplete", () => {
    const bp = completeBlueprint()
    bp.crossRefs = [{ from: "magicSystem", to: "races", term: "龙族" }]
    const result = validateWorldBlueprint(bp)
    expect(result.findings[0].code).toBe("dangling_cross_ref")
    expect(result.findings[0].severity).toBe("warn")
    expect(result.verdict).toBe("complete")
  })

  it("worldBlueprintToPromptFragment 渲染非空层且层序确定；空蓝图返回空串", () => {
    const frag = worldBlueprintToPromptFragment(completeBlueprint())
    expect(frag).toContain("# 世界观骨架（东方玄幻）")
    expect(frag.indexOf("### axioms")).toBeLessThan(frag.indexOf("### conflicts"))
    expect(worldBlueprintToPromptFragment(createEmptyWorldBlueprint("x"))).toBe("")
  })

  it("确定性：同输入双跑全等", () => {
    expect(JSON.stringify(validateWorldBlueprint(completeBlueprint()))).toBe(
      JSON.stringify(validateWorldBlueprint(completeBlueprint())),
    )
  })
})
