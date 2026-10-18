/** 提示词注册表：只读枚举（键/场景/参数/占位符预览），失败不造空串。 */
import { describe, expect, it } from "vitest"
import { PROMPTS } from "./prompt-templates"
import { groupPromptRegistry, listPromptRegistry, promptSceneOf } from "./prompt-registry"

describe("listPromptRegistry", () => {
  it("覆盖 PROMPTS 的全部函数键（不遗漏、不多造）", () => {
    const entries = listPromptRegistry()
    const sourceKeys = Object.keys(PROMPTS).sort()
    expect(entries.map((entry) => entry.id)).toEqual(sourceKeys)
  })

  it("预览是占位符骨架：含 «argN» 而不是真实上下文", () => {
    const entries = listPromptRegistry()
    const withArgs = entries.filter((entry) => entry.slotCount > 0 && entry.preview !== null)
    expect(withArgs.length).toBeGreaterThan(0)
    for (const entry of withArgs.slice(0, 5)) {
      expect(entry.preview).toContain("«arg1»")
      expect(entry.preview).not.toContain("undefined")
    }
  })

  it("组内按 id 码点排序（逆序输入也被排正）", () => {
    const mk = (id: string, scene: string) => ({
      id,
      scene,
      declaredParams: 0,
      slotCount: 0,
      slotCountExceedsDeclared: false,
      slotProbeCapped: false,
      preview: "x",
      truncated: false,
      missingSlots: [],
      error: null,
    })
    const groups = groupPromptRegistry([mk("zz", "chapter"), mk("aa", "chapter"), mk("mm", "chapter")])
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(["aa", "mm", "zz"])
    const twoScenes = groupPromptRegistry([mk("b", "zeta"), mk("a", "alpha")])
    expect(twoScenes.map((group) => group.scene)).toEqual(["alpha", "zeta"])
  })

  it("场景分组稳定且全覆盖（组间码点序）", () => {
    const groups = groupPromptRegistry(listPromptRegistry())
    const scenes = groups.map((group) => group.scene)
    expect(scenes).toEqual([...scenes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    const total = groups.reduce((sum, group) => sum + group.entries.length, 0)
    expect(total).toBe(listPromptRegistry().length)
    expect(scenes).toContain("chapter")
  })

  it("promptSceneOf：驼峰首段；无前缀 → misc", () => {
    expect(promptSceneOf("chapterGeneration")).toBe("chapter")
    expect(promptSceneOf("deepChapterOutline")).toBe("deep")
    expect(promptSceneOf("standalone")).toBe("misc")
  })

  it("注入源：默认参数槽位被探测到（Function.length 低估时也不撒谎）", () => {
    const source = {
      sampleWithDefault: (a: unknown, b: unknown, c: unknown, d = "") => [a, b, c, d].join("|"),
    } as unknown as Record<string, (...args: unknown[]) => unknown>
    const [entry] = listPromptRegistry(source)
    expect(entry?.declaredParams).toBe(3)
    expect(entry?.slotCount).toBe(4)
    expect(entry?.slotCountExceedsDeclared).toBe(true)
    expect(entry?.preview).toContain("«arg4»")
  })

  it("注入源：抛错 → preview null + error；空输出 → error（都不静默给空串）", () => {
    const source = {
      throwsHard: () => {
        throw new Error("needs real context pack")
      },
      returnsEmpty: () => "",
    } as unknown as Record<string, (...args: unknown[]) => unknown>
    const entries = listPromptRegistry(source)
    const throwing = entries.find((entry) => entry.id === "throwsHard")
    expect(throwing?.preview).toBeNull()
    expect(throwing?.error).toContain("needs real context pack")
    const empty = entries.find((entry) => entry.id === "returnsEmpty")
    expect(empty?.preview).toBeNull()
    expect(empty?.error).toBeTruthy()
  })

  it("注入源：键按码点排序，非函数值被跳过", () => {
    const source = {
      bKey: () => "b",
      aKey: () => "a",
      notAFunction: 42,
    } as unknown as Record<string, (...args: unknown[]) => unknown>
    expect(listPromptRegistry(source).map((entry) => entry.id)).toEqual(["aKey", "bKey"])
  })
})
