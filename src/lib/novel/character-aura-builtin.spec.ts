import { describe, expect, it } from "vitest"
import { BUILT_IN_CHARACTER_AURAS } from "./character-aura-builtin"

describe("BUILT_IN_CHARACTER_AURAS", () => {
  it("loads every built-in aura with the full field contract", () => {
    expect(BUILT_IN_CHARACTER_AURAS.length).toBeGreaterThan(40)
    for (const aura of BUILT_IN_CHARACTER_AURAS) {
      expect(aura.id).toMatch(/^builtin-/)
      expect(aura.builtIn).toBe(true)
      expect(aura.name.length).toBeGreaterThan(0)
      expect(aura.category).toBeTruthy()
      expect(aura.sourceNote).toContain("系统内置人物灵魂")
      expect(aura.corpus.length).toBeGreaterThan(0)
      expect(aura.styleDescription.length).toBeGreaterThan(0)
      expect(aura.behaviorRules).toContain(aura.mentalModel)
      expect(aura.behaviorRules).toContain(aura.decisionHeuristics)
      expect(aura.boundaries).toContain("诚实边界")
      expect(aura.notes).toBe(aura.valueAntiPatterns)
      expect(aura.expressionDna).toBe(aura.styleDescription)
      expect(aura.honestyBoundaries).toContain("服从大纲")
      expect(aura.skillFolder).toMatch(/^skills\/soulskill\/.+?-perspective$/)
    }
  })

  it("uses the special slug for 张雪峰 and strips the builtin- prefix elsewhere", () => {
    const zhangXuefeng = BUILT_IN_CHARACTER_AURAS.find((a) => a.id === "builtin-zhang-xuefeng")
    expect(zhangXuefeng?.skillFolder).toBe("skills/soulskill/zhangxuefeng-perspective")

    const liBai = BUILT_IN_CHARACTER_AURAS.find((a) => a.id === "builtin-li-bai")
    expect(liBai?.skillFolder).toBe("skills/soulskill/li-bai-perspective")
  })

  it("includes the female-role expansion batch (第五批)", () => {
    const names = BUILT_IN_CHARACTER_AURAS.map((a) => a.name)
    for (const name of ["李清照", "林黛玉", "居里夫人", "黄蓉", "花木兰", "简·奥斯汀", "叶卡捷琳娜大帝"]) {
      expect(names).toContain(name)
    }
  })
})
