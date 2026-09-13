import { describe, expect, it } from "vitest"
import type { TaskPromptKey } from "@/stores/wiki-store"
import {
  applyTaskSkillOverride,
  isTaskPromptKey,
  resolveTaskExtraPrompt,
  resolveTaskSkillNames,
} from "./task-customization"

function cfg(partial: {
  taskPrompts?: Partial<Record<TaskPromptKey, { extra?: string }>>
  taskSkillNames?: Partial<Record<TaskPromptKey, string[]>>
}): { taskPrompts: Record<TaskPromptKey, { extra?: string }>; taskSkillNames: Record<TaskPromptKey, string[]> } {
  return {
    taskPrompts: { writing: {}, outline: {}, review: {}, summary: {}, extract: {}, ...partial.taskPrompts },
    taskSkillNames: { writing: [], outline: [], review: [], summary: [], extract: [], ...partial.taskSkillNames },
  }
}

describe("resolveTaskExtraPrompt", () => {
  it("empty config returns empty string (等价直通)", () => {
    expect(resolveTaskExtraPrompt(cfg({}), "writing")).toBe("")
  })

  it("trims and returns the extra prompt", () => {
    expect(resolveTaskExtraPrompt(cfg({ taskPrompts: { writing: { extra: "  多写对白  " } } }), "writing")).toBe("多写对白")
  })

  it("whitespace-only extra collapses to empty", () => {
    expect(resolveTaskExtraPrompt(cfg({ taskPrompts: { review: { extra: "   " } } }), "review")).toBe("")
  })
})

describe("resolveTaskSkillNames", () => {
  it("empty config returns empty array", () => {
    expect(resolveTaskSkillNames(cfg({}), "outline")).toEqual([])
  })

  it("trims, drops blanks, dedupes preserving order", () => {
    const names = resolveTaskSkillNames(
      cfg({ taskSkillNames: { outline: [" 章节承接 ", "", "冲突升级", "章节承接"] } }),
      "outline",
    )
    expect(names).toEqual(["章节承接", "冲突升级"])
  })
})

describe("applyTaskSkillOverride", () => {
  const pool = new Set(["章节承接", "冲突升级", "人物动机"])

  it("user empty → defaults as-is, not applied (等价直通)", () => {
    const out = applyTaskSkillOverride(["默认A"], [], pool)
    expect(out).toEqual({ names: ["默认A"], missing: [], applied: false })
  })

  it("user names present in pool → replace defaults", () => {
    const out = applyTaskSkillOverride(["默认A", "默认B"], ["冲突升级", "人物动机"], pool)
    expect(out).toEqual({ names: ["冲突升级", "人物动机"], missing: [], applied: true })
  })

  it("partial presence keeps only existing, reports missing", () => {
    const out = applyTaskSkillOverride(["默认A"], ["人物动机", "不存在的技能"], pool)
    expect(out.names).toEqual(["人物动机"])
    expect(out.missing).toEqual(["不存在的技能"])
    expect(out.applied).toBe(true)
  })

  it("all missing → falls back to defaults, not applied", () => {
    const out = applyTaskSkillOverride(["默认A"], ["不存在X", "不存在Y"], pool)
    expect(out).toEqual({ names: ["默认A"], missing: ["不存在X", "不存在Y"], applied: false })
  })
})

describe("isTaskPromptKey", () => {
  it("guards valid keys", () => {
    expect(isTaskPromptKey("writing")).toBe(true)
    expect(isTaskPromptKey("outline")).toBe(true)
    expect(isTaskPromptKey("review")).toBe(true)
    expect(isTaskPromptKey("summary")).toBe(true)
    expect(isTaskPromptKey("extract")).toBe(true)
    expect(isTaskPromptKey("query")).toBe(false)
    expect(isTaskPromptKey("")).toBe(false)
  })
})
